"""
High-resolution New England coastline from the NOAA Coastal Relief Model (3 arc-second ≈ 90 m), for
strict land-mask clipping and the 100 m nearshore ribbon.

    python -m nesurf.coastline                 # -> public/data/coast-land.geojson, public/data/coast-ribbon.geojson

Method
  1. Pull CRM z over the bbox in latitude stripes via OPeNDAP (verified endpoint, see bathy.py). z >= 0 or NaN = land.
  2. Polygonise the land raster (rasterio.features.shapes), simplify to ~45 m, drop specks < 0.02 km².
  3. Walk every polygon ring and cut it into 100 m segments. For each segment: midpoint, the normal that points
     toward WATER (checked against the raster), and an exposure score = fraction of 13 rays (±60° around the
     normal, 3 km long) that stay over water. Segments with exposure < 0.35 are estuary/inner-harbour shoreline
     and are left out of the ribbon (they stay in the land mask).

GeoJSON structure
  coast-land.geojson    FeatureCollection<Polygon>, properties {a: area_km2}            (land mask; drawn above the ocean layers)
  coast-ribbon.geojson  FeatureCollection<LineString>, feature.id = segment index, properties
                        {n: normal_deg (bearing land→sea), e: exposure 0..1, m: [lon, lat] midpoint}
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time

import numpy as np
import xarray as xr
from rasterio import features
from scipy import ndimage
from rasterio.transform import from_origin
from shapely.geometry import LineString, shape
from shapely.ops import unary_union

from .common import NE_BBOX, REPO_ROOT

CRM_URL = "https://www.ngdc.noaa.gov/thredds/dodsC/crm/crm_vol1.nc"
OUT = REPO_ROOT / "public" / "data"


def fetch_land(stride: int, open_radius: int = 5) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    ds = xr.open_dataset(CRM_URL)
    b = NE_BBOX
    x = ds["x"].sel(x=slice(b.west, b.east)).values[::stride]
    ys = ds["y"].sel(y=slice(b.south, b.north)).values[::stride]
    rows = []
    t = time.time()
    step = 600  # rows per request (post-stride)
    for i in range(0, len(ys), step):
        y0, y1 = ys[i], ys[min(i + step, len(ys)) - 1]
        z = ds["z"].sel(x=slice(b.west, b.east), y=slice(y0, y1)).isel(x=slice(0, None, stride), y=slice(0, None, stride)).values
        rows.append(z)
        print(f"  fetched rows {i}-{i + z.shape[0]} of {len(ys)} ({time.time() - t:.0f}s)", flush=True)
    z = np.vstack(rows)[: len(ys), : len(x)]
    water = np.isfinite(z) & (z < 0)
    # open water only: a morphological opening (r ≈ 5 cells ≈ 450 m) removes tidal rivers, marsh channels and ponds
    # narrower than ~1 km; one dilation restores the shoreline detail the opening shaved off bays and headlands.
    if open_radius > 0:
        yy, xx = np.ogrid[-open_radius:open_radius + 1, -open_radius:open_radius + 1]
        disk = (xx * xx + yy * yy) <= open_radius * open_radius
        opened = ndimage.binary_opening(water, structure=disk)
        water = ndimage.binary_dilation(opened, structure=np.ones((3, 3), bool)) & water
    land = ~water
    return land, ys, x


def polygons(land: np.ndarray, ys: np.ndarray, xs: np.ndarray, min_km2: float, simplify_deg: float):
    res = float(xs[1] - xs[0])
    # rasterio expects row 0 = north
    arr = land[::-1].astype(np.uint8)
    transform = from_origin(float(xs[0]) - res / 2, float(ys[-1]) + res / 2, res, res)
    out = []
    for geom, val in features.shapes(arr, mask=arr == 1, transform=transform, connectivity=8):
        g = shape(geom)
        if g.is_empty:
            continue
        lat = g.centroid.y
        km2 = g.area * 111.32 * 111.32 * math.cos(math.radians(lat))
        if km2 < min_km2:
            continue
        g = g.simplify(simplify_deg, preserve_topology=True).buffer(0)
        if g.is_empty:
            continue
        geoms = list(g.geoms) if g.geom_type == "MultiPolygon" else [g]
        for p in geoms:
            out.append((p, km2))
    return out


def ribbon(polys, land: np.ndarray, ys: np.ndarray, xs: np.ndarray, seg_m: float, min_exposure: float):
    res = float(xs[1] - xs[0]); lat0 = float(ys[0]); lon0 = float(xs[0]); nlat, nlon = land.shape

    def is_land(lat: float, lon: float) -> bool:
        i = int(round((lat - lat0) / res)); j = int(round((lon - lon0) / res))
        if i < 0 or j < 0 or i >= nlat or j >= nlon:
            return True
        return bool(land[i, j])

    feats = []
    sid = 0
    for poly, km2 in polys:
        if km2 < 0.5:
            continue  # tiny islands: masked, but no ribbon
        for ring in [poly.exterior, *poly.interiors]:
            coords = list(ring.coords)
            # densify by walking and emitting a vertex every seg_m metres
            acc = 0.0
            pts = [coords[0]]
            for (x0, y0), (x1, y1) in zip(coords[:-1], coords[1:]):
                kx = 111320 * math.cos(math.radians((y0 + y1) / 2)); ky = 110540
                dx = (x1 - x0) * kx; dy = (y1 - y0) * ky; L = math.hypot(dx, dy)
                if L == 0:
                    continue
                pos = 0.0
                while acc + (L - pos) >= seg_m:
                    adv = seg_m - acc; pos += adv; acc = 0.0
                    pts.append((x0 + dx * (pos / L) / kx, y0 + dy * (pos / L) / ky))
                acc += L - pos
            for (x0, y0), (x1, y1) in zip(pts[:-1], pts[1:]):
                mx, my = (x0 + x1) / 2, (y0 + y1) / 2
                kx = 111320 * math.cos(math.radians(my)); ky = 110540
                dx = (x1 - x0) * kx; dy = (y1 - y0) * ky; L = math.hypot(dx, dy)
                if L < seg_m * 0.3:
                    continue
                # two candidate normals; pick the one whose 60 m probe is water
                nxa, nya = dy / L, -dx / L
                cand = [(nxa, nya), (-nxa, -nya)]
                normal = None
                for nx, ny in cand:
                    if not is_land(my + ny * 60 / ky, mx + nx * 60 / kx):
                        normal = (nx, ny); break
                if normal is None:
                    continue
                bearing = (math.degrees(math.atan2(normal[0], normal[1])) + 360) % 360
                # exposure: rays ±60° around the normal, 3 km, sampled every 250 m
                water = 0; rays = 13
                for k in range(rays):
                    a = math.radians(bearing - 60 + 120 * k / (rays - 1)); ok = True
                    for d in range(250, 3001, 250):
                        if is_land(my + math.cos(a) * d / ky, mx + math.sin(a) * d / kx):
                            ok = False; break
                    water += ok
                e = water / rays
                if e < min_exposure:
                    continue
                feats.append({"type": "Feature", "id": sid, "geometry": {"type": "LineString", "coordinates": [[round(x0, 5), round(y0, 5)], [round(x1, 5), round(y1, 5)]]},
                              "properties": {"n": int(round(bearing)), "e": round(e, 2), "m": [round(mx, 5), round(my, 5)]}})
                sid += 1
    return feats


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--stride", type=int, default=1, help="CRM cell stride (1 = 3 arc-second ≈ 90 m)")
    ap.add_argument("--seg-m", type=float, default=100.0)
    ap.add_argument("--min-km2", type=float, default=0.02)
    ap.add_argument("--simplify-m", type=float, default=45.0)
    ap.add_argument("--min-exposure", type=float, default=0.35)
    ap.add_argument("--open-radius", type=int, default=5, help="cells; water channels narrower than ~2r become land (0 = off)")
    a = ap.parse_args(argv)
    OUT.mkdir(parents=True, exist_ok=True)
    print("fetching CRM…", flush=True)
    land, ys, xs = fetch_land(a.stride, a.open_radius)
    print(f"grid {land.shape}, land fraction {land.mean():.2f}", flush=True)
    polys = polygons(land, ys, xs, a.min_km2, a.simplify_m / 111320)
    print(f"{len(polys)} land polygons", flush=True)
    land_fc = {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {"a": round(km2, 3)}, "geometry": json.loads(json.dumps(p.__geo_interface__))} for p, km2 in polys]}
    # round coordinates to 5 dp (~1 m)
    def rnd(o):
        if isinstance(o, list): return [rnd(v) for v in o]
        if isinstance(o, float): return round(o, 5)
        return o
    for f in land_fc["features"]:
        f["geometry"]["coordinates"] = rnd(f["geometry"]["coordinates"])
    (OUT / "coast-land.geojson").write_text(json.dumps(land_fc, separators=(",", ":")))
    print(f"wrote coast-land.geojson ({(OUT / 'coast-land.geojson').stat().st_size // 1024} KB)", flush=True)
    feats = ribbon(polys, land, ys, xs, a.seg_m, a.min_exposure)
    (OUT / "coast-ribbon.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":")))
    print(f"wrote coast-ribbon.geojson: {len(feats)} segments ({(OUT / 'coast-ribbon.geojson').stat().st_size // 1024} KB)")
    keep = [f for f in feats if f["properties"]["e"] >= 0.5]
    compact = {"seg_m": a.seg_m, "fields": ["lon_a", "lat_a", "lon_b", "lat_b", "normal_deg"], "ids": [f["id"] for f in keep],
               "segs": [[*f["geometry"]["coordinates"][0], *f["geometry"]["coordinates"][1], f["properties"]["n"]] for f in keep]}
    (OUT / "coast-ribbon.compact.json").write_text(json.dumps(compact, separators=(",", ":")))
    print(f"wrote coast-ribbon.compact.json: {len(keep)} open-coast segments ({(OUT / 'coast-ribbon.compact.json').stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

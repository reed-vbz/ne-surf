"""
New Hampshire Sandbox data (5-layer marine architecture) from the NOAA Coastal Relief Model, 3 arc-second.

    python -m nesurf.sandbox_nh          # -> public/data/nh/*.json|geojson  +  public/tiles/nh/{z}/{x}/{y}.pbf (z 8–14)

Outputs
  depth.json          uint16 decimetre depth grid (base64), lat/lon origin + res; 0 = land   → client ocean test, refraction
  land.geojson        open-water land polygons (rivers/marsh < ~1 km opened out)            → L3 mask source
  ocean.geojson       bbox minus land                                                       → deck.gl MaskExtension geometry
  bathy.geojson       isobath polygons with min_depth / max_depth (m)                       → L0
  ribbon.geojson      100 m high-water-mark segments with land→sea normal + exposure        → L2
  spots.geojson       breaks inside the bbox                                                → L4
  tiles/nh/…pbf       one multi-layer MVT per tile: layers `bathy`, `land`, `ribbon`
"""
from __future__ import annotations

import base64
import json
import math
import shutil
import sys

import mapbox_vector_tile
import numpy as np
import xarray as xr
from rasterio import features
from rasterio.transform import from_origin
from scipy import ndimage
from shapely.geometry import box, mapping, shape
from shapely.ops import transform, unary_union

from .coastline import ribbon as ribbon_segments
from .common import REPO_ROOT, load_spots

CRM_URL = "https://www.ngdc.noaa.gov/thredds/dodsC/crm/crm_vol1.nc"
S, N, W, E = 42.78, 43.20, -70.95, -70.40          # Salisbury MA → Long Sands ME
BINS = [(0, 2), (2, 5), (5, 10), (10, 20), (20, 40), (40, 80), (80, 150), (150, 400)]
OUT = REPO_ROOT / "public" / "data" / "nh"; TILES = REPO_ROOT / "public" / "tiles" / "nh"
R = 6378137.0


def merc(lon, lat):
    return R * math.radians(lon), R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def tile_bounds(z, x, y):
    n = 2 ** z; w = 2 * math.pi * R
    return (-w / 2 + x * w / n, w / 2 - (y + 1) * w / n, -w / 2 + (x + 1) * w / n, w / 2 - y * w / n)


def lonlat_to_tile(lon, lat, z):
    n = 2 ** z; x = int((lon + 180) / 360 * n); y = int((1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n)
    return x, y


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    ds = xr.open_dataset(CRM_URL)
    z = ds["z"].sel(x=slice(W, E), y=slice(S, N)).load()
    xs, ys = z.x.values, z.y.values; res = float(xs[1] - xs[0])
    depth = -z.values.astype(float); depth[~np.isfinite(depth)] = 0
    water = depth > 0
    r = 5; yy, xx = np.ogrid[-r:r + 1, -r:r + 1]; disk = (xx * xx + yy * yy) <= r * r
    water = ndimage.binary_dilation(ndimage.binary_opening(water, structure=disk), structure=np.ones((3, 3), bool)) & water
    depth[~water] = 0
    print(f"grid {depth.shape}, water {water.mean():.2f}", flush=True)

    # depth grid for the client (decimetres, uint16)
    q = np.clip(np.round(depth * 10), 0, 65535).astype("<u2")
    (OUT / "depth.json").write_text(json.dumps({"lat0": float(ys[0]), "lon0": float(xs[0]), "res": res, "nlat": int(depth.shape[0]), "nlon": int(depth.shape[1]),
        "unit": "decimetres, uint16 little-endian, row-major lat ascending; 0 = land", "data_b64": base64.b64encode(q.tobytes()).decode()}))

    transform_ = from_origin(float(xs[0]) - res / 2, float(ys[-1]) + res / 2, res, res)
    def chaikin(coords, n=2):
        pts = list(coords)
        for _ in range(n):
            new = []
            for (x0, y0), (x1, y1) in zip(pts[:-1], pts[1:]):
                new.append((0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1)); new.append((0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1))
            new.append(new[0]); pts = new
        return pts
    def smooth(g):
        from shapely.geometry import Polygon
        if g.geom_type == "MultiPolygon": return unary_union([smooth(p) for p in g.geoms])
        if len(g.exterior.coords) < 8: return g
        return Polygon(chaikin(g.exterior.coords), [chaikin(r.coords) for r in g.interiors if len(r.coords) >= 8]).buffer(0)
    def polys(mask, simplify=30 / 111320):
        out = []
        for geom, _ in features.shapes(mask[::-1].astype(np.uint8), mask=mask[::-1], transform=transform_, connectivity=8):
            # Chaikin-smooth the 90 m stair-steps, then simplify: contours read as isobaths, not pixels
            g = smooth(shape(geom)).simplify(simplify, preserve_topology=True).buffer(0)
            if g.is_empty: continue
            out.extend(list(g.geoms) if g.geom_type == "MultiPolygon" else [g])   # explode: the ribbon walker wants Polygons
        return out
    land = polys(~water)
    land_u = unary_union(land)
    ocean = box(W, S, E, N).difference(land_u)
    def fc(feats): return {"type": "FeatureCollection", "features": feats}
    (OUT / "land.geojson").write_text(json.dumps(fc([{"type": "Feature", "properties": {}, "geometry": mapping(g)} for g in land]), separators=(",", ":")))
    (OUT / "ocean.geojson").write_text(json.dumps(fc([{"type": "Feature", "properties": {}, "geometry": mapping(ocean)}]), separators=(",", ":")))
    print(f"land polygons {len(land)}", flush=True)

    bathy = []
    for lo, hi in BINS:
        m = water & (depth > lo) & (depth <= hi)
        for g in polys(m):
            if g.area * 111 * 111 * math.cos(math.radians(43)) < 0.005: continue
            bathy.append({"type": "Feature", "properties": {"min_depth": lo, "max_depth": hi}, "geometry": mapping(g)})
    (OUT / "bathy.geojson").write_text(json.dumps(fc(bathy), separators=(",", ":")))
    print(f"isobath polygons {len(bathy)}", flush=True)

    # ribbon (reuse the coastline segmenter): needs (polygon, km2) pairs + the land raster
    pairs = [(g, g.area * 111 * 111 * math.cos(math.radians(43))) for g in land]
    ribbon = [f for f in ribbon_segments(pairs, ~water, ys, xs, 100.0, 0.35)]
    (OUT / "ribbon.geojson").write_text(json.dumps(fc(ribbon), separators=(",", ":")))
    print(f"ribbon segments {len(ribbon)}", flush=True)

    spots = [{"type": "Feature", "id": s["id"], "properties": {"id": s["id"], "name": s["name"], "state": s["state"], "facing": s["facing_deg"]},
              "geometry": {"type": "Point", "coordinates": [s["location"]["lon"], s["location"]["lat"]]}}
             for s in load_spots() if S <= s["location"]["lat"] <= N and W <= s["location"]["lon"] <= E]
    (OUT / "spots.geojson").write_text(json.dumps(fc(spots)))
    print(f"spots {len(spots)}: {[s['properties']['id'] for s in spots]}", flush=True)

    # MVT tiles z8–14
    if TILES.exists(): shutil.rmtree(TILES)
    layers_src = {"bathy": [(shape(f["geometry"]), f["properties"]) for f in bathy], "land": [(g, {}) for g in land],
                  "ribbon": [(shape(f["geometry"]), {"n": f["properties"]["n"], "e": f["properties"]["e"], "id": f["id"]}) for f in ribbon]}
    to_m = lambda g: transform(lambda x, y, z=None: merc(x, y), g)
    layers_m = {k: [(to_m(g), p) for g, p in v] for k, v in layers_src.items()}
    count = 0
    for zl in range(8, 15):
        x0, y0 = lonlat_to_tile(W, N, zl); x1, y1 = lonlat_to_tile(E, S, zl)
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                b = tile_bounds(zl, x, y); pad = (b[2] - b[0]) * 0.05
                clip = box(b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad)
                tile_layers = []
                for name, feats in layers_m.items():
                    fs = []
                    for g, p in feats:
                        if not g.intersects(clip): continue
                        c = g.intersection(clip)
                        if c.is_empty: continue
                        fs.append({"geometry": c.wkb, "properties": p})
                    if fs: tile_layers.append({"name": name, "features": fs})
                if not tile_layers: continue
                data = mapbox_vector_tile.encode(tile_layers, quantize_bounds=b, extents=4096)
                d = TILES / str(zl) / str(x); d.mkdir(parents=True, exist_ok=True); (d / f"{y}.pbf").write_bytes(data); count += 1
        print(f"z{zl} done ({count} tiles so far)", flush=True)
    print(f"wrote {count} tiles under {TILES}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

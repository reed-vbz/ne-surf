"""
New Hampshire Sandbox data (5-layer marine architecture) from the NOAA Coastal Relief Model, 3 arc-second.

    python -m nesurf.sandbox_nh          # -> public/data/nh/*.json|geojson  +  public/tiles/nh/{z}/{x}/{y}.pbf (z 8–13)

Outputs
  depth.json          uint16 decimetre depth grid (base64), lat/lon origin + res; 0 = land   → client ocean test, refraction
  land.geojson        open-water land polygons (rivers/marsh < ~1 km opened out)            → L3 mask source
  ocean.geojson       bbox minus land                                                       → deck.gl MaskExtension geometry
  bathy.geojson       isobath polygons with min_depth / max_depth (m)                       → L0
  ribbon.geojson      100 m high-water-mark segments with land→sea normal + exposure        → L2
  spots.geojson       breaks inside the bbox                                                → L4
  tiles/nh/…pbf       one multi-layer MVT per tile: layers `bathy`, `land`, `ribbon`
  tiles/nh-dem/…png   Terrain-RGB DEM tiles (z 8–13) from the same CRM grid: bathymetry negative, land positive → MapLibre terrain
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
S, N, W, E = 42.80, 43.60, -70.85, -70.20          # Reed's regional bbox 2026-09-22: Salisbury MA → Scarborough ME
BINS = [(0, 2), (2, 5), (5, 10), (10, 20), (20, 40), (40, 80), (80, 150), (150, 400)]
MIN_CELLS = 16          # isobath speckle: regions / holes below this many 90 m cells are absorbed into their surroundings
MAX_ZOOM = 13           # MapLibre overzooms vector tiles; z13 (≈14 m/px here) is plenty for smoothed isobaths
OUT = REPO_ROOT / "public" / "data" / "nh"; TILES = REPO_ROOT / "public" / "tiles" / "nh"; DEM = REPO_ROOT / "public" / "tiles" / "nh-dem"
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
    elev = z.values.astype(float); elev[~np.isfinite(elev)] = 0
    depth = -elev.copy()
    water = depth > 0
    r = 5; yy, xx = np.ogrid[-r:r + 1, -r:r + 1]; disk = (xx * xx + yy * yy) <= r * r
    water = ndimage.binary_dilation(ndimage.binary_opening(water, structure=disk), structure=np.ones((3, 3), bool)) & water
    # inland ponds the CRM carries below sea level are not ocean: keep water bodies ≥ 3 km² or touching the bbox edge
    lab, n = ndimage.label(water); sizes = np.bincount(lab.ravel())
    edge = np.zeros(n + 1, bool); edge[np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))] = True
    cell_km2 = (res * 111.32) ** 2 * math.cos(math.radians(43))
    keep = (sizes >= 3.0 / cell_km2) | edge; keep[0] = False
    water &= keep[lab]
    depth[~water] = 0
    print(f"grid {depth.shape}, water {water.mean():.2f}, water bodies kept {int(keep.sum())} of {n}", flush=True)

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
    # L3 land = bbox minus the ocean's OWN outline (the 0 m contour used by L0), so land and bathymetry share one exact
    # edge: no sliver of basemap can show between them. Not simplified client-side; smoothing happens once, here.
    ocean_u = unary_union(polys(water)).buffer(0)
    land_u = box(W, S, E, N).difference(ocean_u).buffer(0)
    land = [g for g in (land_u.geoms if land_u.geom_type == "MultiPolygon" else [land_u]) if not g.is_empty]
    ocean = ocean_u
    def fc(feats): return {"type": "FeatureCollection", "features": feats}
    (OUT / "land.geojson").write_text(json.dumps(fc([{"type": "Feature", "properties": {}, "geometry": mapping(g)} for g in land]), separators=(",", ":")))
    (OUT / "ocean.geojson").write_text(json.dumps(fc([{"type": "Feature", "properties": {}, "geometry": mapping(ocean)}]), separators=(",", ":")))
    print(f"land polygons {len(land)}", flush=True)

    # Isobaths: nested cumulative contours ("deeper than lo") cut from ONE lightly smoothed field, each cleaned of
    # speckle, smoothed once, then differenced against the next contour — so adjacent bins share exact edges
    # (no hairline gaps showing the satellite through) and no single-cell squares survive.
    depth_s = ndimage.gaussian_filter(depth, 1.2); depth_s[~water] = 0
    def declutter(m):
        lab, n = ndimage.label(m); sizes = np.bincount(lab.ravel()); m = m & (sizes[lab] >= MIN_CELLS)
        lab, n = ndimage.label(~m); sizes = np.bincount(lab.ravel()); holes = (~m) & (sizes[lab] < MIN_CELLS)
        return (m | holes) & water
    cum = [ocean_u]   # bin 0 starts from the same outline as the land mask
    for lo, _ in BINS[1:]:
        g = unary_union(polys(declutter(water & (depth_s > lo)))).buffer(0)
        g = g.intersection(cum[-1]).buffer(0)      # enforce nesting after independent smoothing
        cum.append(g)
    bathy = []
    for k, (lo, hi) in enumerate(BINS):
        band = cum[k].difference(cum[k + 1]).buffer(0) if k + 1 < len(cum) else cum[k]
        for g in (band.geoms if band.geom_type == "MultiPolygon" else [band]):
            if g.is_empty or g.area * 111 * 111 * math.cos(math.radians(43)) < 0.004: continue
            bathy.append({"type": "Feature", "properties": {"min_depth": lo, "max_depth": hi}, "geometry": mapping(g)})
    (OUT / "bathy.geojson").write_text(json.dumps(fc(bathy), separators=(",", ":")))
    print(f"isobath polygons {len(bathy)}", flush=True)

    # Derive both coastline and ribbon from the same ocean polygon used by rendering.
    from .coastal_geometry import build as build_coastline
    ribbon = build_coastline(OUT)

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
    for zl in range(8, MAX_ZOOM + 1):
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
                        if c.geom_type == "GeometryCollection":   # shared edges leave stray lines/points after the clip
                            want = "Polygon" if name != "ribbon" else "LineString"
                            c = unary_union([x for x in c.geoms if x.geom_type.endswith(want)])
                        if c.is_empty: continue
                        fs.append({"geometry": c.wkb, "properties": p})
                    if fs: tile_layers.append({"name": name, "features": fs})
                if not tile_layers: continue
                data = mapbox_vector_tile.encode(tile_layers, quantize_bounds=b, extents=4096)
                d = TILES / str(zl) / str(x); d.mkdir(parents=True, exist_ok=True); (d / f"{y}.pbf").write_bytes(data); count += 1
        print(f"z{zl} done ({count} tiles so far)", flush=True)
    print(f"wrote {count} tiles under {TILES}")
    # DEM covers the bbox padded by 0.25° so the 3D floor does not end in a cliff at the tile edge
    zp = ds["z"].sel(x=slice(W - 0.25, E + 0.25), y=slice(S - 0.25, N + 0.25)).load()
    ep = zp.values.astype(float); ep[~np.isfinite(ep)] = 0
    write_dem_tiles(ep, zp.y.values, zp.x.values, box=(S - 0.25, N + 0.25, W - 0.25, E + 0.25))
    return 0


def write_dem_tiles(elev, ys, xs, box=(S, N, W, E), zooms=range(8, MAX_ZOOM + 1), size=256):
    """Terrain-RGB tiles: value = (elev + 10000) / 0.1 packed into R,G,B (Mapbox/MapLibre 'mapbox' encoding). Each tile pixel
    is sampled bilinearly from the CRM grid at its lon/lat; outside the grid the tile is left at sea level (0 m)."""
    from PIL import Image
    if DEM.exists(): shutil.rmtree(DEM)
    lat0, lon0 = float(ys[0]), float(xs[0]); res = float(xs[1] - xs[0]); nlat, nlon = elev.shape
    count = 0
    for zl in zooms:
        bs, bn, bw, be = box
        x0, y0 = lonlat_to_tile(bw, bn, zl); x1, y1 = lonlat_to_tile(be, bs, zl); n = 2 ** zl
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                px = (np.arange(size) + 0.5) / size; lon = (x + px) / n * 360 - 180
                lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * (y + px) / n))))
                fi = (lat[:, None] - lat0) / res; fj = (lon[None, :] - lon0) / res
                i0 = np.clip(np.floor(fi).astype(int), 0, nlat - 2); j0 = np.clip(np.floor(fj).astype(int), 0, nlon - 2)
                ti = np.clip(fi - i0, 0, 1); tj = np.clip(fj - j0, 0, 1)
                v = elev[i0, j0] * (1 - ti) * (1 - tj) + elev[i0 + 1, j0] * ti * (1 - tj) + elev[i0, j0 + 1] * (1 - ti) * tj + elev[i0 + 1, j0 + 1] * ti * tj
                inside = (fi >= 0) & (fi <= nlat - 1) & (fj >= 0) & (fj <= nlon - 1); v = np.where(inside, v, 0.0)
                # feather to sea level over the outer `feather` degrees of the box so the 3D floor never ends in a cliff
                f = 0.12; wy = np.clip(np.minimum(lat[:, None] - bs, bn - lat[:, None]) / f, 0, 1); wx = np.clip(np.minimum(lon[None, :] - bw, be - lon[None, :]) / f, 0, 1)
                w = wy * wx; w = w * w * (3 - 2 * w); v = v * w
                q = np.clip(np.round((v + 10000) / 0.1), 0, 2 ** 24 - 1).astype(np.uint32)
                rgb = np.stack([(q >> 16) & 255, (q >> 8) & 255, q & 255], axis=-1).astype(np.uint8)
                d = DEM / str(zl) / str(x); d.mkdir(parents=True, exist_ok=True)
                Image.fromarray(rgb, "RGB").save(d / f"{y}.png", optimize=True); count += 1
        print(f"dem z{zl} done ({count} tiles so far)", flush=True)
    print(f"wrote {count} DEM tiles under {DEM}")


if __name__ == "__main__":
    sys.exit(main())

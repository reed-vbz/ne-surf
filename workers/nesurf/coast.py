"""
Coastal band for the wind-shading overlay: every LAND cell within `--band` cells of water on a fine
lat/lon grid, with the bearing from that cell toward the sea (the local coast normal).

    python -m nesurf.coast            # -> data/coast.json  (static, ~100 KB; rerun only if the bbox/res changes)

The UI colours each band cell by the HRRR wind relative to that normal: wind blowing land→sea = offshore
(green), sea→land = onshore (orange), alongshore = grey, fading with distance from the waterline.
Land/water from the GLOBE 1 km mask (global-land-mask).
"""
from __future__ import annotations

import argparse
import base64
import json
import sys

import numpy as np
from global_land_mask import globe
from scipy import ndimage

from .common import DATA_DIR, NE_BBOX


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--res", type=float, default=0.0125, help="grid spacing in degrees (default 0.0125 ≈ 1.4 km)")
    ap.add_argument("--band", type=int, default=4, help="band width in cells landward of the waterline")
    ap.add_argument("--radius", type=int, default=6, help="window (cells) used to estimate the coast normal")
    ap.add_argument("--out", default=str(DATA_DIR / "coast.json"))
    a = ap.parse_args(argv)

    b = NE_BBOX
    lats = np.arange(b.south, b.north + 1e-9, a.res); lons = np.arange(b.west, b.east + 1e-9, a.res)
    LA, LO = np.meshgrid(lats, lons, indexing="ij")
    land = globe.is_land(LA, LO)
    water = ~land
    # distance (in cells, Chebyshev) from each land cell to the nearest water cell, up to band
    dist = np.full(land.shape, 99, dtype=int)
    grown = water.copy()
    for d in range(1, a.band + 1):
        grown = ndimage.binary_dilation(grown, structure=np.ones((3, 3), bool))
        dist[(dist == 99) & grown & land] = d
    coastal = (dist <= a.band) & land
    # coast normal: direction from the cell to the centroid of water within `radius` cells
    r = a.radius
    dj = np.arange(-r, r + 1)[None, :].repeat(2 * r + 1, 0).astype(float)   # +east
    di = np.arange(-r, r + 1)[:, None].repeat(2 * r + 1, 1).astype(float)   # +north (row index grows north)
    wf = water.astype(float)
    ex = ndimage.convolve(wf, dj[::-1, ::-1], mode="constant") * np.cos(np.radians(LA))  # scale east offsets by cos(lat)
    ny = ndimage.convolve(wf, di[::-1, ::-1], mode="constant")
    bearing = (np.degrees(np.arctan2(ex, ny)) + 360) % 360
    ii, jj = np.where(coastal)
    cells = [[int(i), int(j), int(round(bearing[i, j])), int(dist[i, j])] for i, j in zip(ii, jj)]
    # full land mask, bit-packed row-major [lat][lon] (south→north), base64 — lets the UI cut ocean rasters at the shoreline
    packed = base64.b64encode(np.packbits(land.astype(np.uint8).ravel())).decode("ascii")
    doc = {"res": a.res, "lat0": float(lats[0]), "lon0": float(lons[0]), "nlat": int(len(lats)), "nlon": int(len(lons)),
           "band": a.band, "land_mask_b64": packed, "order": "cells: [i (lat index, south→north), j (lon index), normal_deg (bearing land→sea), dist_cells]",
           "source": "GLOBE 1 km land mask via global-land-mask", "cells": cells}
    with open(a.out, "w") as fh:
        json.dump(doc, fh, separators=(",", ":"))
    print(f"wrote {a.out}: grid {len(lats)}x{len(lons)}, {len(cells)} coastal cells")
    return 0


if __name__ == "__main__":
    sys.exit(main())

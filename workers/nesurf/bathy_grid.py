"""
Coarse depth grid over the bounding box for the 'Refraction map' mode (NOAA CRM vol. 1 via OPeNDAP).

    python -m nesurf.bathy_grid           # -> data/bathy-grid.json  (~0.02°, uint8 log-depth, base64)

Depth is quantised to 0..255 on a log scale (0 m .. 300 m); 0 = land / no data. The UI colours it as a
bathymetry shade over water only. Static: rerun only if the bbox or resolution changes.
"""
from __future__ import annotations

import argparse
import base64
import json
import sys

import numpy as np
import xarray as xr

from .common import DATA_DIR, NE_BBOX

CRM_URL = "https://www.ngdc.noaa.gov/thredds/dodsC/crm/crm_vol1.nc"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--res", type=float, default=0.02)
    ap.add_argument("--out", default=str(DATA_DIR / "bathy-grid.json"))
    a = ap.parse_args(argv)
    b = NE_BBOX
    ds = xr.open_dataset(CRM_URL)
    stride = max(1, int(round(a.res / 0.000833)))
    z = ds["z"].sel(x=slice(b.west, b.east), y=slice(b.south, b.north)).isel(x=slice(0, None, stride), y=slice(0, None, stride)).load()
    depth = -z.values.astype(float)
    depth[~np.isfinite(depth)] = np.nan
    q = np.zeros(depth.shape, dtype=np.uint8)
    wet = np.isfinite(depth) & (depth > 0)
    q[wet] = np.clip(1 + 254 * np.log1p(depth[wet]) / np.log1p(300.0), 1, 255).astype(np.uint8)
    doc = {"res": float(z.x.values[1] - z.x.values[0]), "lat0": float(z.y.values[0]), "lon0": float(z.x.values[0]),
           "nlat": int(q.shape[0]), "nlon": int(q.shape[1]), "order": "row-major [lat][lon], lat ascending",
           "encoding": "uint8: 0 = land/no data, else 1 + 254·log1p(depth_m)/log1p(300)", "source": CRM_URL,
           "data_b64": base64.b64encode(q.ravel().tobytes()).decode("ascii")}
    with open(a.out, "w") as fh:
        json.dump(doc, fh, separators=(",", ":"))
    print(f"wrote {a.out}: {q.shape[0]}x{q.shape[1]} cells, {wet.mean()*100:.0f}% water, {len(doc['data_b64'])//1024} KB b64")
    return 0


if __name__ == "__main__":
    sys.exit(main())

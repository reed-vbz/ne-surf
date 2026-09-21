"""
Per-break CRM depth tiles for the refraction engine (lib/refraction.ts).

    python -m nesurf.bathy_tiles     # -> public/data/bathy-tiles.json  ({spot_id: {lat0, lon0, res, nlat, nlon, depth[]}})

Each tile is 14 km × 14 km at 3 arc-seconds (~90 m), depth in metres positive down, land/no-data = 0.
"""
from __future__ import annotations

import json
import math
import sys

import numpy as np
import xarray as xr

from .common import REPO_ROOT, load_spots

CRM_URL = "https://www.ngdc.noaa.gov/thredds/dodsC/crm/crm_vol1.nc"


def main() -> int:
    ds = xr.open_dataset(CRM_URL)
    tiles = {}
    for s in load_spots():
        lat, lon = s["location"]["lat"], s["location"]["lon"]
        dlat = 7000 / 110540; dlon = 7000 / (111320 * math.cos(math.radians(lat)))
        z = ds["z"].sel(x=slice(lon - dlon, lon + dlon), y=slice(lat - dlat, lat + dlat)).load()
        depth = -z.values.astype(float); depth[~np.isfinite(depth)] = 0; depth[depth < 0] = 0
        tiles[s["id"]] = {"lat0": float(z.y.values[0]), "lon0": float(z.x.values[0]), "res": float(z.x.values[1] - z.x.values[0]),
                          "nlat": int(depth.shape[0]), "nlon": int(depth.shape[1]), "depth": [round(float(v), 1) for v in depth.ravel()]}
        print(f"{s['id']:<28} {depth.shape[0]}x{depth.shape[1]}  max depth {depth.max():.0f} m", flush=True)
    out = REPO_ROOT / "public" / "data" / "bathy-tiles.json"; out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(tiles, separators=(",", ":")))
    print(f"wrote {out} ({out.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

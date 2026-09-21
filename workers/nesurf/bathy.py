"""
Nearshore bathymetry per spot from NOAA's Coastal Relief Model, Northeast Atlantic (CRM vol. 1, 3 arc-second).

    python -m nesurf.bathy                # all spots -> data/bathymetry.json
    python -m nesurf.bathy --spot nauset-beach-ma -v

Source (verified 2026-09-21): https://www.ngdc.noaa.gov/thredds/dodsC/crm/crm_vol1.nc  (OPeNDAP; x -80..-64, y 40..48,
0.000833 deg; z metres, positive up). Only a ~6 x 6 km window per spot is transferred.

For each spot: three parallel transects (centre and +/-150 m) from the shoreline outward along `facing_deg`,
50 m spacing to 3 km, bilinear-sampled. From the averaged profile:
  slope_tan   bottom slope tan(beta) fitted over the 1-8 m depth band (the surf zone for 1-4 m waves)
  depth_at    depth at 250 / 500 / 1000 / 2000 m offshore (info + panel chart)
  profile     [distance_m, depth_m] every 100 m
The score engine turns slope + deep-water H0,T into breaking height (Komar & Gaughan 1972) and breaker type
(Iribarren number), replacing the hand-tuned shoaling_factor.
"""
from __future__ import annotations

import argparse
import json
import logging
import math
import sys
from datetime import datetime, timezone

import numpy as np
import xarray as xr

from .common import DATA_DIR, load_spots

log = logging.getLogger("nesurf.bathy")
CRM_URL = "https://www.ngdc.noaa.gov/thredds/dodsC/crm/crm_vol1.nc"


def dest(lat, lon, bearing_deg, dist_m):
    r = 6371000.0; b = math.radians(bearing_deg); p1 = math.radians(lat); l1 = math.radians(lon); d = dist_m / r
    p2 = math.asin(math.sin(p1) * math.cos(d) + math.cos(p1) * math.sin(d) * math.cos(b))
    l2 = l1 + math.atan2(math.sin(b) * math.sin(d) * math.cos(p1), math.cos(d) - math.sin(p1) * math.sin(p2))
    return math.degrees(p2), math.degrees(l2)


def transect(z: xr.DataArray, lat, lon, bearing, max_m=3000, step_m=50, lateral_m=150, back_m=1500):
    dists = np.arange(-back_m, max_m + 1, step_m)  # negative = landward of the marker
    profiles = []
    for side in (-lateral_m, 0, lateral_m):
        la0, lo0 = dest(lat, lon, bearing + 90, side)
        pts = [dest(la0, lo0, bearing, d) for d in dists]
        zs = z.interp(y=xr.DataArray([p[0] for p in pts], dims="k"), x=xr.DataArray([p[1] for p in pts], dims="k"), method="linear").values
        profiles.append(zs)
    prof = np.nanmean(np.vstack(profiles), axis=0)
    return dists, prof


def analyse(dists: np.ndarray, prof: np.ndarray) -> dict:
    # shoreline = last land point before the wet run that reaches the seaward end (markers can sit on the
    # dune line or a few hundred metres out in the water); re-base distances from there
    wet = np.isfinite(prof) & (prof < 0)
    if not wet.any() or not wet[-1]:
        return {"quality": "no_water", "slope_tan": None}
    i0 = len(prof) - 1
    while i0 > 0 and wet[i0 - 1]: i0 -= 1
    i0 = max(0, i0 - 1)
    d = dists[i0:] - dists[i0]; zz = prof[i0:]
    depth = -zz
    band = (depth >= 1.0) & (depth <= 8.0) & np.isfinite(depth)
    out = {"shore_offset_m": int(dists[i0]), "marker_note": "marker is offshore" if dists[i0] < -100 else ("marker is inland" if dists[i0] > 100 else "marker at shoreline")}
    if band.sum() >= 4:
        A = np.vstack([d[band], np.ones(band.sum())]).T
        (m, c), res, *_ = np.linalg.lstsq(A, depth[band], rcond=None)
        ss_tot = float(((depth[band] - depth[band].mean()) ** 2).sum())
        r2 = 1 - float(res[0]) / ss_tot if len(res) and ss_tot > 0 else None
        out.update({"slope_tan": round(float(m), 4), "slope_r2": None if r2 is None else round(r2, 3),
                    "band_points": int(band.sum()), "quality": "ok" if (r2 or 0) > 0.8 and m > 0 else "noisy"})
    else:
        out.update({"slope_tan": None, "quality": "too_shallow_or_flat", "band_points": int(band.sum())})
    def at(x):
        j = int(np.argmin(np.abs(d - x))); return None if j >= len(depth) or not np.isfinite(depth[j]) else round(float(depth[j]), 1)
    out["depth_at_m"] = {"250": at(250), "500": at(500), "1000": at(1000), "2000": at(2000)}
    out["max_depth_m"] = round(float(np.nanmax(depth)), 1)
    keep = np.arange(0, len(d), 2)  # every 100 m
    out["profile"] = [[int(d[k]), None if not np.isfinite(depth[k]) else round(float(depth[k]), 1)] for k in keep]
    # bar detection: a local depth minimum seaward of a deeper trough within the first 600 m
    dd = depth[(d <= 600)]
    out["has_bar"] = bool(len(dd) > 6 and any(dd[k] < dd[k - 1] - 0.3 and dd[k] < dd[min(k + 1, len(dd) - 1)] for k in range(2, len(dd) - 1)))
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--spot"); ap.add_argument("--out", default=str(DATA_DIR / "bathymetry.json")); ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if a.verbose else logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    spots = [s for s in load_spots() if not a.spot or s["id"] == a.spot]
    ds = xr.open_dataset(CRM_URL)
    results = {}
    for s in spots:
        lat, lon, bearing = s["location"]["lat"], s["location"]["lon"], s["facing_deg"]
        # window: 3.5 km each way covers the transect plus lateral offsets
        dlat = 0.035; dlon = 0.035 / math.cos(math.radians(lat))
        z = ds["z"].sel(x=slice(lon - dlon, lon + dlon), y=slice(lat - dlat, lat + dlat)).load()
        dists, prof = transect(z, lat, lon, bearing)
        r = analyse(dists, prof)
        r.update({"facing_used": bearing, "source": "NOAA CRM vol1 3-arcsec via OPeNDAP", "transect_m": 3000})
        results[s["id"]] = r
        log.info("%-28s slope %s r2 %s q=%s depth@500 %s @1000 %s bar=%s", s["id"], r.get("slope_tan"), r.get("slope_r2"), r.get("quality"),
                 r.get("depth_at_m", {}).get("500"), r.get("depth_at_m", {}).get("1000"), r.get("has_bar"))
    doc = {"generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "source": CRM_URL,
           "method": "3 parallel transects along facing_deg from the shoreline, slope fitted over the 1-8 m depth band", "spots": results}
    with open(a.out, "w") as fh:
        json.dump(doc, fh, indent=1)
    log.info("wrote %s (%d spots)", a.out, len(results))
    return 0


if __name__ == "__main__":
    sys.exit(main())

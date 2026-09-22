"""
Chart-check the hand-entered spot catalogue against independent data and write a report.

  python -m nesurf.verify_spots            # report only  -> workers/.scratch/spot-verification.json + stdout table
  python -m nesurf.verify_spots --apply    # also rewrite data/spots.json with the computed values

Checks (all free / offline except geocoding):
  1. Geocode the spot name with OSM Nominatim (1 req/s policy) and report the distance to our coordinate.
  2. Shoreline normal ("facing") from the 1 km GLOBE land mask (global-land-mask): water fraction by
     bearing on rings 0.5-2 km around the spot, circular mean of the water bearings.
  3. Shadow sectors by ray-casting from the spot: every 2 degrees within +/-110 of facing, march 1.5-250 km
     over the land mask; contiguous blocked bearings become a sector, labelled by the nearest landmark.
  4. Offshore sample point must be water and >= 3 km from land.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path

import numpy as np
import requests
from global_land_mask import globe

from .common import DATA_DIR, SCRATCH_DIR, USER_AGENT, haversine_km

LANDMARKS = {
    "Block Island": (41.17, -71.58), "Long Island / Montauk": (41.02, -71.95), "Martha's Vineyard": (41.40, -70.65),
    "Elizabeth Islands": (41.47, -70.78), "Nantucket": (41.28, -70.10), "Cape Cod": (41.85, -70.00),
    "Cape Ann": (42.63, -70.62), "Point Judith": (41.36, -71.48), "Sakonnet Point": (41.45, -71.19),
    "Cape Elizabeth": (43.56, -70.20), "Monhegan / midcoast islands": (43.76, -69.32), "Isles of Shoals": (42.98, -70.62),
}
# Query strings for Nominatim (town added so common names resolve to the right beach)
GEOCODE_QUERIES = {
    "misquamicut-ri": "Misquamicut State Beach, Westerly, RI", "matunuck-ri": "Matunuck Beach, South Kingstown, RI",
    "point-judith-ri": "Point Judith Lighthouse, Narragansett, RI", "narragansett-town-beach-ri": "Narragansett Town Beach, Narragansett, RI",
    "ruggles-ri": "Ruggles Avenue, Newport, RI", "second-beach-ri": "Sachuest Beach, Middletown, RI",
    "horseneck-ma": "Horseneck Beach, Westport, MA", "south-beach-katama-ma": "South Beach, Edgartown, MA",
    "nobadeer-ma": "Nobadeer Beach, Nantucket, MA", "nauset-beach-ma": "Nauset Beach, Orleans, MA",
    "coast-guard-beach-ma": "Coast Guard Beach, Eastham, MA", "nantasket-ma": "Nantasket Beach, Hull, MA",
    "good-harbor-ma": "Good Harbor Beach, Gloucester, MA", "salisbury-ma": "Salisbury Beach, Salisbury, MA",
    "the-wall-nh": "North Beach, Hampton, NH", "jenness-nh": "Jenness State Beach, Rye, NH", "seabrook-nh": "Seabrook Beach, Seabrook, NH",
    "hampton-beach-nh": "Hampton Beach, Hampton, NH", "plaice-cove-nh": "Plaice Cove, Hampton, NH", "rye-rocks-nh": "Rye Harbor, Rye, NH", "wallis-sands-nh": "Wallis Sands State Beach, Rye, NH",
    "ogunquit-me": "Ogunquit Beach, Ogunquit, ME", "wells-me": "Wells Beach, Wells, ME", "fortunes-rocks-me": "Fortunes Rocks Beach, Biddeford, ME",
    "long-sands-me": "Long Sands Beach, York, ME", "goochs-me": "Gooch's Beach, Kennebunk, ME",
    "old-orchard-me": "Old Orchard Beach, ME", "higgins-me": "Higgins Beach, Scarborough, ME", "popham-me": "Popham Beach, Phippsburg, ME",
}


def dest(lat: float, lon: float, bearing_deg: float, dist_km: float) -> tuple[float, float]:
    r = 6371.0
    b = math.radians(bearing_deg); p1 = math.radians(lat); l1 = math.radians(lon); d = dist_km / r
    p2 = math.asin(math.sin(p1) * math.cos(d) + math.cos(p1) * math.sin(d) * math.cos(b))
    l2 = l1 + math.atan2(math.sin(b) * math.sin(d) * math.cos(p1), math.cos(d) - math.sin(p1) * math.sin(p2))
    return math.degrees(p2), math.degrees(l2)


def circ_mean(bearings: np.ndarray, weights: np.ndarray) -> float | None:
    if weights.sum() == 0: return None
    x = (weights * np.cos(np.radians(bearings))).sum(); y = (weights * np.sin(np.radians(bearings))).sum()
    return float(np.degrees(np.arctan2(y, x)) % 360)


def computed_facing(lat: float, lon: float) -> tuple[float | None, float]:
    """Circular mean of bearings toward water on rings around the spot; also the land fraction at 1 km."""
    bearings = np.arange(0, 360, 5.0)
    water = np.zeros_like(bearings); n = 0
    for r in (0.5, 1.0, 1.5, 2.0):
        pts = [dest(lat, lon, b, r) for b in bearings]
        land = globe.is_land(np.array([p[0] for p in pts]), np.array([p[1] for p in pts]))
        water += (~land).astype(float); n += 1
    return circ_mean(bearings, water / n), float(1 - (water / n).mean())


def raycast_shadows(lat: float, lon: float, window: tuple[float, float], max_km: float = 250.0, step_km: float = 0.25, start_km: float = 2.0):
    """For each bearing from window.from-30° clockwise to window.to+30°: distance to first land hit (None if clear)."""
    f, t = window
    span = (t - f) % 360 + 60
    bearings = [(f - 30 + d) % 360 for d in range(0, int(span) + 1, 2)]
    dists = np.arange(start_km, max_km, step_km)
    hits: dict[float, float | None] = {}
    for b in bearings:
        pts = np.array([dest(lat, lon, b, d) for d in dists])
        land = globe.is_land(pts[:, 0], pts[:, 1])
        idx = np.argmax(land) if land.any() else -1
        hits[b] = float(dists[idx]) if idx >= 0 else None
    return hits


def sectors_from_hits(hits: dict[float, float | None], order: list[float]):
    """Group contiguous blocked bearings into sectors, splitting where the hit distance jumps
    (a distant island next to the local shore must not merge into one sector)."""
    sectors, cur = [], None
    for b in order:
        d = hits[b]
        if d is not None:
            if cur is not None and (d > 3 * cur["dists"][-1] or cur["dists"][-1] > 3 * d) and abs(d - cur["dists"][-1]) > 10:
                sectors.append(cur); cur = None
            if cur is None: cur = {"bearings": [b], "dists": [d]}
            else: cur["bearings"].append(b); cur["dists"].append(d)
        elif cur is not None:
            sectors.append(cur); cur = None
    if cur is not None: sectors.append(cur)
    out = []
    for s in sectors:
        width = 2 * len(s["bearings"]); dmed = float(np.median(s["dists"]))
        if dmed < 4: continue   # the spot's own shoreline / adjacent beach, not a swell shadow
        if width < 6: continue  # single-ray specks
        att = 0.95 if width >= 40 else 0.85 if width >= 20 else 0.6
        if dmed > 120: att *= 0.75  # far obstacles: diffraction/refraction fill in
        mid = s["bearings"][len(s["bearings"]) // 2]
        hp = dest(lat_g, lon_g, mid, dmed)
        by = min(LANDMARKS, key=lambda k: haversine_km(hp[0], hp[1], *LANDMARKS[k]))
        if haversine_km(hp[0], hp[1], *LANDMARKS[by]) > 60: by = "mainland coast"
        sec = {"from_deg": float(s["bearings"][0]), "to_deg": float(s["bearings"][-1]), "attenuation": round(att, 2), "by": by, "distance_km": round(dmed)}
        if width < 30: sec["min_period_s"] = 12  # narrow islands: long-period swell wraps around
        out.append(sec)
    return out


def open_sea_arc(hits: dict[float, float | None], order: list[float], facing: float, local_km: float = 4.0):
    """Longest contiguous run of bearings (in `order`) that are not blocked by land within `local_km`,
    i.e. the arc the spot is genuinely exposed to. Returns (from_deg, to_deg) or None."""
    runs, cur = [], []
    for b in order:
        d = hits[b]
        if d is None or d >= local_km: cur.append(b)
        else:
            if cur: runs.append(cur); cur = []
    if cur: runs.append(cur)
    if not runs: return None
    def contains_facing(r): return any(abs(((b - facing + 180) % 360) - 180) <= 1.0 for b in r)
    best = next((r for r in runs if contains_facing(r)), None) or max(runs, key=len)
    return (best[0], best[-1])


def geocode(session: requests.Session, q: str):
    r = session.get("https://nominatim.openstreetmap.org/search", params={"q": q, "format": "json", "limit": 1}, timeout=30)
    r.raise_for_status(); j = r.json()
    return {"lat": float(j[0]["lat"]), "lon": float(j[0]["lon"]), "type": j[0].get("type"), "name": j[0].get("display_name")} if j else None


def main(argv=None) -> int:
    global lat_g, lon_g
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true", help="rewrite data/spots.json with computed facing/shadows and note verification")
    ap.add_argument("--no-geocode", action="store_true")
    a = ap.parse_args(argv)

    doc = json.loads((DATA_DIR / "spots.json").read_text())
    session = requests.Session(); session.headers["User-Agent"] = USER_AGENT + " (contact: reed@vibezsunglasses.com)"
    report = []
    print(f"{'spot':<28} {'geocode':>8} {'face hand':>9} {'face calc':>9} {'diff':>5} {'land1k':>6}  {'sample':>7}  shadows (hand -> computed)")
    for s in doc["spots"]:
        lat, lon = s["location"]["lat"], s["location"]["lon"]; lat_g, lon_g = lat, lon
        g = None
        if not a.no_geocode:
            try: g = geocode(session, GEOCODE_QUERIES.get(s["id"], s["name"])); time.sleep(1.1)
            except Exception as e: g = {"error": str(e)}
        gdist = haversine_km(lat, lon, g["lat"], g["lon"]) if g and "lat" in g else None
        facing_calc, land_frac = computed_facing(lat, lon)
        face_for_rays = facing_calc if facing_calc is not None else s["facing_deg"]
        win = (s["swell"]["window"]["from_deg"], s["swell"]["window"]["to_deg"])
        hits = raycast_shadows(lat, lon, win)
        shadows = sectors_from_hits(hits, list(hits.keys()))
        open_arc = open_sea_arc(hits, list(hits.keys()), face_for_rays)
        sp = s["offshore_sample_point"]
        sp_land = bool(globe.is_land(sp["lat"], sp["lon"]))
        # distance from sample point to nearest land (coarse: rings)
        sp_clear = min((r for r in (1, 2, 3, 5, 8, 12) if any(globe.is_land(*dest(sp["lat"], sp["lon"], b, r)) for b in range(0, 360, 15))), default=None)
        diff = None if facing_calc is None else round(((facing_calc - s["facing_deg"] + 180) % 360) - 180)
        row = {"id": s["id"], "geocode": g, "geocode_km": None if gdist is None else round(gdist, 2),
               "facing_hand": s["facing_deg"], "facing_calc": None if facing_calc is None else round(facing_calc),
               "facing_diff": diff, "land_fraction_1km": round(land_frac, 2),
               "sample_point_on_land": sp_land, "sample_point_nearest_land_km": sp_clear,
               "shadows_hand": s.get("shadow_sectors", []), "shadows_calc": shadows,
               "window_hand": [s["swell"]["window"]["from_deg"], s["swell"]["window"]["to_deg"]], "open_sea_arc": open_arc}
        report.append(row)
        hand = ", ".join(f"{x['from_deg']:.0f}-{x['to_deg']:.0f} {x['by']}" for x in row["shadows_hand"]) or "-"
        calc = ", ".join(f"{x['from_deg']:.0f}-{x['to_deg']:.0f} {x['by']}({x['attenuation']}@{x['distance_km']}km)" for x in shadows) or "-"
        print(f"{s['id']:<28} {('%.1f km' % gdist) if gdist is not None else 'n/a':>8} {s['facing_deg']:>9} {row['facing_calc'] if row['facing_calc'] is not None else 'n/a':>9} {diff if diff is not None else 'n/a':>5}  "
              f"{land_frac:>6.2f} {'LAND!' if sp_land else (str(sp_clear) + ' km' if sp_clear else '>12km'):>7}  {hand}  ->  {calc}")
        print(f"{'':<28} window hand {row['window_hand'][0]:.0f}-{row['window_hand'][1]:.0f}  open sea {open_arc[0]:.0f}-{open_arc[1]:.0f}" if open_arc else f"{'':<28} window hand {row['window_hand'][0]:.0f}-{row['window_hand'][1]:.0f}  open sea: none")

    SCRATCH_DIR.mkdir(parents=True, exist_ok=True)
    (SCRATCH_DIR / "spot-verification.json").write_text(json.dumps(report, indent=1))
    print(f"\nreport: {SCRATCH_DIR / 'spot-verification.json'}")

    if a.apply:
        by_id = {r["id"]: r for r in report}
        for s in doc["spots"]:
            r = by_id[s["id"]]; v = {"date": "2026-09-21", "method": "verify_spots.py: Nominatim + GLOBE 1 km land mask"}
            g = r["geocode"]
            if g and "lat" in g and r["geocode_km"] is not None and r["geocode_km"] <= 3.0 and g.get("type") in ("beach", "lighthouse", "bay", "coastline", "nature_reserve", "park"):
                s["location"] = {"lat": round(g["lat"], 4), "lon": round(g["lon"], 4)}; v["location"] = f"OSM {g['type']} node, was {r['geocode_km']} km away"
            else:
                v["location"] = f"kept hand value (geocode {r['geocode_km']} km, type {g.get('type') if g else None})"
            arc = r["open_sea_arc"]
            arc_mid = None if not arc else ((arc[0] + ((arc[1] - arc[0]) % 360) / 2) % 360)
            agree = arc_mid is not None and abs(((r["facing_calc"] - arc_mid + 180) % 360) - 180) <= 20 if r["facing_calc"] is not None else False
            est = None if not agree else (r["facing_calc"] + ((arc_mid - r["facing_calc"] + 180) % 360 - 180) / 2) % 360
            est_diff = None if est is None else ((est - r["facing_hand"] + 180) % 360) - 180
            if est is not None and abs(est_diff) > 15 and s["break_type"] == "beach" and r["land_fraction_1km"] >= 0.35:
                s["facing_deg"] = float(round(est / 5) * 5); v["facing"] = f"adopted {s['facing_deg']:.0f}: ring-mean {r['facing_calc']} and open-arc mid {arc_mid:.0f} agree (hand {r['facing_hand']})"
                # keep ideal/window/offshore consistent with the new facing
                delta = s["facing_deg"] - r["facing_hand"]
                s["swell"]["ideal_deg"] = (s["swell"]["ideal_deg"] + delta) % 360
                s["swell"]["window"] = {"from_deg": (s["swell"]["window"]["from_deg"] + delta) % 360, "to_deg": (s["swell"]["window"]["to_deg"] + delta) % 360}
                s["wind"]["offshore_deg"] = (s["wind"]["offshore_deg"] + delta) % 360
            elif r["facing_calc"] is not None and abs(r["facing_diff"]) > 15:
                v["facing"] = (f"kept hand value {r['facing_hand']}: estimators disagree (ring-mean {r['facing_calc']}, open-arc mid {arc_mid:.0f}) — check on a chart" if not agree
                               else f"kept hand value {r['facing_hand']}: computed {est:.0f} but {s['break_type']} / land fraction {r['land_fraction_1km']} makes the 1 km mask unreliable")
            else:
                v["facing"] = f"hand value within 15° of computed ({r['facing_calc']})"
            s["shadow_sectors"] = r["shadows_calc"]; v["shadows"] = "ray-cast from GLOBE land mask, 2° rays to 250 km"
            arc = r["open_sea_arc"]
            if arc:
                wf, wt = s["swell"]["window"]["from_deg"], s["swell"]["window"]["to_deg"]
                # clockwise offsets from the window start; clip to the open arc where it is narrower
                def off(x, base): return (x - base) % 360
                a0, a1 = arc
                new_f = wf if off(a0, wf) > off(wt, wf) else a0        # arc start inside window -> clip
                new_t = wt if off(a1, wf) > off(wt, wf) else a1        # arc end inside window -> clip
                if off(a0, wf) <= off(wt, wf) or off(a1, wf) <= off(wt, wf):
                    pass
                changed = (new_f, new_t) != (wf, wt)
                s["swell"]["window"] = {"from_deg": float(new_f), "to_deg": float(new_t)}
                # keep ideal_deg inside the (possibly clipped) window
                idl = s["swell"]["ideal_deg"]
                if off(idl, new_f) > off(new_t, new_f):
                    s["swell"]["ideal_deg"] = float(new_f if off(idl, new_f) > 180 + off(new_t, new_f) / 2 else new_t)
                fd = s["facing_deg"]
                if off(fd, new_f) > off(new_t, new_f):   # facing fell outside: widen the nearer edge to facing ±15
                    if off(fd, new_f) > 180 + off(new_t, new_f) / 2: new_f = (fd - 15) % 360
                    else: new_t = (fd + 15) % 360
                    s["swell"]["window"] = {"from_deg": float(new_f), "to_deg": float(new_t)}
                    changed = True
                v["window"] = (f"clipped to open-sea arc {a0:.0f}-{a1:.0f} (was {wf:.0f}-{wt:.0f})" if changed else f"hand window lies inside open-sea arc {a0:.0f}-{a1:.0f}")
            else:
                v["window"] = "no open-sea arc found; hand window kept"
            s["verification"] = v
        doc["_readme"] = ("Coordinates checked against OSM Nominatim, facing angles and shadow sectors computed from the GLOBE 1 km land mask "
                          "(see each spot's `verification`). Swell/wind/tide tuning numbers are still hand-entered surf knowledge, not measured.")
        (DATA_DIR / "spots.json").write_text(json.dumps(doc, indent=2) + "\n")
        print("applied to data/spots.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())

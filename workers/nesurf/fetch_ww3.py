"""
Fetch deep-water swell (height / period / direction) for the New England bounding box
from NOAA's GFS-Wave (WaveWatch III) model and write a small JSON cache.

    python -m nesurf.fetch_ww3                      # latest complete cycle, 0..168 h every 3 h
    python -m nesurf.fetch_ww3 --hours 0:48:1       # hourly for 2 days
    python -m nesurf.fetch_ww3 --cycle 2026092112   # pin a cycle (UTC, YYYYMMDDHH)
    python -m nesurf.fetch_ww3 --source aws         # skip NOMADS, use the AWS mirror + .idx byte ranges

Two transports, both free and public (verified 2026-09-21):

  nomads  https://nomads.ncep.noaa.gov/cgi-bin/filter_gfswave.pl
          Server-side variable + bounding-box subset. ~1 KB per variable per step.
          NOMADS asks clients to stay well under ~120 requests/min; we sleep between calls.

  aws     https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.YYYYMMDD/HH/wave/gridded/
          Full-grid files with a .idx sidecar. We read the .idx, byte-range only the
          messages we want (~30-60 KB each on the atlocn 0p16 grid), then clip locally.
          No rate limit, so this is the better choice for a scheduled job.

Grid: gfswave.tHHz.atlocn.0p16 — North Atlantic, 1/6 degree (~15 km). 31 x 40 cells over our box.

Output (public/cache/ww3/):
  index.json          run metadata, grid vectors, variable catalogue, list of steps
  steps/fHHH.json     one gridded step: flat row-major arrays [lat][lon], null = land
  spots.json          per-spot deep-water time series sampled at each spot's offshore point
"""
from __future__ import annotations

import argparse
import logging
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import numpy as np
import requests

from .buoys import BUOY_POSITIONS
from .common import (
    CACHE_DIR, NE_BBOX, BBox, decode_grib_messages, head_ok, load_spots,
    make_session, nearest_wet_cell, parse_hours, polite_sleep, write_json,
)

log = logging.getLogger("nesurf.ww3")

NOMADS_FILTER = "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfswave.pl"
NOMADS_BASE = "https://nomads.ncep.noaa.gov/pub/data/nccf/com/gfs/prod"
AWS_BASE = "https://noaa-gfs-bdp-pds.s3.amazonaws.com"
GRID = "atlocn.0p16"

# GRIB2 abbreviations used by NOMADS' filter (var_XXX=on) ...
NOMADS_VARS = ["HTSGW", "PERPW", "DIRPW", "WVHGT", "WVPER", "WVDIR", "SWELL", "SWPER", "SWDIR", "WIND", "WDIR"]
NOMADS_LEVELS = ["surface", "1_in_sequence", "2_in_sequence", "3_in_sequence"]
# ... and the same abbreviations as they appear in the .idx sidecar on AWS.
IDX_WANTED = set(NOMADS_VARS)

# eccodes shortName (+ level for the ordered swell partitions) -> our field name.
# Verified by decoding a live file on 2026-09-21.
FIELD_MAP: dict[tuple[str, int | None], str] = {
    ("swh", None): "hs",            # significant height, combined sea + swell (m)
    ("perpw", None): "tp",          # primary wave (peak) period (s)
    ("dirpw", None): "dp",          # primary wave direction, FROM, deg true
    ("shww", None): "wind_hs",      # wind-sea height (m)
    ("mpww", None): "wind_tp",      # wind-sea period (s)
    ("wvdir", None): "wind_dp",     # wind-sea direction
    ("shts", 1): "swell1_hs", ("mpts", 1): "swell1_tp", ("swdir", 1): "swell1_dp",
    ("shts", 2): "swell2_hs", ("mpts", 2): "swell2_tp", ("swdir", 2): "swell2_dp",
    ("shts", 3): "swell3_hs", ("mpts", 3): "swell3_tp", ("swdir", 3): "swell3_dp",
    ("ws", None): "wind_speed",     # GFS 10 m wind as seen by the wave model (m/s) — HRRR replaces this for scoring
    ("wdir", None): "wind_dir",     # FROM, deg true
}
FIELD_META = {
    "hs": {"units": "m", "long_name": "Significant wave height (sea + swell)"},
    "tp": {"units": "s", "long_name": "Primary wave period"},
    "dp": {"units": "deg", "long_name": "Primary wave direction (from)"},
    "wind_hs": {"units": "m", "long_name": "Wind-sea height"},
    "wind_tp": {"units": "s", "long_name": "Wind-sea period"},
    "wind_dp": {"units": "deg", "long_name": "Wind-sea direction (from)"},
    "swell1_hs": {"units": "m", "long_name": "Swell partition 1 height"},
    "swell1_tp": {"units": "s", "long_name": "Swell partition 1 period"},
    "swell1_dp": {"units": "deg", "long_name": "Swell partition 1 direction (from)"},
    "swell2_hs": {"units": "m", "long_name": "Swell partition 2 height"},
    "swell2_tp": {"units": "s", "long_name": "Swell partition 2 period"},
    "swell2_dp": {"units": "deg", "long_name": "Swell partition 2 direction (from)"},
    "swell3_hs": {"units": "m", "long_name": "Swell partition 3 height"},
    "swell3_tp": {"units": "s", "long_name": "Swell partition 3 period"},
    "swell3_dp": {"units": "deg", "long_name": "Swell partition 3 direction (from)"},
    "wind_speed": {"units": "m/s", "long_name": "10 m wind speed (GFS, coarse)"},
    "wind_dir": {"units": "deg", "long_name": "10 m wind direction (from)"},
}


# ---------------------------------------------------------------- cycle discovery

def cycle_paths(cycle: datetime, fhour: int) -> tuple[str, str]:
    """(directory relative to the product root, file name) for one forecast hour."""
    d = cycle.strftime("%Y%m%d")
    hh = cycle.strftime("%H")
    return f"gfs.{d}/{hh}/wave/gridded", f"gfswave.t{hh}z.{GRID}.f{fhour:03d}.grib2"


def find_latest_complete_cycle(session: requests.Session, last_hour_needed: int, now: datetime | None = None) -> datetime:
    """
    Walk back through 00/06/12/18 z cycles until the .idx for the last forecast hour we need
    exists on the AWS mirror (the .idx is written after the .grib2, so its presence means complete).
    GFS-Wave products land roughly 4-5 h after cycle time.
    """
    now = now or datetime.now(timezone.utc)
    start = now.replace(minute=0, second=0, microsecond=0)
    start = start.replace(hour=(start.hour // 6) * 6)
    for back in range(0, 8):
        cycle = start - timedelta(hours=6 * back)
        d, f = cycle_paths(cycle, last_hour_needed)
        if head_ok(session, f"{AWS_BASE}/{d}/{f}.idx"):
            return cycle
    raise RuntimeError("No complete GFS-Wave cycle found in the last 48 h on the AWS mirror")


# ---------------------------------------------------------------- transports

def fetch_nomads_subset(session: requests.Session, cycle: datetime, fhour: int, bbox: BBox) -> bytes:
    d, f = cycle_paths(cycle, fhour)
    params: list[tuple[str, str]] = [("dir", "/" + d), ("file", f)]
    params += [(f"var_{v}", "on") for v in NOMADS_VARS]
    params += [(f"lev_{l}", "on") for l in NOMADS_LEVELS]
    params += [("subregion", ""), ("toplat", str(bbox.north)), ("bottomlat", str(bbox.south)),
               ("leftlon", str(bbox.west)), ("rightlon", str(bbox.east))]
    r = session.get(NOMADS_FILTER, params=params, timeout=90)
    r.raise_for_status()
    if not r.content.startswith(b"GRIB"):
        raise RuntimeError(f"NOMADS returned non-GRIB for f{fhour:03d}: {r.content[:120]!r}")
    return r.content


def _parse_idx(text: str) -> list[tuple[int, str, str]]:
    """Each line: 'n:offset:d=YYYYMMDDHH:VAR:level:fcst:' -> (offset, VAR, level)."""
    rows = []
    for line in text.strip().splitlines():
        p = line.split(":")
        if len(p) >= 5:
            rows.append((int(p[1]), p[3], p[4]))
    return rows


def fetch_aws_ranges(session: requests.Session, cycle: datetime, fhour: int) -> bytes:
    """Read the .idx, then byte-range only the messages we want, coalescing neighbours."""
    d, f = cycle_paths(cycle, fhour)
    base = f"{AWS_BASE}/{d}/{f}"
    idx = session.get(base + ".idx", timeout=30)
    idx.raise_for_status()
    rows = _parse_idx(idx.text)
    # message i spans [offset_i, offset_{i+1}); the last one runs to EOF
    spans = []
    for i, (off, var, _lvl) in enumerate(rows):
        if var not in IDX_WANTED:
            continue
        end = rows[i + 1][0] - 1 if i + 1 < len(rows) else None
        spans.append([off, end])
    # coalesce adjacent spans into as few Range requests as possible
    merged: list[list[int | None]] = []
    for s in spans:
        if merged and merged[-1][1] is not None and merged[-1][1] + 1 == s[0]:
            merged[-1][1] = s[1]
        else:
            merged.append(list(s))
    chunks = []
    for start, end in merged:
        rng = f"bytes={start}-" if end is None else f"bytes={start}-{end}"
        r = session.get(base, headers={"Range": rng}, timeout=60)
        if r.status_code not in (200, 206):
            r.raise_for_status()
        chunks.append(r.content)
    return b"".join(chunks)


def fetch_step(session: requests.Session, source: str, cycle: datetime, fhour: int, bbox: BBox) -> bytes:
    if source == "nomads":
        return fetch_nomads_subset(session, cycle, fhour, bbox)
    if source == "aws":
        return fetch_aws_ranges(session, cycle, fhour)
    try:                                          # auto
        return fetch_nomads_subset(session, cycle, fhour, bbox)
    except Exception as e:                        # noqa: BLE001 — any transport failure -> fallback
        log.warning("NOMADS failed for f%03d (%s); falling back to AWS", fhour, e)
        return fetch_aws_ranges(session, cycle, fhour)


# ---------------------------------------------------------------- assembly

def messages_to_fields(msgs: list[dict[str, Any]]) -> tuple[np.ndarray, np.ndarray, str, dict[str, np.ndarray]]:
    fields: dict[str, np.ndarray] = {}
    lat = lon = None
    valid = None
    for m in msgs:
        lvl = m["level"] if m["typeOfLevel"] == "orderedSequenceData" else None
        name = FIELD_MAP.get((m["shortName"], lvl))
        if name is None:
            log.debug("skipping unmapped message %s/%s/%s", m["shortName"], m["typeOfLevel"], m["level"])
            continue
        if lat is None:
            lat, lon, valid = m["lat"], m["lon"], m["valid_time"]
        fields[name] = m["values"]
    if lat is None:
        raise RuntimeError("no mapped variables decoded")
    return lat, lon, valid, fields


def sample_spots(spots, lat, lon, fields) -> dict[str, dict[str, Any]]:
    """Nearest wet cell to each spot's offshore_sample_point; returns {spot_id: {field: value, ...}}."""
    wet = np.isfinite(fields["hs"])
    out = {}
    for s in spots:
        p = s["offshore_sample_point"]
        hit = nearest_wet_cell(p["lat"], p["lon"], lat, lon, wet)
        if hit is None:
            log.warning("spot %s: no wet WW3 cell within 4 rings of (%s, %s)", s["id"], p["lat"], p["lon"])
            out[s["id"]] = None
            continue
        i, j, dist = hit
        out[s["id"]] = {
            "cell": {"lat": float(lat[i]), "lon": float(lon[j]), "snap_km": round(dist, 1)},
            **{k: float(v[i, j]) for k, v in fields.items()},
        }
    return out


def run(cycle: datetime | None, hours: list[int], source: str, out_dir: Path, bbox: BBox, pause: float) -> Path:
    session = make_session()
    if cycle is None:
        cycle = find_latest_complete_cycle(session, max(hours))
    log.info("cycle %s  grid %s  hours %s..%s (%d steps)  source=%s", cycle.isoformat(), GRID, hours[0], hours[-1], len(hours), source)

    spots = load_spots()
    steps_dir = out_dir / "steps"
    steps_dir.mkdir(parents=True, exist_ok=True)

    index_steps = []
    series: dict[str, list[dict[str, Any]]] = {s["id"]: [] for s in spots}
    buoy_targets = [{"id": b, "offshore_sample_point": {"lat": la, "lon": lo}} for b, (la, lo) in BUOY_POSITIONS.items()]
    buoy_series: dict[str, list[dict[str, Any]]] = {b: [] for b in BUOY_POSITIONS}
    lat = lon = None

    for k, fh in enumerate(hours):
        raw = fetch_step(session, source, cycle, fh, bbox)
        msgs = decode_grib_messages(raw, bbox=bbox)
        lat, lon, valid, fields = messages_to_fields(msgs)
        # wave model directions are "from"; sanity-check the arrays are on our clipped grid
        assert fields["hs"].shape == (len(lat), len(lon)), fields["hs"].shape

        n = write_json(steps_dir / f"f{fh:03d}.json", {
            "hour": fh, "valid_time": valid,
            "fields": {name: arr.ravel() for name, arr in fields.items()},
        }, ndigits=2)
        index_steps.append({"hour": fh, "valid_time": valid, "file": f"steps/f{fh:03d}.json"})

        for sid, sample in sample_spots(spots, lat, lon, fields).items():
            series[sid].append({"hour": fh, "valid_time": valid, **(sample or {})})
        for bid, sample in sample_spots(buoy_targets, lat, lon, fields).items():
            buoy_series[bid].append({"hour": fh, "valid_time": valid, **(sample or {})})

        log.info("f%03d %s  %5d B raw -> %6d B json  hs max %.2f m", fh, valid, len(raw), n, np.nanmax(fields["hs"]))
        if k < len(hours) - 1:
            polite_sleep(pause if source != "aws" else 0.0)

    generated = datetime.now(timezone.utc).isoformat(timespec="seconds")
    write_json(out_dir / "index.json", {
        "model": "GFS-Wave (WAVEWATCH III)", "grid": GRID, "source": source,
        "cycle": cycle.strftime("%Y-%m-%dT%H:00:00Z"), "generated_at": generated,
        "bbox": bbox.as_dict(),
        "lat": lat, "lon": lon, "shape": [len(lat), len(lon)], "order": "row-major [lat][lon], lat ascending, lon ascending",
        "direction_convention": "degrees true, direction waves/wind come FROM",
        "fields": FIELD_META, "steps": index_steps,
    }, ndigits=4)

    write_json(out_dir / "spots.json", {
        "cycle": cycle.strftime("%Y-%m-%dT%H:00:00Z"), "generated_at": generated, "grid": GRID,
        "fields": FIELD_META,
        "spots": [{"id": s["id"], "name": s["name"], "offshore_sample_point": s["offshore_sample_point"],
                   "series": series[s["id"]]} for s in spots],
        "buoys": [{"id": b, "position": {"lat": la, "lon": lo}, "series": buoy_series[b]} for b, (la, lo) in BUOY_POSITIONS.items()],
    }, ndigits=2)
    log.info("wrote %s (%d steps) and spots.json (%d spots)", out_dir / "index.json", len(index_steps), len(spots))
    return out_dir


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cycle", help="UTC cycle YYYYMMDDHH (default: latest complete)")
    ap.add_argument("--hours", default="0:168:3", help="start:stop:step or comma list (default 0:168:3)")
    ap.add_argument("--source", choices=["auto", "nomads", "aws"], default="auto")
    ap.add_argument("--out", default=str(CACHE_DIR / "ww3"))
    ap.add_argument("--pause", type=float, default=0.75, help="seconds between NOMADS requests")
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if a.verbose else logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    cycle = datetime.strptime(a.cycle, "%Y%m%d%H").replace(tzinfo=timezone.utc) if a.cycle else None
    hours = parse_hours(a.hours)
    if any(h > 120 and h % 3 for h in hours):
        ap.error("GFS-Wave is hourly to f120 and 3-hourly after; hours > 120 must be multiples of 3")
    run(cycle, hours, a.source, Path(a.out), NE_BBOX, a.pause)
    return 0


if __name__ == "__main__":
    sys.exit(main())

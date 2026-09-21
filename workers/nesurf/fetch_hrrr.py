"""
Fetch HRRR 10 m wind (u, v) and surface gust for the New England bounding box and
write a small JSON cache on a regular lat/lon grid.

    python -m nesurf.fetch_hrrr                     # latest complete 00/06/12/18z cycle, f00..f48 hourly
    python -m nesurf.fetch_hrrr --hours 0:18:1      # short range (any hourly cycle qualifies)
    python -m nesurf.fetch_hrrr --cycle 2026092112  # pin a cycle (UTC, YYYYMMDDHH)
    python -m nesurf.fetch_hrrr --source aws        # skip NOMADS, use the AWS mirror + .idx byte ranges
    python -m nesurf.fetch_hrrr --res 0.05          # coarser output grid (default 0.03 deg)

Two transports, both free and public (verified 2026-09-21):

  nomads  https://nomads.ncep.noaa.gov/cgi-bin/filter_hrrr_2d.pl
          ?dir=%2Fhrrr.YYYYMMDD%2Fconus&file=hrrr.tHHz.wrfsfcfFF.grib2
          &var_UGRD=on&var_VGRD=on&var_GUST=on&lev_10_m_above_ground=on&lev_surface=on
          &subregion=&toplat=45&leftlon=-72.5&rightlon=-66&bottomlat=40
          Server-side variable + bounding-box subset, ~160 KB per forecast hour
          (3 messages, 226 x 231 Lambert cells covering lat 38.6..46.3, lon -74.2..-63.8).

  aws     https://noaa-hrrr-bdp-pds.s3.amazonaws.com/hrrr.YYYYMMDD/conus/hrrr.tHHz.wrfsfcfFF.grib2
          Full CONUS files (~150 MB) with a .idx sidecar. We read the .idx, byte-range only
          UGRD/VGRD "10 m above ground" and GUST "surface" (~1.2-2.4 MB each), then clip.
          The .idx line format is  77:49904851:d=2026092112:UGRD:10 m above ground:1 hour fcst:

Cycles: hourly. 00/06/12/18z run to f48, the others to f18. Products land ~1.5-2 h after
cycle time; the latest cycle whose last needed hour has a .idx on AWS is used.

Grid: HRRR is a 3 km Lambert-conformal grid, NOT lat/lon, so common.decode_grib_messages
(which relies on distinctLatitudes) is not used. This module reads the per-point
latitudes/longitudes arrays from eccodes, keeps the points inside the bbox (+ a small pad),
and resamples by nearest neighbour onto a regular ~0.03 deg lat/lon grid over the bbox.
Sanity checks on a live file (2026-09-21 12z f01): gridType=lambert, 10u -6.9..7.3 m/s,
10v -13.6..3.6 m/s, gust 0.6..16.1 m/s, Boston (42.36, -71.06) has a cell 0.3 km away.

Output (public/cache/hrrr/):
  index.json          run metadata, grid vectors, field catalogue, list of steps
  steps/fHH.json      one gridded step: flat row-major arrays [lat][lon] for u10, v10, gust; null = no data
  spots.json          per-spot 10 m wind time series (speed, direction FROM, gust) sampled at
                      wind.hrrr_sample_point if the spot has one, else its location
"""
from __future__ import annotations

import argparse
import logging
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import numpy as np
import requests

from .common import (
    CACHE_DIR, NE_BBOX, BBox, haversine_km, head_ok, load_spots,
    make_session, parse_hours, polite_sleep, write_json,
)

log = logging.getLogger("nesurf.hrrr")

NOMADS_FILTER = "https://nomads.ncep.noaa.gov/cgi-bin/filter_hrrr_2d.pl"
AWS_BASE = "https://noaa-hrrr-bdp-pds.s3.amazonaws.com"

# (VAR, level) as they appear in the .idx sidecar and in NOMADS' filter parameters
IDX_WANTED: set[tuple[str, str]] = {
    ("UGRD", "10 m above ground"),
    ("VGRD", "10 m above ground"),
    ("GUST", "surface"),
}
NOMADS_VARS = ["UGRD", "VGRD", "GUST"]
NOMADS_LEVELS = ["10_m_above_ground", "surface"]

# eccodes (shortName, typeOfLevel) -> our field name. Verified on a live file 2026-09-21.
FIELD_MAP: dict[tuple[str, str], str] = {
    ("10u", "heightAboveGround"): "u10",
    ("10v", "heightAboveGround"): "v10",
    ("gust", "surface"): "gust",
}
FIELD_META = {
    "u10": {"units": "m/s", "long_name": "10 m wind, eastward component"},
    "v10": {"units": "m/s", "long_name": "10 m wind, northward component"},
    "gust": {"units": "m/s", "long_name": "Surface wind gust"},
}

LONG_CYCLES = (0, 6, 12, 18)     # run to f48; all other hourly cycles stop at f18
SHORT_MAX_HOUR = 18
LONG_MAX_HOUR = 48
BBOX_PAD_DEG = 0.1               # keep a rim of native cells outside the bbox so edge targets have neighbours
MAX_SNAP_KM = 6.0                # a target farther than this from any native cell is null (HRRR spacing is 3 km)


# ---------------------------------------------------------------- cycle discovery

def cycle_paths(cycle: datetime, fhour: int) -> tuple[str, str]:
    """(directory relative to the product root, file name) for one forecast hour."""
    return f"hrrr.{cycle.strftime('%Y%m%d')}/conus", f"hrrr.t{cycle.strftime('%H')}z.wrfsfcf{fhour:02d}.grib2"


def find_latest_complete_cycle(session: requests.Session, last_hour_needed: int, now: datetime | None = None) -> datetime:
    """
    Walk back hour by hour until the .idx for the last forecast hour we need exists on the
    AWS mirror. Cycles other than 00/06/12/18z only run to f18, so they are skipped when a
    longer range is requested.
    """
    now = now or datetime.now(timezone.utc)
    start = now.replace(minute=0, second=0, microsecond=0)
    for back in range(0, 30):
        cycle = start - timedelta(hours=back)
        if last_hour_needed > SHORT_MAX_HOUR and cycle.hour not in LONG_CYCLES:
            continue
        d, f = cycle_paths(cycle, last_hour_needed)
        if head_ok(session, f"{AWS_BASE}/{d}/{f}.idx"):
            return cycle
    raise RuntimeError(f"No HRRR cycle with f{last_hour_needed:02d} found in the last 30 h on the AWS mirror")


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
        raise RuntimeError(f"NOMADS returned non-GRIB for f{fhour:02d}: {r.content[:120]!r}")
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
    """Read the .idx, then byte-range only the three messages we want (coalescing neighbours)."""
    d, f = cycle_paths(cycle, fhour)
    base = f"{AWS_BASE}/{d}/{f}"
    idx = session.get(base + ".idx", timeout=30)
    idx.raise_for_status()
    rows = _parse_idx(idx.text)
    spans: list[list[int | None]] = []
    for i, (off, var, lvl) in enumerate(rows):
        if (var, lvl) not in IDX_WANTED:
            continue
        end = rows[i + 1][0] - 1 if i + 1 < len(rows) else None
        spans.append([off, end])
    if len(spans) != len(IDX_WANTED):
        raise RuntimeError(f"expected {len(IDX_WANTED)} wanted messages in {base}.idx, found {len(spans)}")
    merged: list[list[int | None]] = []
    for s in spans:
        if merged and merged[-1][1] is not None and merged[-1][1] + 1 == s[0]:
            merged[-1][1] = s[1]
        else:
            merged.append(list(s))
    chunks = []
    for start, end in merged:
        rng = f"bytes={start}-" if end is None else f"bytes={start}-{end}"
        r = session.get(base, headers={"Range": rng}, timeout=120)
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
        log.warning("NOMADS failed for f%02d (%s); falling back to AWS", fhour, e)
        return fetch_aws_ranges(session, cycle, fhour)


# ---------------------------------------------------------------- lambert-grid decode

def decode_hrrr_messages(data: bytes, bbox: BBox, pad: float = BBOX_PAD_DEG) -> list[dict[str, Any]]:
    """
    Decode every message of an HRRR GRIB2 byte string as unstructured points.

    Returns one dict per message:
      shortName, typeOfLevel, level, units, valid_time (UTC ISO), forecast_hour,
      lat, lon, values — 1-D arrays of the native cells inside bbox (+pad), lon in -180..180,
      NaN = missing.

    Works for any gridType because it reads the per-point "latitudes"/"longitudes" keys
    rather than distinctLatitudes (which only make sense on regular lat/lon grids).
    """
    import eccodes as ec  # imported lazily so `--help` works without the wheel

    out: list[dict[str, Any]] = []
    with tempfile.NamedTemporaryFile(suffix=".grib2", delete=False) as tmp:
        tmp.write(data)
        path = tmp.name
    try:
        with open(path, "rb") as fh:
            while True:
                gid = ec.codes_grib_new_from_file(fh)
                if gid is None:
                    break
                try:
                    out.append(_decode_one_points(ec, gid, bbox, pad))
                finally:
                    ec.codes_release(gid)
    finally:
        os.unlink(path)
    return out


def _decode_one_points(ec, gid, bbox: BBox, pad: float) -> dict[str, Any]:
    lats = np.array(ec.codes_get_array(gid, "latitudes"), dtype=float)
    lons = np.array(ec.codes_get_array(gid, "longitudes"), dtype=float)
    vals = np.array(ec.codes_get_values(gid), dtype=float)
    missing = ec.codes_get(gid, "missingValue")
    vals[vals == missing] = np.nan
    lons = np.where(lons > 180, lons - 360, lons)
    keep = ((lats >= bbox.south - pad) & (lats <= bbox.north + pad)
            & (lons >= bbox.west - pad) & (lons <= bbox.east + pad))
    vd = str(ec.codes_get(gid, "validityDate"))          # YYYYMMDD
    vt = int(ec.codes_get(gid, "validityTime"))           # HHMM
    return {
        "shortName": ec.codes_get(gid, "shortName"),
        "typeOfLevel": ec.codes_get(gid, "typeOfLevel"),
        "level": int(ec.codes_get(gid, "level")),
        "units": ec.codes_get(gid, "units"),
        "gridType": ec.codes_get(gid, "gridType"),
        "valid_time": f"{vd[:4]}-{vd[4:6]}-{vd[6:8]}T{vt // 100:02d}:{vt % 100:02d}:00Z",
        "forecast_hour": int(ec.codes_get(gid, "forecastTime")),
        "lat": lats[keep],
        "lon": lons[keep],
        "values": vals[keep],
    }


# ---------------------------------------------------------------- resampling

def regular_grid(bbox: BBox, res: float) -> tuple[np.ndarray, np.ndarray]:
    """Regular lat/lon vectors spanning the bbox exactly, spacing as close to `res` as fits."""
    nlat = int(round((bbox.north - bbox.south) / res)) + 1
    nlon = int(round((bbox.east - bbox.west) / res)) + 1
    return np.linspace(bbox.south, bbox.north, nlat), np.linspace(bbox.west, bbox.east, nlon)


def nearest_index(src_lat: np.ndarray, src_lon: np.ndarray, tgt_lat: np.ndarray, tgt_lon: np.ndarray,
                  chunk: int = 512) -> tuple[np.ndarray, np.ndarray]:
    """
    For each target point, the index of the nearest source point and its distance in km.
    Brute force in chunks (no scipy); equirectangular metric scaled by cos(lat) which is
    plenty for a 3 km grid over a 5 x 6.5 degree box.
    """
    coslat = np.cos(np.radians(src_lat))
    sx = src_lon * coslat
    sy = src_lat
    idx = np.empty(len(tgt_lat), dtype=np.int64)
    for s in range(0, len(tgt_lat), chunk):
        tl = tgt_lat[s:s + chunk]
        tx = (tgt_lon[s:s + chunk] * np.cos(np.radians(tl)))[:, None]
        ty = tl[:, None]
        d2 = (sx[None, :] - tx) ** 2 + (sy[None, :] - ty) ** 2
        idx[s:s + chunk] = d2.argmin(axis=1)
    km = np.array([haversine_km(float(a), float(b), float(src_lat[k]), float(src_lon[k]))
                   for a, b, k in zip(tgt_lat, tgt_lon, idx)])
    return idx, km


class Resampler:
    """Nearest-neighbour map from the native HRRR points onto the regular grid, built once per run."""

    def __init__(self, bbox: BBox, res: float):
        self.lat, self.lon = regular_grid(bbox, res)
        glat, glon = np.meshgrid(self.lat, self.lon, indexing="ij")
        self._tgt_lat, self._tgt_lon = glat.ravel(), glon.ravel()
        self._key: tuple | None = None
        self._idx: np.ndarray | None = None
        self._ok: np.ndarray | None = None

    def _ensure(self, src_lat: np.ndarray, src_lon: np.ndarray) -> None:
        key = (len(src_lat), float(src_lat[0]), float(src_lon[0]), float(src_lat[-1]), float(src_lon[-1]))
        if key == self._key:
            return
        idx, km = nearest_index(src_lat, src_lon, self._tgt_lat, self._tgt_lon)
        self._key, self._idx, self._ok = key, idx, km <= MAX_SNAP_KM
        log.info("resampler: %d native cells -> %d x %d grid, max snap %.2f km, %d targets unfilled",
                 len(src_lat), len(self.lat), len(self.lon), km.max(), int((~self._ok).sum()))

    def apply(self, src_lat: np.ndarray, src_lon: np.ndarray, values: np.ndarray) -> np.ndarray:
        self._ensure(src_lat, src_lon)
        out = values[self._idx]
        out[~self._ok] = np.nan
        return out.reshape(len(self.lat), len(self.lon))


# ---------------------------------------------------------------- assembly

def messages_to_fields(msgs: list[dict[str, Any]]) -> tuple[np.ndarray, np.ndarray, str, dict[str, np.ndarray]]:
    fields: dict[str, np.ndarray] = {}
    lat = lon = None
    valid = None
    for m in msgs:
        name = FIELD_MAP.get((m["shortName"], m["typeOfLevel"]))
        if name is None:
            log.debug("skipping unmapped message %s/%s/%s", m["shortName"], m["typeOfLevel"], m["level"])
            continue
        if lat is None:
            lat, lon, valid = m["lat"], m["lon"], m["valid_time"]
        elif len(m["lat"]) != len(lat):
            raise RuntimeError(f"message {name} is on a different grid ({len(m['lat'])} vs {len(lat)} cells)")
        fields[name] = m["values"]
    missing = set(FIELD_META) - set(fields)
    if lat is None or missing:
        raise RuntimeError(f"fields not decoded: {sorted(missing) or 'all'}")
    return lat, lon, valid, fields


def wind_speed_dir(u: float, v: float) -> tuple[float, float]:
    """Speed (m/s) and meteorological direction the wind blows FROM (deg true)."""
    speed = float(np.hypot(u, v))
    d = (270.0 - np.degrees(np.arctan2(v, u))) % 360.0
    return speed, float(d)


def spot_sample_points(spots: list[dict[str, Any]]) -> dict[str, dict[str, float]]:
    out = {}
    for s in spots:
        p = (s.get("wind") or {}).get("hrrr_sample_point") or s["location"]
        out[s["id"]] = {"lat": float(p["lat"]), "lon": float(p["lon"])}
    return out


def sample_spots(points: dict[str, dict[str, float]], lat: np.ndarray, lon: np.ndarray,
                 fields: dict[str, np.ndarray], cache: dict[str, tuple[int, float]]) -> dict[str, dict[str, Any]]:
    """Nearest native HRRR cell to each spot's sample point (index cached across steps)."""
    out = {}
    for sid, p in points.items():
        if sid not in cache:
            idx, km = nearest_index(lat, lon, np.array([p["lat"]]), np.array([p["lon"]]))
            cache[sid] = (int(idx[0]), float(km[0]))
        k, km = cache[sid]
        u, v, g = float(fields["u10"][k]), float(fields["v10"][k]), float(fields["gust"][k])
        if km > MAX_SNAP_KM or not (np.isfinite(u) and np.isfinite(v)):
            out[sid] = {"speed_ms": None, "dir_from_deg": None, "gust_ms": None}
            continue
        speed, d = wind_speed_dir(u, v)
        out[sid] = {"speed_ms": round(speed, 1), "dir_from_deg": round(d, 0),
                    "gust_ms": round(g, 1) if np.isfinite(g) else None}
    return out


def paint_mask(lats, lons, fringe_cells: int = 2) -> list[int]:
    """Flat row-major [lat][lon] mask: 1 where the cell is water or within `fringe_cells` of water."""
    from global_land_mask import globe
    LA, LO = np.meshgrid(np.asarray(lats), np.asarray(lons), indexing="ij")
    water = ~globe.is_land(LA, LO)
    out = water.copy()
    for di in range(-fringe_cells, fringe_cells + 1):
        for dj in range(-fringe_cells, fringe_cells + 1):
            out |= np.roll(np.roll(water, di, axis=0), dj, axis=1)
    return out.astype(int).ravel().tolist()


def run(cycle: datetime | None, hours: list[int], source: str, out_dir: Path, bbox: BBox,
        res: float, pause: float) -> Path:
    session = make_session()
    if cycle is None:
        cycle = find_latest_complete_cycle(session, max(hours))
    if max(hours) > (LONG_MAX_HOUR if cycle.hour in LONG_CYCLES else SHORT_MAX_HOUR):
        raise SystemExit(f"cycle {cycle:%Y%m%d%H}z only runs to f{LONG_MAX_HOUR if cycle.hour in LONG_CYCLES else SHORT_MAX_HOUR}")
    log.info("cycle %s  hours %s..%s (%d steps)  source=%s  res=%.3f deg",
             cycle.isoformat(), hours[0], hours[-1], len(hours), source, res)

    spots = load_spots()
    points = spot_sample_points(spots)
    resampler = Resampler(bbox, res)
    steps_dir = out_dir / "steps"
    steps_dir.mkdir(parents=True, exist_ok=True)

    index_steps = []
    series: dict[str, list[dict[str, Any]]] = {s["id"]: [] for s in spots}
    cell_cache: dict[str, tuple[int, float]] = {}
    native_cells = 0

    for k, fh in enumerate(hours):
        raw = fetch_step(session, source, cycle, fh, bbox)
        msgs = decode_hrrr_messages(raw, bbox)
        lat, lon, valid, fields = messages_to_fields(msgs)
        native_cells = len(lat)
        grids = {name: resampler.apply(lat, lon, arr) for name, arr in fields.items()}

        speed = np.hypot(grids["u10"], grids["v10"])
        smax = float(np.nanmax(speed))
        if not (0 <= smax <= 60):                   # HRRR 10 m wind beyond 60 m/s means a bad decode
            raise RuntimeError(f"f{fh:02d}: implausible max wind speed {smax:.1f} m/s")

        n = write_json(steps_dir / f"f{fh:02d}.json", {
            "hour": fh, "valid_time": valid,
            "fields": {name: arr.ravel() for name, arr in grids.items()},
        }, ndigits=1)
        index_steps.append({"hour": fh, "valid_time": valid, "file": f"steps/f{fh:02d}.json"})

        for sid, sample in sample_spots(points, lat, lon, fields, cell_cache).items():
            series[sid].append({"hour": fh, "valid_time": valid, **sample})

        log.info("f%02d %s  %7d B raw -> %7d B json  speed max %.1f m/s  gust max %.1f m/s",
                 fh, valid, len(raw), n, smax, float(np.nanmax(grids["gust"])))
        if k < len(hours) - 1:
            polite_sleep(pause if source != "aws" else 0.0)

    generated = datetime.now(timezone.utc).isoformat(timespec="seconds")
    write_json(out_dir / "index.json", {
        "model": "HRRR", "grid": "conus 3 km Lambert, resampled nearest-neighbour to regular lat/lon",
        "source": source, "cycle": cycle.strftime("%Y-%m-%dT%H:00:00Z"), "generated_at": generated,
        "bbox": bbox.as_dict(), "res_deg": res, "native_cells": native_cells,
        "lat": resampler.lat, "lon": resampler.lon, "shape": [len(resampler.lat), len(resampler.lon)],
        "paint_mask": paint_mask(resampler.lat, resampler.lon), "paint_mask_note": "1 = water or within ~6 km of water (from GLOBE 1 km land mask); the UI hides the wind raster elsewhere",
        "order": "row-major [lat][lon]",
        "direction_convention": "degrees true, direction wind comes FROM (spots.json); u/v are eastward/northward components",
        "fields": FIELD_META, "steps": index_steps,
    }, ndigits=4)

    write_json(out_dir / "spots.json", {
        "cycle": cycle.strftime("%Y-%m-%dT%H:00:00Z"), "generated_at": generated, "model": "HRRR",
        "units": {"speed_ms": "m/s", "gust_ms": "m/s", "dir_from_deg": "deg true, FROM"},
        "spots": [{
            "id": s["id"], "name": s["name"],
            "sample": {**points[s["id"]], "snap_km": round(cell_cache[s["id"]][1], 2)},
            "series": series[s["id"]],
        } for s in spots],
    }, ndigits=3)   # series values are pre-rounded to 0.1; 3 digits keeps the sample point exact
    log.info("wrote %s (%d steps) and spots.json (%d spots)", out_dir / "index.json", len(index_steps), len(spots))
    return out_dir


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cycle", help="UTC cycle YYYYMMDDHH (default: latest complete)")
    ap.add_argument("--hours", default="0:48:1", help="start:stop:step or comma list (default 0:48:1)")
    ap.add_argument("--source", choices=["auto", "nomads", "aws"], default="auto")
    ap.add_argument("--res", type=float, default=0.03, help="output grid spacing in degrees (default 0.03)")
    ap.add_argument("--out", default=str(CACHE_DIR / "hrrr"))
    ap.add_argument("--pause", type=float, default=0.75, help="seconds between NOMADS requests")
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if a.verbose else logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    cycle = datetime.strptime(a.cycle, "%Y%m%d%H").replace(tzinfo=timezone.utc) if a.cycle else None
    hours = parse_hours(a.hours) if ":" not in a.hours or len(a.hours.split(":")) == 3 else parse_hours(a.hours + ":1")
    if max(hours) > LONG_MAX_HOUR:
        ap.error(f"HRRR runs to f{LONG_MAX_HOUR} at most")
    run(cycle, hours, a.source, Path(a.out), NE_BBOX, a.res, a.pause)
    return 0


if __name__ == "__main__":
    sys.exit(main())

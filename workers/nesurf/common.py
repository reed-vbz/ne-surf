"""
Shared plumbing for the ne-surf workers.

- region bounding box + repo paths
- a polite HTTP session with retries
- GRIB2 decoding straight through eccodes (one dict per message)
- compact JSON writers (rounded floats, NaN -> null, atomic replace)
- spot catalogue loader + "nearest wet cell" sampling
"""
from __future__ import annotations

import json
import math
import os
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# ---------------------------------------------------------------- region / paths

@dataclass(frozen=True)
class BBox:
    south: float = 40.0
    north: float = 45.0
    west: float = -72.5
    east: float = -66.0

    def contains(self, lat: float, lon: float) -> bool:
        return self.south <= lat <= self.north and self.west <= lon <= self.east

    def as_dict(self) -> dict[str, float]:
        return {"south": self.south, "north": self.north, "west": self.west, "east": self.east}


NE_BBOX = BBox()

REPO_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = REPO_ROOT / "data"
CACHE_DIR = REPO_ROOT / "public" / "cache"
SCRATCH_DIR = REPO_ROOT / "workers" / ".scratch"

USER_AGENT = os.environ.get(
    "NESURF_USER_AGENT",
    "ne-surf/0.1 (open-source New England surf forecast; github.com/ne-surf)",
)

# ---------------------------------------------------------------- http

def make_session(total_retries: int = 4, backoff: float = 1.5) -> requests.Session:
    """Session with exponential-backoff retries on the status codes NOMADS/S3 throw when busy."""
    s = requests.Session()
    retry = Retry(
        total=total_retries,
        backoff_factor=backoff,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset({"GET", "HEAD"}),
        raise_on_status=False,
    )
    s.mount("https://", HTTPAdapter(max_retries=retry))
    s.headers["User-Agent"] = USER_AGENT
    return s


def head_ok(session: requests.Session, url: str, timeout: float = 20) -> bool:
    try:
        r = session.head(url, timeout=timeout, allow_redirects=True)
        return r.status_code == 200
    except requests.RequestException:
        return False


# ---------------------------------------------------------------- grib decode

def decode_grib_messages(data: bytes, bbox: BBox | None = None) -> list[dict[str, Any]]:
    """
    Decode every message in a GRIB2 byte string.

    Returns one dict per message:
      shortName, typeOfLevel, level, units, valid_time (UTC ISO), forecast_hour,
      lat (1-D, ascending), lon (1-D, -180..180 ascending), values (2-D [lat, lon], NaN = land/missing)

    If `bbox` is given the grid is clipped to it. Uses eccodes directly so mixed level
    types (surface + "1 in sequence" swell partitions) in one file are no problem.
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
                    out.append(_decode_one(ec, gid, bbox))
                finally:
                    ec.codes_release(gid)
    finally:
        os.unlink(path)
    return out


def _decode_one(ec, gid, bbox: BBox | None) -> dict[str, Any]:
    ni = ec.codes_get(gid, "Ni")
    nj = ec.codes_get(gid, "Nj")
    lats = np.array(ec.codes_get_array(gid, "distinctLatitudes"), dtype=float)
    lons = np.array(ec.codes_get_array(gid, "distinctLongitudes"), dtype=float)
    missing = ec.codes_get(gid, "missingValue")
    vals = np.array(ec.codes_get_values(gid), dtype=float).reshape(nj, ni)
    vals[vals == missing] = np.nan

    # eccodes returns distinctLatitudes/Longitudes in SCAN order (verified 2026-09-21:
    # the NOMADS subset scans S->N, the full AWS grid scans N->S), and the values
    # array rows follow the same order. Sort both axes ascending explicitly.
    lat_order = np.argsort(lats)
    lats = lats[lat_order]
    vals = vals[lat_order, :]
    # NCEP wave grids are 0..360; move to -180..180 and sort
    lons = np.where(lons > 180, lons - 360, lons)
    lon_order = np.argsort(lons)
    lons = lons[lon_order]
    vals = vals[:, lon_order]

    if bbox is not None:
        # half-cell tolerance so float noise on the edge rows (e.g. 39.99999) is kept
        tol_lat = float(np.median(np.diff(lats))) / 2 if len(lats) > 1 else 1e-6
        tol_lon = float(np.median(np.diff(lons))) / 2 if len(lons) > 1 else 1e-6
        ii = np.where((lats >= bbox.south - tol_lat) & (lats <= bbox.north + tol_lat))[0]
        jj = np.where((lons >= bbox.west - tol_lon) & (lons <= bbox.east + tol_lon))[0]
        lats, lons = lats[ii], lons[jj]
        vals = vals[np.ix_(ii, jj)]

    vd = str(ec.codes_get(gid, "validityDate"))          # YYYYMMDD
    vt = int(ec.codes_get(gid, "validityTime"))           # HHMM
    valid_time = f"{vd[:4]}-{vd[4:6]}-{vd[6:8]}T{vt // 100:02d}:{vt % 100:02d}:00Z"

    return {
        "shortName": ec.codes_get(gid, "shortName"),
        "typeOfLevel": ec.codes_get(gid, "typeOfLevel"),
        "level": int(ec.codes_get(gid, "level")),
        "units": ec.codes_get(gid, "units"),
        "valid_time": valid_time,
        "forecast_hour": int(ec.codes_get(gid, "forecastTime")),
        "lat": lats,
        "lon": lons,
        "values": vals,
    }


# ---------------------------------------------------------------- json

def _clean(o: Any, ndigits: int):
    """Round floats, turn NaN into null, unwrap numpy."""
    if isinstance(o, dict):
        return {k: _clean(v, ndigits) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v, ndigits) for v in o]
    if isinstance(o, np.ndarray):
        return _clean(o.tolist(), ndigits)
    if isinstance(o, (np.floating, float)):
        f = float(o)
        return None if math.isnan(f) or math.isinf(f) else round(f, ndigits)
    if isinstance(o, np.integer):
        return int(o)
    return o


def write_json(path: Path, obj: Any, ndigits: int = 2) -> int:
    """Atomic, compact write. Returns bytes written."""
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(_clean(obj, ndigits), separators=(",", ":"), allow_nan=False)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text)
    os.replace(tmp, path)
    return len(text)


# ---------------------------------------------------------------- spots

def load_spots(validate: bool = True) -> list[dict[str, Any]]:
    doc = json.loads((DATA_DIR / "spots.json").read_text())
    if validate:
        import jsonschema
        schema = json.loads((DATA_DIR / "spots.schema.json").read_text())
        jsonschema.Draft202012Validator(schema).validate(doc)
    return doc["spots"]


def nearest_wet_cell(
    lat: float, lon: float, lats: np.ndarray, lons: np.ndarray, mask: np.ndarray, max_ring: int = 4
) -> tuple[int, int, float] | None:
    """
    Index of the nearest cell to (lat, lon) whose `mask` is True (i.e. has data / is ocean),
    searching outward ring by ring. Returns (i, j, distance_km) or None.
    """
    i0 = int(np.abs(lats - lat).argmin())
    j0 = int(np.abs(lons - lon).argmin())
    best = None
    for ring in range(max_ring + 1):
        for i in range(i0 - ring, i0 + ring + 1):
            for j in range(j0 - ring, j0 + ring + 1):
                if max(abs(i - i0), abs(j - j0)) != ring:
                    continue
                if 0 <= i < len(lats) and 0 <= j < len(lons) and mask[i, j]:
                    d = haversine_km(lat, lon, float(lats[i]), float(lons[j]))
                    if best is None or d < best[2]:
                        best = (i, j, d)
        if best is not None:
            return best
    return None


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def polite_sleep(seconds: float) -> None:
    if seconds > 0:
        time.sleep(seconds)


def parse_hours(spec: str) -> list[int]:
    """'0:168:3' -> [0, 3, ..., 168]; '0,6,12' -> [0, 6, 12]; '24' -> [24]."""
    if ":" in spec:
        parts = [int(p) for p in spec.split(":")]
        start, stop = parts[0], parts[1]
        step = parts[2] if len(parts) > 2 else 3
        return list(range(start, stop + 1, step))
    return [int(p) for p in spec.split(",") if p.strip()]

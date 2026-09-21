"""
Fetch NOAA CO-OPS tide predictions (hi/lo events + hourly curve) and the latest observed
water level for every tide station referenced by the spot catalogue.

    python -m nesurf.fetch_tides                   # every station in spots[].tide.station_id
    python -m nesurf.fetch_tides --stations 8452660,8458694
    python -m nesurf.fetch_tides --days 8

Source: https://api.tidesandcurrents.noaa.gov/api/prod/datagetter  (free, public, verified 2026-09-21)

  predictions, hi/lo events (works for reference AND subordinate stations):
    ?product=predictions&application=ne-surf&begin_date=YYYYMMDD&range=192&datum=MLLW
     &station=<ID>&time_zone=gmt&units=metric&interval=hilo&format=json
    -> {"predictions":[{"t":"2026-09-21 02:27","v":"0.31","type":"L"}, ...]}

  predictions, hourly curve (reference stations only):
    same with interval=h  -> {"predictions":[{"t":"2026-09-21 00:00","v":"0.453"}, ...]}  (193 points for range=192)
    Subordinate stations (e.g. 8458694 Watch Hill) answer interval=h / 30 / 6 with
      {"error": {"message":"No Predictions data was found. Please make sure the Datum input is valid."}}
    so for them the hourly series is synthesised from the hi/lo events with a cosine
    curve between consecutive extremes (series_source = "cosine_from_hilo").

  latest observed water level (stations with a live gauge only):
    ?product=water_level&application=ne-surf&date=latest&datum=MLLW&station=<ID>&time_zone=gmt&units=metric&format=json
    -> {"metadata":{...},"data":[{"t":"2026-09-21 19:00","v":"0.99","s":"0.009","f":"0,0,0,0","q":"p"}]}
    Stations without a gauge answer either
      HTTP 200 {"error": {"message":"No data was found. This product may not be offered at this station at the requested time."}}
      or HTTP 400 {"error": {"message":"There is no MLLW for the station: 8418557"}}  (8418557, 8429489)
    and latest_obs is recorded as null. Note this is independent of the R/S kind in spots.json:
    on 2026-09-21 six stations tagged "reference" there (8455083, 8448558, 8441841, 8440273,
    8418911, 8418445) had no water_level product.

Output (public/cache/tides/):
  index.json     {generated_at, datum:"MLLW", units:"m", stations:[{id, kind, file}]}
  <ID>.json      {id, kind, generated_at, begin, days, hilo:[{t, v, type}], series:[{t, v}] hourly,
                  series_source, latest_obs:{t, v}|null, range_m}
  All times ISO UTC. range_m = median |H - L| over consecutive hi/lo pairs in the window.
"""
from __future__ import annotations

import argparse
import logging
import math
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import requests

from .common import CACHE_DIR, load_spots, make_session, polite_sleep, write_json

log = logging.getLogger("nesurf.tides")

API = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"
COMMON = {"application": "ne-surf", "datum": "MLLW", "time_zone": "gmt", "units": "metric", "format": "json"}
KIND = {"reference": "R", "subordinate": "S"}


# ---------------------------------------------------------------- api

def coops_get(session: requests.Session, **params) -> dict[str, Any]:
    """One datagetter call. Returns the parsed JSON; an API-level {"error": ...} is returned, not raised."""
    r = session.get(API, params={**COMMON, **params}, timeout=45)
    try:
        doc = r.json()
    except ValueError:
        doc = None
    # CO-OPS reports "no such product here" both as 200 + {"error":...} and as 400 + {"error":...}
    # (2026-09-21: water_level on 8418557 -> 400 "There is no MLLW for the station: 8418557")
    if isinstance(doc, dict) and doc.get("error"):
        return doc
    r.raise_for_status()
    if doc is None:
        raise RuntimeError(f"non-JSON reply from CO-OPS: {r.text[:200]!r}")
    return doc


def api_error(doc: dict[str, Any]) -> str | None:
    err = doc.get("error")
    if isinstance(err, dict):
        return str(err.get("message", err))
    return str(err) if err else None


def parse_t(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc)


def iso(t: datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:00Z")


# ---------------------------------------------------------------- products

def fetch_hilo(session, station: str, begin: datetime, hours: int) -> list[dict[str, Any]]:
    doc = coops_get(session, product="predictions", begin_date=begin.strftime("%Y%m%d"), range=hours,
                    station=station, interval="hilo")
    if (e := api_error(doc)):
        raise RuntimeError(f"hilo: {e}")
    out = []
    for p in doc.get("predictions", []):
        out.append({"t": iso(parse_t(p["t"])), "v": float(p["v"]), "type": p["type"]})
    return out


def fetch_hourly(session, station: str, begin: datetime, hours: int) -> list[dict[str, Any]] | str:
    """Hourly predictions, or the API's error message string if the station has none."""
    doc = coops_get(session, product="predictions", begin_date=begin.strftime("%Y%m%d"), range=hours,
                    station=station, interval="h")
    if (e := api_error(doc)):
        return e
    return [{"t": iso(parse_t(p["t"])), "v": float(p["v"])} for p in doc.get("predictions", [])]


def fetch_latest_obs(session, station: str) -> dict[str, Any] | None:
    doc = coops_get(session, product="water_level", date="latest", station=station)
    if api_error(doc):
        log.info("%s: no water_level product (%s)", station, api_error(doc))
        return None
    data = doc.get("data") or []
    if not data:
        return None
    d = data[0]
    try:
        return {"t": iso(parse_t(d["t"])), "v": float(d["v"])}
    except (KeyError, ValueError):
        return None


# ---------------------------------------------------------------- derived

def cosine_series(hilo: list[dict[str, Any]], begin: datetime, hours: int) -> list[dict[str, Any]]:
    """
    Hourly curve synthesised from hi/lo events: between two consecutive extremes the level
    follows a half cosine (the standard approximation for subordinate stations, which CO-OPS
    itself only publishes as events). Hours before the first / after the last event are omitted.
    """
    ev = [(parse_t(h["t"].replace("T", " ")[:16]), h["v"]) for h in hilo]
    if len(ev) < 2:
        return []
    out = []
    t = begin
    end = begin + timedelta(hours=hours)
    k = 0
    while t <= end:
        while k + 1 < len(ev) - 1 and ev[k + 1][0] <= t:
            k += 1
        (t0, v0), (t1, v1) = ev[k], ev[k + 1]
        if t0 <= t <= t1:
            frac = (t - t0).total_seconds() / (t1 - t0).total_seconds()
            v = v0 + (v1 - v0) * (1 - math.cos(math.pi * frac)) / 2
            out.append({"t": iso(t), "v": round(v, 3)})
        t += timedelta(hours=1)
    return out


def typical_range(hilo: list[dict[str, Any]]) -> float | None:
    diffs = [abs(b["v"] - a["v"]) for a, b in zip(hilo, hilo[1:]) if a["type"] != b["type"]]
    if not diffs:
        return None
    diffs.sort()
    m = len(diffs) // 2
    return diffs[m] if len(diffs) % 2 else (diffs[m - 1] + diffs[m]) / 2


# ---------------------------------------------------------------- run

def stations_from_spots() -> dict[str, str]:
    """{station_id: 'R'|'S'} from the spot catalogue."""
    out: dict[str, str] = {}
    for s in load_spots():
        t = s.get("tide") or {}
        sid = t.get("station_id")
        if sid:
            out[str(sid)] = KIND.get(str(t.get("station_kind", "")).lower(), "?")
    return dict(sorted(out.items()))


def run(stations: dict[str, str], out_dir: Path, days: int, pause: float) -> Path:
    session = make_session()
    now = datetime.now(timezone.utc)
    begin = now.replace(hour=0, minute=0, second=0, microsecond=0)
    hours = days * 24
    generated = now.isoformat(timespec="seconds")
    index = []
    for k, (sid, kind) in enumerate(stations.items()):
        hilo = fetch_hilo(session, sid, begin, hours)
        polite_sleep(pause)
        series = fetch_hourly(session, sid, begin, hours)
        polite_sleep(pause)
        if isinstance(series, str):
            log.info("%s (%s): no hourly predictions (%s); synthesising from %d hi/lo events", sid, kind, series, len(hilo))
            series, source = cosine_series(hilo, begin, hours), "cosine_from_hilo"
        else:
            source = "noaa_interval_h"
        latest = fetch_latest_obs(session, sid)
        rng = typical_range(hilo)
        doc = {
            "id": sid, "kind": kind, "generated_at": generated, "datum": "MLLW", "units": "m",
            "begin": iso(begin), "days": days,
            "hilo": hilo, "series": series, "series_source": source,
            "latest_obs": latest, "range_m": rng,
        }
        n = write_json(out_dir / f"{sid}.json", doc, ndigits=3)
        index.append({"id": sid, "kind": kind, "file": f"{sid}.json"})
        log.info("%s %s  hilo=%d  series=%d (%s)  latest=%s  range=%s  %d B", sid, kind, len(hilo), len(series), source,
                 latest, None if rng is None else round(rng, 2), n)
        if k < len(stations) - 1:
            polite_sleep(pause)

    write_json(out_dir / "index.json", {
        "generated_at": generated, "datum": "MLLW", "units": "m", "source": API,
        "begin": iso(begin), "days": days, "stations": index,
    }, ndigits=3)
    log.info("wrote %s (%d stations)", out_dir / "index.json", len(index))
    return out_dir


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--stations", help="comma list of CO-OPS ids, optionally id:R or id:S (default: union of spots[].tide)")
    ap.add_argument("--days", type=int, default=8, help="days of predictions from 00Z today (default 8)")
    ap.add_argument("--out", default=str(CACHE_DIR / "tides"))
    ap.add_argument("--pause", type=float, default=0.4, help="seconds between CO-OPS calls")
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if a.verbose else logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    if a.stations:
        known = stations_from_spots()
        stations = {}
        for tok in a.stations.split(","):
            sid, _, kind = tok.strip().partition(":")
            if sid:
                stations[sid] = kind.upper() if kind else known.get(sid, "?")
    else:
        stations = stations_from_spots()
    run(stations, Path(a.out), a.days, a.pause)
    return 0


if __name__ == "__main__":
    sys.exit(main())

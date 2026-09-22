"""
Fetch the latest NDBC buoy observations (waves, wind, water temperature, spectral swell /
wind-sea split) for every buoy referenced by the spot catalogue and write one JSON file.

    python -m nesurf.fetch_ndbc                 # every buoy in spots[].buoys
    python -m nesurf.fetch_ndbc --buoys 44097,44008
    python -m nesurf.fetch_ndbc --history-hours 48

Sources (free, public, verified 2026-09-21):

  https://www.ndbc.noaa.gov/data/realtime2/<ID>.txt
      Standard meteorological data, ~45 days, newest row first, two '#' header lines:
        #YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE
      "MM" = missing. Times are UTC.

  https://www.ndbc.noaa.gov/data/realtime2/<ID>.spec
  https://www.ndbc.noaa.gov/data/realtime2/<ID>.data_spec   (raw spectral density m²/Hz per frequency bin → `spectrum`)
      Spectral wave summary, same layout:
        #YY  MM DD hh mm WVHT  SwH  SwP  WWH  WWP SwD WWD  STEEPNESS  APD MWD
      SwD / WWD are 16-point compass letters (e.g. ESE); converted to degrees here.

  A buoy that is off station or decommissioned returns HTTP 404 (44018, 44005 on 2026-09-21;
  the body is a plain Apache "404 Not Found" HTML page); it is recorded with status "offline".
  A buoy that is up but has had no WVHT reading for 6 h gets status "no_waves". Beware the
  newest rows: 44007 reports wind every 10 min but waves only on its :20/:50 rows, so its
  top rows show WVHT=MM while the buoy is fine; the latest-window lookup handles that.

Output (public/cache/ndbc/latest.json):
  {generated_at, buoys: {ID: {status, obs_time, wvht_m, dpd_s, apd_s, mwd_deg, wspd_ms, wdir_deg,
                              gst_ms, wtmp_c, swell: {hs_m, tp_s, dir_deg}, windsea: {...},
                              steepness, history: [{t, wvht_m, dpd_s, mwd_deg} ...]}}}
  Field values are the most recent non-missing reading within `latest-window-min` of the
  newest row (NDBC buoys report waves hourly and wind every 10 min, on different rows).
  history is chronological (oldest first) and covers the last `history-hours` of rows.
"""
from __future__ import annotations

import argparse
import logging
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import requests

from .common import CACHE_DIR, load_spots, make_session, polite_sleep, write_json

log = logging.getLogger("nesurf.ndbc")

REALTIME2 = "https://www.ndbc.noaa.gov/data/realtime2"

COMPASS_16 = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
              "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
COMPASS_DEG = {name: i * 22.5 for i, name in enumerate(COMPASS_16)}

# .txt column -> (output key, scale) ; NDBC units are already m, s, deg, m/s, degC
MET_FIELDS = {
    "WVHT": "wvht_m", "DPD": "dpd_s", "APD": "apd_s", "MWD": "mwd_deg",
    "WSPD": "wspd_ms", "WDIR": "wdir_deg", "GST": "gst_ms", "WTMP": "wtmp_c",
}


def compass_to_deg(letters: str | None) -> float | None:
    if not letters:
        return None
    return COMPASS_DEG.get(letters.strip().upper())


# ---------------------------------------------------------------- parsing

def parse_ndbc_table(text: str) -> list[dict[str, Any]]:
    """
    Parse a realtime2 whitespace table. Returns rows newest-first as dicts keyed by the
    header names (without the leading '#'), plus "t": aware UTC datetime.
    Numeric columns become float; "MM" becomes None; non-numeric tokens (compass letters,
    STEEPNESS words) stay as strings.
    """
    lines = [l for l in text.splitlines() if l.strip()]
    if not lines or not lines[0].startswith("#"):
        raise ValueError("not an NDBC realtime2 table (no header line)")
    header = lines[0].lstrip("#").split()
    rows = []
    for line in lines[1:]:
        if line.startswith("#"):
            continue   # units line
        parts = line.split()
        if len(parts) != len(header):
            continue
        rec: dict[str, Any] = {}
        for k, v in zip(header, parts):
            if v == "MM":
                rec[k] = None
            else:
                try:
                    rec[k] = float(v)
                except ValueError:
                    rec[k] = v
        try:
            rec["t"] = datetime(int(rec["YY"]), int(rec["MM"]), int(rec["DD"]), int(rec["hh"]), int(rec["mm"]),
                                tzinfo=timezone.utc)
        except (TypeError, ValueError, KeyError):
            continue
        rows.append(rec)
    rows.sort(key=lambda r: r["t"], reverse=True)
    return rows


def latest_value(rows: list[dict[str, Any]], key: str, newest: datetime, window: timedelta) -> float | None:
    """Most recent non-missing value of `key` no older than newest - window."""
    for r in rows:
        if r["t"] < newest - window:
            break
        v = r.get(key)
        if isinstance(v, float):
            return v
    return None


def iso(t: datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:00Z")


# ---------------------------------------------------------------- fetch

def fetch_text(session: requests.Session, url: str) -> str | None:
    """Body on 200, None on 404 (buoy offline). Anything else raises."""
    r = session.get(url, timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.text


def parse_data_spec(text: str) -> dict[str, Any] | None:
    """Newest row of a realtime2 .data_spec file: 'YY MM DD hh mm sep_freq  spec_1 (freq_1) spec_2 (freq_2) …' → {t, freqs, density}."""
    for line in text.splitlines():
        if not line or line.startswith("#"): continue
        parts = line.replace("(", " ").replace(")", " ").split()
        if len(parts) < 8: continue
        t = datetime(int(parts[0]), int(parts[1]), int(parts[2]), int(parts[3]), int(parts[4]), tzinfo=timezone.utc)
        vals = [float(x) for x in parts[6:]]
        density, freqs = vals[0::2], vals[1::2]
        n = min(len(density), len(freqs))
        return {"t": t, "freqs": freqs[:n], "density": density[:n]}
    return None


def build_buoy(met_text: str | None, spec_text: str | None, now: datetime,
               window: timedelta, history: timedelta, wave_stale: timedelta, data_spec_text: str | None = None) -> dict[str, Any]:
    if met_text is None:
        return {"status": "offline"}
    met = parse_ndbc_table(met_text)
    if not met:
        return {"status": "offline", "note": "empty .txt"}
    newest = met[0]["t"]
    rec: dict[str, Any] = {"status": "ok", "obs_time": iso(newest), "age_min": int((now - newest).total_seconds() // 60)}
    for col, key in MET_FIELDS.items():
        rec[key] = latest_value(met, col, newest, window)
    if latest_value(met, "WVHT", newest, wave_stale) is None:
        rec["status"] = "no_waves"

    rec["swell"] = rec["windsea"] = None
    rec["steepness"] = None
    if spec_text is not None:
        spec = parse_ndbc_table(spec_text)
        recent = [r for r in spec if r["t"] >= newest - window and isinstance(r.get("WVHT"), float)]
        if recent:
            s = recent[0]
            rec["spec_time"] = iso(s["t"])
            rec["swell"] = {"hs_m": s.get("SwH"), "tp_s": s.get("SwP"), "dir_deg": compass_to_deg(s.get("SwD"))}
            rec["windsea"] = {"hs_m": s.get("WWH"), "tp_s": s.get("WWP"), "dir_deg": compass_to_deg(s.get("WWD"))}
            st = s.get("STEEPNESS")
            rec["steepness"] = st if isinstance(st, str) and st.upper() != "N/A" else None

    rec["spectrum"] = None
    if data_spec_text is not None:
        ds = parse_data_spec(data_spec_text)
        if ds and ds["t"] >= newest - timedelta(hours=3):
            rec["spectrum"] = {"time": iso(ds["t"]), "freqs_hz": ds["freqs"], "density_m2_hz": ds["density"], "units": "m²/Hz per frequency bin"}

    cutoff = newest - history
    rec["history"] = [
        {"t": iso(r["t"]), "wvht_m": r.get("WVHT"), "dpd_s": r.get("DPD"), "mwd_deg": r.get("MWD")}
        for r in reversed(met) if r["t"] >= cutoff and r.get("WVHT") is not None
    ]
    return rec


def run(buoys: list[str], out_path: Path, pause: float, window_min: int, history_hours: int) -> Path:
    session = make_session()
    now = datetime.now(timezone.utc)
    window, history = timedelta(minutes=window_min), timedelta(hours=history_hours)
    wave_stale = timedelta(hours=6)
    result: dict[str, Any] = {}
    for k, bid in enumerate(buoys):
        met = fetch_text(session, f"{REALTIME2}/{bid}.txt")
        spec = fetch_text(session, f"{REALTIME2}/{bid}.spec") if met is not None else None
        dspec = fetch_text(session, f"{REALTIME2}/{bid}.data_spec") if met is not None else None
        try:
            rec = build_buoy(met, spec, now, window, history, wave_stale, dspec)
        except ValueError as e:
            log.warning("%s: %s", bid, e)
            rec = {"status": "offline", "note": str(e)}
        result[bid] = rec
        log.info("%s %-8s obs=%s wvht=%s dpd=%s mwd=%s wspd=%s wtmp=%s swell=%s hist=%d",
                 bid, rec["status"], rec.get("obs_time"), rec.get("wvht_m"), rec.get("dpd_s"), rec.get("mwd_deg"),
                 rec.get("wspd_ms"), rec.get("wtmp_c"), rec.get("swell"), len(rec.get("history", [])))
        if k < len(buoys) - 1:
            polite_sleep(pause)

    n = write_json(out_path, {
        "generated_at": now.isoformat(timespec="seconds"),
        "source": REALTIME2,
        "units": {"wvht_m": "m", "dpd_s": "s", "apd_s": "s", "mwd_deg": "deg true, FROM", "wspd_ms": "m/s",
                  "wdir_deg": "deg true, FROM", "gst_ms": "m/s", "wtmp_c": "degC"},
        "buoys": result,
    }, ndigits=2)
    log.info("wrote %s (%d B, %d buoys)", out_path, n, len(result))
    return out_path


def buoys_from_spots() -> list[str]:
    ids: set[str] = set()
    for s in load_spots():
        ids.update(str(b) for b in s.get("buoys", []))
    return sorted(ids)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--buoys", help="comma list of NDBC ids (default: union of spots[].buoys)")
    ap.add_argument("--out", default=str(CACHE_DIR / "ndbc" / "latest.json"))
    ap.add_argument("--pause", type=float, default=0.5, help="seconds between buoys")
    ap.add_argument("--latest-window-min", type=int, default=90, help="how far back from the newest row a field may come from")
    ap.add_argument("--history-hours", type=int, default=24)
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if a.verbose else logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    buoys = [b.strip() for b in a.buoys.split(",") if b.strip()] if a.buoys else buoys_from_spots()
    run(buoys, Path(a.out), a.pause, a.latest_window_min, a.history_hours)
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""
Compare GFS-Wave at each NDBC buoy with what the buoy actually measured, and write per-buoy
bias diagnostics. Applying corrections remains gated on separate partition/spot validation.

    python -m nesurf.calibrate

Reads  public/cache/ww3/spots.json  (buoys[] = model sampled at buoy positions, written by fetch_ww3)
       public/cache/ndbc/latest.json (obs + 24 h history, written by fetch_ndbc)
       public/cache/calibration/history.jsonl (previous model/obs pairs, appended to every run)
Writes public/cache/calibration/latest.json

Method: for every buoy observation within the model window (analysis + first 6 h of the run), pair it
with the model value interpolated to the observation time. Keep a rolling 14-day history of pairs so the
ratio is not one noisy sample. ratio_hs = mean(obs Hs) / mean(model Hs), clamped to 0.6..1.6, plus period
bias and a direction bias. Confidence requires enough pairs, seven independent days and improved
chronological holdout skill; these bulk diagnostics alone do not validate nearshore transfer.

This compares offshore model Hs with buoy Hs. It does not validate shoaling or local face height.
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

from .common import CACHE_DIR, write_json

log = logging.getLogger("nesurf.calibrate")


def _t(iso: str) -> datetime:
    return datetime.fromisoformat(iso.replace("Z", "+00:00"))


def interp_model(series: list[dict], when: datetime, key: str) -> float | None:
    pts = sorted([(_t(r["valid_time"]), r.get(key)) for r in series if r.get(key) is not None and np.isfinite(r[key])])
    pts = [(t, v) for t, v in pts if abs((t - when).total_seconds()) <= 3 * 3600 + 1]
    if not pts: return None
    before = [p for p in pts if p[0] <= when]; after = [p for p in pts if p[0] >= when]
    if before and after:
        (t0, v0), (t1, v1) = before[-1], after[0]
        if t1 == t0: return float(v0)
        f = (when - t0).total_seconds() / (t1 - t0).total_seconds()
        return float((v0 + ((v1 - v0 + 180) % 360 - 180) * f) % 360) if key.endswith("dp") or key == "dp" else float(v0 + (v1 - v0) * f)
    t, v = min(pts, key=lambda p: abs((p[0] - when).total_seconds()))
    return float(v) if abs((t - when).total_seconds()) <= 1.5 * 3600 else None


def heldout_skill(pairs: list[dict]) -> dict:
    """Chronological day-block holdout; never count autocorrelated rows as independent days."""
    days = sorted({p["t"][:10] for p in pairs})
    if len(days) < 7: return {"bulk_skill_improved": False, "holdout_days": 0}
    train_days = set(days[:-2]); test_days = set(days[-2:])
    train = [p for p in pairs if p["t"][:10] in train_days]
    test = [p for p in pairs if p["t"][:10] in test_days]
    ratios = [np.mean([p["obs_hs"] for p in train if p["t"][:10] == d]) / max(0.1,np.mean([p["model_hs"] for p in train if p["t"][:10] == d])) for d in train_days]
    ratio = float(np.clip(np.median(ratios),0.6,1.6))
    raw = float(np.mean([np.mean([abs(p["obs_hs"]-p["model_hs"]) for p in test if p["t"][:10] == d]) for d in test_days]))
    corrected = float(np.mean([np.mean([abs(p["obs_hs"]-p["model_hs"]*ratio) for p in test if p["t"][:10] == d]) for d in test_days]))
    return {"bulk_skill_improved": corrected < raw * 0.95, "holdout_days": len(test_days),
            "holdout_raw_mae_m": raw, "holdout_corrected_mae_m": corrected, "validated_ratio_hs": ratio}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(CACHE_DIR / "calibration"))
    ap.add_argument("--keep-days", type=int, default=14)
    ap.add_argument("--min-pairs", type=int, default=24, help="minimum pairs for bulk diagnostics, in addition to day-block holdout requirements")
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if a.verbose else logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    ww3 = json.loads((CACHE_DIR / "ww3" / "spots.json").read_text())
    ndbc = json.loads((CACHE_DIR / "ndbc" / "latest.json").read_text())
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    hist_path = out / "history.jsonl"
    history = [json.loads(l) for l in hist_path.read_text().splitlines()] if hist_path.exists() else []

    cycle = _t(ww3["cycle"]); window_end = cycle + timedelta(hours=6)
    new_pairs = []
    for b in ww3.get("buoys", []):
        obs = ndbc["buoys"].get(b["id"])
        if not obs or obs.get("status") != "ok": continue
        rows = list(obs.get("history") or [])
        if obs.get("wave_time") and obs.get("wvht_m") is not None:
            rows.append({"t": obs["wave_time"], "wvht_m": obs["wvht_m"], "dpd_s": obs.get("dpd_s"), "mwd_deg": obs.get("mwd_deg")})
        seen = set()
        for r in rows:
            if r.get("wvht_m") is None or r["t"] in seen: continue
            seen.add(r["t"]); when = _t(r["t"])
            if not (cycle <= when <= window_end): continue
            m_hs = interp_model(b["series"], when, "hs")
            if m_hs is None: continue
            new_pairs.append({"buoy": b["id"], "t": r["t"], "cycle": ww3["cycle"], "obs_hs": r["wvht_m"], "model_hs": m_hs,
                              "obs_tp": r.get("dpd_s"), "model_tp": interp_model(b["series"], when, "tp"),
                              "obs_dir": r.get("mwd_deg"), "model_dir": interp_model(b["series"], when, "dp")})
    # Count each observation once, even when it overlaps multiple model cycles.
    key = lambda p: (p["buoy"], p["t"])
    merged = {key(p): p for p in history}; merged.update({key(p): p for p in new_pairs})
    cutoff = datetime.now(timezone.utc) - timedelta(days=a.keep_days)
    pairs = [p for p in merged.values() if cutoff <= _t(p["t"]) <= datetime.now(timezone.utc) + timedelta(minutes=5) and np.isfinite(p["obs_hs"]) and np.isfinite(p["model_hs"]) and p["obs_hs"] >= 0 and p["model_hs"] > 0.1]
    hist_path.write_text("".join(json.dumps(p, separators=(",", ":")) + "\n" for p in sorted(pairs, key=lambda p: p["t"])))

    buoys = {}
    for bid in sorted({p["buoy"] for p in pairs}):
        ps = [p for p in pairs if p["buoy"] == bid]
        oh = np.array([p["obs_hs"] for p in ps]); mh = np.array([p["model_hs"] for p in ps])
        ratio = float(oh.mean() / mh.mean()) if mh.mean() > 0 else 1.0
        tp = [(p["obs_tp"], p["model_tp"]) for p in ps if p["obs_tp"] is not None and p["model_tp"] is not None]
        dr = [(p["obs_dir"], p["model_dir"]) for p in ps if p["obs_dir"] is not None and p["model_dir"] is not None]
        dir_bias = float(np.degrees(np.arctan2(np.mean([np.sin(np.radians(o - m)) for o, m in dr]), np.mean([np.cos(np.radians(o - m)) for o, m in dr])))) if dr else None
        days = sorted({p["t"][:10] for p in ps})
        validation = heldout_skill(ps)
        buoys[bid] = {
            "independent_days": len(days), **validation,
            # A bulk buoy correction has not validated the per-partition/nearshore transfer.
            "validated": False, "validation_scope": "bulk_hs_only",
            "n_pairs": len(ps), "low_confidence": len(ps) < a.min_pairs or len(days) < 7 or not validation["bulk_skill_improved"],
            "ratio_hs": round(min(1.6, max(0.6, ratio)), 3), "ratio_hs_raw": round(ratio, 3),
            "obs_hs_mean": round(float(oh.mean()), 2), "model_hs_mean": round(float(mh.mean()), 2),
            "mae_hs": round(float(np.abs(oh - mh).mean()), 2),
            "period_bias_s": round(float(np.mean([o - m for o, m in tp])), 2) if tp else None,
            "dir_bias_deg": round(dir_bias) if dir_bias is not None else None,
            "first": min(p["t"] for p in ps), "last": max(p["t"] for p in ps),
        }
        log.info("%s n=%d obs %.2f m model %.2f m ratio %.2f (%s; transfer unvalidated)", bid, len(ps), oh.mean(), mh.mean(), ratio, "low confidence" if buoys[bid]["low_confidence"] else "bulk holdout improved")
    write_json(out / "latest.json", {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "cycle": ww3["cycle"],
        "method": "obs/model Hs ratio over rolling %d-day history of analysis+0-6h pairs, clamped 0.6..1.6" % a.keep_days,
        "new_pairs_this_run": len(new_pairs), "buoys": buoys,
    }, ndigits=3)
    log.info("wrote %s (%d buoys, %d pairs on file)", out / "latest.json", len(buoys), len(pairs))
    return 0


if __name__ == "__main__":
    sys.exit(main())

import { atTime, fresh, type BathySpot, type Calibration, type HrrrSpotRecord, type TideStation, type Ww3SpotRecord } from "./cache";
import { tideStateFromFraction } from "./quality/tideWindow";
import type { Conditions, Spot, SwellTrain, TidePhase } from "./quality/types";

const MS_TO_KTS = 1.943844;

export function trainsFrom(r: Ww3SpotRecord | null): SwellTrain[] {
  if (!r) return [];
  const out: SwellTrain[] = [];
  const add = (hs?: number | null, tp?: number | null, dp?: number | null, kind: SwellTrain["kind"] = "swell") => {
    if (hs != null && tp != null && dp != null && hs > 0 && tp > 0 && Number.isFinite(hs + tp + dp)) out.push({ hs, tp, dp, kind });
  };
  add(r.swell1_hs, r.swell1_tp, r.swell1_dp);
  add(r.swell2_hs, r.swell2_tp, r.swell2_dp);
  add(r.swell3_hs, r.swell3_tp, r.swell3_dp);
  add(r.wind_hs, r.wind_tp, r.wind_dp, "windsea");
  // Partition-less fallback: if the model gave only the combined fields, use them as one train.
  if (out.length === 0) add(r.hs, r.tp, r.dp);
  return out;
}

export function windFrom(hrrr: HrrrSpotRecord | null, ww3: Ww3SpotRecord | null): Conditions["wind"] {
  if (hrrr && hrrr.speed_ms != null && hrrr.dir_from_deg != null && Number.isFinite(hrrr.speed_ms + hrrr.dir_from_deg)) {
    return { speed_kts: hrrr.speed_ms * MS_TO_KTS, dir_from_deg: hrrr.dir_from_deg, gust_kts: hrrr.gust_ms != null ? hrrr.gust_ms * MS_TO_KTS : undefined };
  }
  if (ww3 && ww3.wind_speed != null && ww3.wind_dir != null && Number.isFinite(ww3.wind_speed + ww3.wind_dir)) {
    return { speed_kts: ww3.wind_speed * MS_TO_KTS, dir_from_deg: ww3.wind_dir };
  }
  return null;
}

/** Interpolate the predicted height at `iso` and classify it against the surrounding high/low pair. */
export function tideAt(station: TideStation | null, iso: string): Conditions["tide"] {
  if (!station?.hilo?.length) return null;
  const t = Date.parse(iso);
  const events = station.hilo.map((e) => ({ ...e, ms: Date.parse(e.t) })).sort((a, b) => a.ms - b.ms);
  const nextIdx = events.findIndex((e) => e.ms >= t);
  if (nextIdx <= 0) return null;
  const prev = events[nextIdx - 1], next = events[nextIdx];
  // cosine interpolation between successive extremes is a good match for a tidal curve
  const f = (t - prev.ms) / (next.ms - prev.ms);
  const rows = station.series ?? [];
  const j = rows.findIndex((r) => Date.parse(r.t) >= t), r1 = rows[j], r0 = rows[Math.max(0, j - 1)];
  const span = r0 && r1 ? Date.parse(r1.t) - Date.parse(r0.t) : Infinity;
  const height_m = r0 && r1 && t >= Date.parse(r0.t) && span <= 2 * 3_600_000
    ? span === 0 ? r1.v : r0.v + (r1.v - r0.v) * (t - Date.parse(r0.t)) / span
    : prev.v + (next.v - prev.v) * (1 - Math.cos(Math.PI * f)) / 2;
  const lo = Math.min(prev.v, next.v), hi = Math.max(prev.v, next.v);
  const range_fraction = hi > lo ? (height_m - lo) / (hi - lo) : 0.5;
  const phase: TidePhase = next.type === "H" ? "rising" : "falling";
  return { state: tideStateFromFraction(range_fraction), phase, height_m, range_fraction };
}

/** Only use a fresh correction that improved a chronological held-out set of independent days. */
export function calibrationFor(spot: Spot, cal: Calibration | null): Conditions["calibration"] {
  if (!cal || !fresh(cal.generated_at, 12)) return null;
  const candidates = spot.buoys.map((id) => ({ id, b: cal.buoys[id] })).filter(({ b }) =>
    b?.validated === true && !b.low_confidence && (b.independent_days ?? 0) >= 7 && fresh(b.last, 24) && Number.isFinite(b.ratio_hs));
  candidates.sort((a, b) => (b.b.independent_days ?? 0) - (a.b.independent_days ?? 0));
  const best = candidates[0];
  if (!best) return null;
  return { buoy: best.id, ratio_hs: best.b.ratio_hs, applied: Math.max(0.6, Math.min(1.6, best.b.ratio_hs)), n_pairs: best.b.n_pairs, low_confidence: false };
}

/** Interpolate the forcing, never a score. Reject gaps and extrapolation. */
export function waveAt(series: Ww3SpotRecord[] | undefined, iso: string): Ww3SpotRecord | null {
  if (!series?.length) return null;
  const t = Date.parse(iso), pts = [...series].sort((a, b) => Date.parse(a.valid_time) - Date.parse(b.valid_time));
  const i = pts.findIndex((p) => Date.parse(p.valid_time) >= t);
  if (i < 0) return null;
  const b = pts[i]; if (Date.parse(b.valid_time) === t) return b;
  if (!i) return null;
  const a = pts[i - 1], dt = Date.parse(b.valid_time) - Date.parse(a.valid_time);
  if (dt > 3 * 3_600_000 || dt <= 0) return null;
  const f = (t - Date.parse(a.valid_time)) / dt;
  const out: Ww3SpotRecord = { hour: a.hour + (b.hour - a.hour) * f, valid_time: iso };
  const lerp = (x: number, y: number) => x + (y - x) * f;
  const dir = (x: number, y: number) => (x + (((y - x + 540) % 360) - 180) * f + 360) % 360;
  for (const prefix of ["", "swell1_", "swell2_", "swell3_", "wind_"] as const) {
    const hk = `${prefix}hs` as keyof Ww3SpotRecord, tk = `${prefix}tp` as keyof Ww3SpotRecord, dk = `${prefix}dp` as keyof Ww3SpotRecord;
    const ah = a[hk], bh = b[hk], at = a[tk], bt = b[tk], ad = a[dk], bd = b[dk];
    if (typeof ah === "number" && typeof bh === "number" && Number.isFinite(ah + bh)) Object.assign(out, { [hk]: Math.sqrt(lerp(ah * ah, bh * bh)) });
    if (![ah, bh, at, bt, ad, bd].every((v) => typeof v === "number" && Number.isFinite(v))) continue;
    // Numbered partitions can exchange rank. Do not blend unrelated systems across a swap.
    const stable = Math.abs((bd as number) - (ad as number) + 540) % 360 - 180;
    const near = f < 0.5 ? a : b;
    Object.assign(out, Math.abs(stable) > 90 || Math.abs((bt as number) - (at as number)) > 5
      ? { [hk]: near[hk], [tk]: near[tk], [dk]: near[dk] }
      : { [hk]: Math.sqrt(lerp((ah as number) ** 2, (bh as number) ** 2)), [tk]: lerp(at as number, bt as number), [dk]: dir(ad as number, bd as number) });
  }
  if (a.wind_speed != null && b.wind_speed != null && a.wind_dir != null && b.wind_dir != null) {
    const u = lerp(a.wind_speed * Math.sin(a.wind_dir * Math.PI / 180), b.wind_speed * Math.sin(b.wind_dir * Math.PI / 180));
    const v = lerp(a.wind_speed * Math.cos(a.wind_dir * Math.PI / 180), b.wind_speed * Math.cos(b.wind_dir * Math.PI / 180));
    out.wind_speed = Math.hypot(u, v); out.wind_dir = (Math.atan2(u, v) * 180 / Math.PI + 360) % 360;
  }
  return out;
}

export function conditionsFor(
  spot: Spot, iso: string,
  ww3Series: Ww3SpotRecord[] | undefined, hrrrSeries: HrrrSpotRecord[] | undefined, tide: TideStation | null,
  cal: Calibration | null = null, bathy: BathySpot | null = null,
): Conditions {
  const w = waveAt(ww3Series, iso);
  const h = atTime(hrrrSeries, iso, 45);
  const calibration = calibrationFor(spot, cal);
  const trains = trainsFrom(w).map((t) => (calibration ? { ...t, hs: t.hs * calibration.applied } : t));
  return { wave_status: w && (w.hs === 0 || trains.length > 0) ? "available" : "missing", trains, wind: windFrom(h, w), tide: tideAt(tide, iso), calibration,
           bathy: bathy ? { slope_tan: bathy.slope_tan, quality: bathy.quality, has_bar: bathy.has_bar } : null };
}

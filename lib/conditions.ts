import { atTime, type BathySpot, type Calibration, type HrrrSpotRecord, type TideStation, type Ww3SpotRecord } from "./cache";
import { tideStateFromFraction } from "./quality/tideWindow";
import type { Conditions, Spot, SwellTrain, TidePhase } from "./quality/types";

const MS_TO_KTS = 1.943844;

export function trainsFrom(r: Ww3SpotRecord | null): SwellTrain[] {
  if (!r) return [];
  const out: SwellTrain[] = [];
  const add = (hs?: number | null, tp?: number | null, dp?: number | null, kind: SwellTrain["kind"] = "swell") => {
    if (hs != null && tp != null && dp != null && hs > 0.05) out.push({ hs, tp, dp, kind });
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
  if (hrrr && hrrr.speed_ms != null && hrrr.dir_from_deg != null) {
    return { speed_kts: hrrr.speed_ms * MS_TO_KTS, dir_from_deg: hrrr.dir_from_deg, gust_kts: hrrr.gust_ms != null ? hrrr.gust_ms * MS_TO_KTS : undefined };
  }
  if (ww3 && ww3.wind_speed != null && ww3.wind_dir != null) {
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
  const height_m = prev.v + (next.v - prev.v) * (1 - Math.cos(Math.PI * f)) / 2;
  const lo = Math.min(prev.v, next.v), hi = Math.max(prev.v, next.v);
  const range_fraction = hi > lo ? (height_m - lo) / (hi - lo) : 0.5;
  const phase: TidePhase = next.type === "H" ? "rising" : "falling";
  return { state: tideStateFromFraction(range_fraction), phase, height_m, range_fraction };
}

/**
 * Deep-water bias correction from the spot's nearest reporting buoy. The ratio is damped by how many
 * model/obs pairs back it (one cycle gives ~13 autocorrelated pairs; full trust at 24) and never leaves 0.6–1.6.
 */
export function calibrationFor(spot: Spot, cal: Calibration | null): Conditions["calibration"] {
  if (!cal) return null;
  for (const id of spot.buoys) {
    const b = cal.buoys[id];
    if (!b || b.n_pairs === 0) continue;
    const trust = Math.min(1, b.n_pairs / 24);
    const applied = 1 + (b.ratio_hs - 1) * trust;
    return { buoy: id, ratio_hs: b.ratio_hs, applied, n_pairs: b.n_pairs, low_confidence: b.low_confidence };
  }
  return null;
}

export function conditionsFor(
  spot: Spot, iso: string,
  ww3Series: Ww3SpotRecord[] | undefined, hrrrSeries: HrrrSpotRecord[] | undefined, tide: TideStation | null,
  cal: Calibration | null = null, bathy: BathySpot | null = null,
): Conditions {
  const w = atTime(ww3Series, iso);
  const h = atTime(hrrrSeries, iso, 45);
  const calibration = calibrationFor(spot, cal);
  const trains = trainsFrom(w).map((t) => (calibration ? { ...t, hs: t.hs * calibration.applied } : t));
  return { trains, wind: windFrom(h, w), tide: tideAt(tide, iso), calibration,
           bathy: bathy ? { slope_tan: bathy.slope_tan, quality: bathy.quality, has_bar: bathy.has_bar } : null };
}

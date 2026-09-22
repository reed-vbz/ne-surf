/**
 * Typed readers for the static JSON the Python workers write into public/cache/.
 * Runs in the browser (fetches /cache/...). Optional layers (HRRR, tides, NDBC) resolve to null when absent.
 */

export type Flat = Array<number | null>;

export interface GridIndex {
  cycle: string; generated_at: string; lat: number[]; lon: number[]; shape: [number, number];
  steps: Array<{ hour: number; valid_time: string; file: string }>;
}
export interface Ww3Index extends GridIndex { model: string; grid: string }
export interface Ww3Step { hour: number; valid_time: string; fields: Record<string, Flat> }
export interface Ww3SpotRecord {
  hour: number; valid_time: string; cell?: { lat: number; lon: number; snap_km: number };
  hs?: number | null; tp?: number | null; dp?: number | null;
  wind_hs?: number | null; wind_tp?: number | null; wind_dp?: number | null;
  swell1_hs?: number | null; swell1_tp?: number | null; swell1_dp?: number | null;
  swell2_hs?: number | null; swell2_tp?: number | null; swell2_dp?: number | null;
  swell3_hs?: number | null; swell3_tp?: number | null; swell3_dp?: number | null;
  wind_speed?: number | null; wind_dir?: number | null;
}
export interface Ww3Spots {
  cycle: string; spots: Array<{ id: string; name: string; series: Ww3SpotRecord[] }>;
  buoys?: Array<{ id: string; position: { lat: number; lon: number }; series: Ww3SpotRecord[] }>;
}

export interface HrrrIndex extends GridIndex { model: string; paint_mask?: number[] }
export interface HrrrStep { hour: number; valid_time: string; fields: { u10: Flat; v10: Flat; gust: Flat } }
export interface HrrrSpotRecord { hour: number; valid_time: string; speed_ms: number | null; dir_from_deg: number | null; gust_ms: number | null }
export interface HrrrSpots { cycle: string; spots: Array<{ id: string; series: HrrrSpotRecord[] }> }

export interface TideStation {
  id: string; kind: string; hilo: Array<{ t: string; v: number; type: "H" | "L" }>;
  series: Array<{ t: string; v: number }>; latest_obs: { t: string; v: number } | null; range_m?: number;
}
export interface TidesIndex { generated_at: string; stations: Array<{ id: string; kind: string; file: string }> }

export interface NdbcBuoy {
  status: "ok" | "offline" | "no_waves"; obs_time?: string;
  wvht_m?: number | null; dpd_s?: number | null; apd_s?: number | null; mwd_deg?: number | null;
  wspd_ms?: number | null; wdir_deg?: number | null; gst_ms?: number | null; wtmp_c?: number | null;
  swell?: { hs_m: number | null; tp_s: number | null; dir_deg: number | null };
  windsea?: { hs_m: number | null; tp_s: number | null; dir_deg: number | null };
  /** raw NDBC spectral density (realtime2 .data_spec), newest hour */
  spectrum?: { time: string; freqs_hz: number[]; density_m2_hz: number[] } | null;
}
export interface NdbcLatest { generated_at: string; buoys: Record<string, NdbcBuoy> }

export interface Calibration {
  generated_at: string; cycle: string;
  buoys: Record<string, { n_pairs: number; low_confidence: boolean; ratio_hs: number; obs_hs_mean: number; model_hs_mean: number; mae_hs: number; period_bias_s: number | null; dir_bias_deg: number | null }>;
}
export interface BathySpot {
  slope_tan: number | null; slope_r2?: number | null; quality: string; has_bar?: boolean; shore_offset_m?: number; marker_note?: string;
  depth_at_m?: Record<string, number | null>; profile?: Array<[number, number | null]>; facing_used?: number;
}
export interface Bathymetry { generated_at: string; source: string; spots: Record<string, BathySpot> }

const memo = new Map<string, Promise<unknown>>();

/**
 * Where the JSON cache lives. Locally the workers write to public/cache and Next serves it from /cache.
 * In production the GitHub Actions cron force-pushes public/cache to the `data` branch, and the site reads it
 * straight from raw.githubusercontent.com so no rebuild is needed per model run:
 *   NEXT_PUBLIC_CACHE_BASE=https://raw.githubusercontent.com/<owner>/ne-surf/data/public/cache
 */
export const CACHE_BASE = (process.env.NEXT_PUBLIC_CACHE_BASE ?? "/cache").replace(/\/$/, "");

export function loadJson<T>(path: string): Promise<T | null> {
  const url = path.startsWith("/cache/") ? CACHE_BASE + path.slice("/cache".length) : path;
  if (!memo.has(url)) {
    memo.set(url, fetch(url, { cache: "no-cache" }).then((r) => (r.ok ? (r.json() as Promise<T>) : null)).catch(() => null));
  }
  return memo.get(url) as Promise<T | null>;
}

export const loadWw3Index = () => loadJson<Ww3Index>("/cache/ww3/index.json");
export const loadWw3Step = (file: string) => loadJson<Ww3Step>(`/cache/ww3/${file}`);
export const loadWw3Spots = () => loadJson<Ww3Spots>("/cache/ww3/spots.json");
export const loadHrrrIndex = () => loadJson<HrrrIndex>("/cache/hrrr/index.json");
export const loadHrrrStep = (file: string) => loadJson<HrrrStep>(`/cache/hrrr/${file}`);
export const loadHrrrSpots = () => loadJson<HrrrSpots>("/cache/hrrr/spots.json");
export const loadTidesIndex = () => loadJson<TidesIndex>("/cache/tides/index.json");
export const loadTideStation = (id: string) => loadJson<TideStation>(`/cache/tides/${id}.json`);
export const loadNdbc = () => loadJson<NdbcLatest>("/cache/ndbc/latest.json");
export const loadCalibration = () => loadJson<Calibration>("/cache/calibration/latest.json");

/** Nearest-in-time record lookup by valid_time (cycles differ between models, so never match on hour). */
export function atTime<T extends { valid_time: string }>(series: T[] | undefined, iso: string, maxMinutes = 90): T | null {
  if (!series?.length) return null;
  const t = Date.parse(iso);
  let best: T | null = null, bestDt = Infinity;
  for (const r of series) {
    const dt = Math.abs(Date.parse(r.valid_time) - t);
    if (dt < bestDt) { best = r; bestDt = dt; }
  }
  return bestDt <= maxMinutes * 60_000 ? best : null;
}

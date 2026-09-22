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
  status: "ok" | "offline" | "no_waves" | "stale"; obs_time?: string; wave_time?: string;
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
  buoys: Record<string, { n_pairs: number; independent_days?: number; first?: string; last?: string; validated?: boolean; low_confidence: boolean; ratio_hs: number; obs_hs_mean: number; model_hs_mean: number; mae_hs: number; period_bias_s: number | null; dir_bias_deg: number | null }>;
}
export interface BathySpot {
  slope_tan: number | null; slope_r2?: number | null; quality: string; has_bar?: boolean; shore_offset_m?: number; marker_note?: string;
  depth_at_m?: Record<string, number | null>; profile?: Array<[number, number | null]>; facing_used?: number;
}
export interface Bathymetry { generated_at: string; source: string; spots: Record<string, BathySpot> }

const memo = new Map<string, { expires: number; promise: Promise<unknown> }>();

/**
 * Where the JSON cache lives. Locally the workers write to public/cache and Next serves it from /cache.
 * In production the GitHub Actions cron publishes immutable snapshots through a manifest on the `data` branch, and the site reads it
 * straight from raw.githubusercontent.com so no rebuild is needed per model run:
 *   NEXT_PUBLIC_CACHE_BASE=https://raw.githubusercontent.com/<owner>/ne-surf/data/public/cache
 */
export const CACHE_BASE = (process.env.NEXT_PUBLIC_CACHE_BASE ?? "/cache").replace(/\/$/, "");

export function loadJson<T>(path: string): Promise<T | null> {
  const url = path.startsWith("/cache/") ? CACHE_BASE + path.slice("/cache".length) : path;
  const cached = memo.get(url);
  if (cached && cached.expires > Date.now()) return cached.promise as Promise<T | null>;
  const promise = fetch(url, { cache: "no-cache", signal: AbortSignal.timeout(15000) })
    .then((r) => r.ok ? r.json() as Promise<T> : null).catch(() => null)
    .then((value) => { if (value === null) memo.delete(url); return value; });
  memo.set(url, { expires: Date.now() + 60_000, promise });
  if (memo.size > 256) memo.delete(memo.keys().next().value!);
  return promise;
}

/** The mutable manifest points at an immutable, retained data commit. */
export async function resolveDataSource(): Promise<{ base: string; revision: string; published: string | null }> {
  const m = await loadJson<{ revision?: string; generated_at?: string }>(`${CACHE_BASE}/manifest.json`);
  const match = CACHE_BASE.match(/^(https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+)\/[^/]+\/public\/cache$/);
  if (match && m?.revision && /^[a-f0-9]{40}$/.test(m.revision))
    return { base: `${match[1]}/${m.revision}/public/cache`, revision: m.revision, published: m.generated_at ?? null };
  if (match) {
    // Migration path for the previous publisher: pin its current commit, never mix mutable files.
    const ownerRepo = match[1].slice("https://raw.githubusercontent.com/".length);
    const branch = CACHE_BASE.slice(match[1].length + 1).split("/")[0];
    const ref = await loadJson<{ object?: { sha?: string } }>(`https://api.github.com/repos/${ownerRepo}/git/ref/heads/${encodeURIComponent(branch)}`);
    if (ref?.object?.sha && /^[a-f0-9]{40}$/.test(ref.object.sha)) return { base: `${match[1]}/${ref.object.sha}/public/cache`, revision: ref.object.sha, published: null };
    throw new Error("Forecast publication manifest unavailable");
  }
  return { base: CACHE_BASE, revision: "unversioned", published: null };
}
export const loadWw3Index = (base = CACHE_BASE) => loadJson<Ww3Index>(`${base}/ww3/index.json`);
export const loadWw3Step = (file: string, base = CACHE_BASE) => loadJson<Ww3Step>(`${base}/ww3/${file}`);
export const loadWw3Spots = (base = CACHE_BASE) => loadJson<Ww3Spots>(`${base}/ww3/spots.json`);
export const loadHrrrIndex = (base = CACHE_BASE) => loadJson<HrrrIndex>(`${base}/hrrr/index.json`);
export const loadHrrrStep = (file: string, base = CACHE_BASE) => loadJson<HrrrStep>(`${base}/hrrr/${file}`);
export const loadHrrrSpots = (base = CACHE_BASE) => loadJson<HrrrSpots>(`${base}/hrrr/spots.json`);
export const loadTidesIndex = (base = CACHE_BASE) => loadJson<TidesIndex>(`${base}/tides/index.json`);
export const loadTideStation = (id: string, base = CACHE_BASE) => loadJson<TideStation>(`${base}/tides/${id}.json`);
export const loadNdbc = (base = CACHE_BASE) => loadJson<NdbcLatest>(`${base}/ndbc/latest.json`);
export const loadCalibration = (base = CACHE_BASE) => loadJson<Calibration>(`${base}/calibration/latest.json`);

export function fresh(iso: string | undefined, maxHours: number, now = Date.now()): boolean {
  const age = now - Date.parse(iso ?? "");
  return Number.isFinite(age) && age >= -300_000 && age <= maxHours * 3_600_000;
}
export const buoyFresh = (b: NdbcBuoy | undefined | null, now = Date.now()) =>
  !!b && b.status === "ok" && fresh(b.wave_time ?? b.obs_time, 3, now) && b.wvht_m != null;

export function validGrid(index: GridIndex | null): index is GridIndex {
  return !!index && Array.isArray(index.shape) && index.shape.length === 2 &&
    index.shape.every((n) => Number.isInteger(n) && n > 0) &&
    index.lat?.length === index.shape[0] && index.lon?.length === index.shape[1] &&
    [index.lat, index.lon].every((xs) => xs.every((v, i) => Number.isFinite(v) && (!i || v > xs[i - 1]))) &&
    Number.isFinite(Date.parse(index.cycle)) && Array.isArray(index.steps) && index.steps.length > 0 &&
    index.steps.every((s) => Number.isFinite(Date.parse(s.valid_time)) && /^steps\/f\d+\.json$/.test(s.file));
}
export function validStep(index: GridIndex, step: Ww3Step | HrrrStep | null, time: string): boolean {
  return !!step && step.valid_time === time && ("hs" in (step.fields ?? {}) || ("u10" in (step.fields ?? {}) && "v10" in (step.fields ?? {}))) && Object.values(step.fields ?? {}).every((xs) =>
    Array.isArray(xs) && xs.length === index.shape[0] * index.shape[1] && xs.every((x) => x === null || Number.isFinite(x)));
}

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

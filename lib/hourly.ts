/**
 * Hourly series for the forecast drawer. The scored forecast exists per WW3 step (3-hourly); this interpolates it to
 * the 24 local hours of one day and overlays HRRR's hourly wind where the spot series has it (first 48 h).
 */
import type { HrrrSpotRecord, TideStation } from "./cache";
import { tierFor, type Tier } from "./colors";
import type { ForecastPoint } from "./forecast";

export interface HourPoint { iso: string; t: number; hour: number; faceFt: number; tp: number | null; dp: number | null; windKts: number | null; windFrom: number | null; score: number; tier: Tier }
const NY = "America/New_York";
const partsFmt = new Intl.DateTimeFormat("en-US", { timeZone: NY, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit" });

/** UTC offset (hours, negative west) of the New York zone at instant `ms`. */
function nyOffsetHours(ms: number): number {
  const p = partsFmt.formatToParts(new Date(ms)); const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
  const local = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24);
  return Math.round((local - Math.floor(ms / 3.6e6) * 3.6e6) / 3.6e6);
}
/** UTC ms for local hour `h` (0–23) of the local day `dayKey` (YYYY-MM-DD). */
export function localHourUtc(dayKey: string, h: number): number {
  const naive = Date.parse(`${dayKey}T${String(h).padStart(2, "0")}:00:00Z`);
  let ms = naive - nyOffsetHours(naive) * 3.6e6;
  ms = naive - nyOffsetHours(ms) * 3.6e6;   // second pass settles a DST edge
  return ms;
}

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;
const lerpDir = (a: number, b: number, f: number) => { const d = (((b - a) % 360) + 540) % 360 - 180; return (a + d * f + 360) % 360; };

export function hourlySeries(points: ForecastPoint[], dayKey: string, hrrr?: HrrrSpotRecord[]): HourPoint[] {
  if (!points.length) return [];
  const pts = [...points].sort((a, b) => Date.parse(a.valid_time) - Date.parse(b.valid_time));
  const times = pts.map((p) => Date.parse(p.valid_time));
  const byHour = new Map<number, HrrrSpotRecord>(); for (const r of hrrr ?? []) byHour.set(Date.parse(r.valid_time), r);
  const out: HourPoint[] = [];
  for (let h = 0; h < 24; h++) {
    const t = localHourUtc(dayKey, h);
    if (t < times[0] - 3 * 3.6e6 || t > times[times.length - 1] + 3 * 3.6e6) continue;
    let k = times.findIndex((x) => x >= t); if (k < 0) k = times.length - 1;
    const p1 = pts[k], p0 = pts[Math.max(0, k - 1)], t1 = times[k], t0 = times[Math.max(0, k - 1)];
    const f = t1 === t0 ? 0 : Math.max(0, Math.min(1, (t - t0) / (t1 - t0)));
    const near = f < 0.5 ? p0 : p1;
    const w0 = p0.cond.wind, w1 = p1.cond.wind, hr = byHour.get(t);
    const windKts = hr && hr.speed_ms != null ? hr.speed_ms * 1.94384 : w0 && w1 ? lerp(w0.speed_kts, w1.speed_kts, f) : (near.cond.wind?.speed_kts ?? null);
    const windFrom = hr && hr.dir_from_deg != null ? hr.dir_from_deg : w0 && w1 ? lerpDir(w0.dir_from_deg, w1.dir_from_deg, f) : (near.cond.wind?.dir_from_deg ?? null);
    const score = lerp(p0.result.score, p1.result.score, f);
    out.push({ iso: new Date(t).toISOString(), t, hour: h, faceFt: lerp(p0.result.face_ft, p1.result.face_ft, f), tp: near.result.dominant?.tp ?? null, dp: near.result.dominant?.dp ?? null,
      windKts, windFrom, score, tier: tierFor(score) });
  }
  return out;
}

/** Tide curve + highs/lows for one local day (station series are hourly in the cache). */
export function tideDay(station: TideStation | null, dayKey: string) {
  if (!station) return { series: [] as Array<{ t: number; v: number }>, hilo: [] as Array<{ t: number; v: number; type: "H" | "L" }> };
  const a = localHourUtc(dayKey, 0), b = a + 24 * 3.6e6;
  const inDay = (iso: string) => { const t = Date.parse(iso); return t >= a - 1.8e6 && t <= b + 1.8e6; };
  return { series: station.series.filter((s) => inDay(s.t)).map((s) => ({ t: Date.parse(s.t), v: s.v })), hilo: station.hilo.filter((s) => inDay(s.t)).map((s) => ({ t: Date.parse(s.t), v: s.v, type: s.type })) };
}

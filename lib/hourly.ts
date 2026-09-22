/** Hourly display of the already-scored forcing; no post-score wind overrides. */
import type { TideStation } from "./cache";
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

/** The forecast engine already scores each UTC hour using that hour's forcing. */
export function hourlySeries(points: ForecastPoint[], dayKey: string): HourPoint[] {
  const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit" });
  return points.filter((p) => dayFmt.format(new Date(p.valid_time)) === dayKey && p.result.available !== false).map((p) => ({
    iso: p.valid_time, t: Date.parse(p.valid_time), hour: Number(partsFmt.formatToParts(new Date(p.valid_time)).find((x) => x.type === "hour")?.value) % 24,
    faceFt: p.result.face_ft, tp: p.result.dominant?.tp ?? null, dp: p.result.dominant?.dp ?? null,
    windKts: p.cond.wind?.speed_kts ?? null, windFrom: p.cond.wind?.dir_from_deg ?? null, score: p.result.score, tier: tierFor(p.result.score),
  }));
}

/** Tide curve + highs/lows for one local day (station series are hourly in the cache). */
export function tideDay(station: TideStation | null, dayKey: string) {
  if (!station) return { series: [] as Array<{ t: number; v: number }>, hilo: [] as Array<{ t: number; v: number; type: "H" | "L" }> };
  if (!dayKey) return { series: [], hilo: [] };
  const next = new Date(Date.parse(`${dayKey}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const a = localHourUtc(dayKey, 0), b = localHourUtc(next, 0);
  const inDay = (iso: string) => { const t = Date.parse(iso); return t >= a - 1.8e6 && t <= b + 1.8e6; };
  return { series: station.series.filter((s) => inDay(s.t)).map((s) => ({ t: Date.parse(s.t), v: s.v })), hilo: station.hilo.filter((s) => inDay(s.t)).map((s) => ({ t: Date.parse(s.t), v: s.v, type: s.type })) };
}

/** Whole-horizon forecast for one spot: one scored point per WW3 step. Shared by the map page and the spot page. */
import type { Bathymetry, Calibration, HrrrSpots, TideStation, Ww3Index, Ww3Spots } from "./cache";
import { conditionsFor } from "./conditions";
import { scoreSpot, type Conditions, type ScoreBreakdown, type Spot } from "./quality";

export interface ForecastPoint { hour: number; valid_time: string; cond: Conditions; result: ScoreBreakdown }

export interface ForecastData {
  ww3: { index: Ww3Index; spots: Ww3Spots } | null;
  hrrr: { index: { steps: Array<{ hour: number; valid_time: string; file: string }>; cycle: string }; spots: HrrrSpots } | null;
  tides: Record<string, TideStation>;
  cal: Calibration | null;
  bathy: Bathymetry;
}

export function forecastFor(spot: Spot, d: ForecastData): ForecastPoint[] {
  if (!d.ww3) return [];
  const w = d.ww3.spots.spots.find((s) => s.id === spot.id)?.series;
  const h = d.hrrr?.spots.spots.find((s) => s.id === spot.id)?.series;
  const tide = d.tides[spot.tide.station_id] ?? null;
  const bathy = d.bathy.spots[spot.id] ?? null;
  return d.ww3.index.steps.map((st) => {
    const cond = conditionsFor(spot, st.valid_time, w, h, tide, d.cal, bathy);
    return { hour: st.hour, valid_time: st.valid_time, cond, result: scoreSpot(spot, cond) };
  });
}

/** Best scoring point in the horizon, and the best per local day. */
export function bestWindow(points: ForecastPoint[]) {
  if (!points.length) return null;
  return points.reduce((b, p) => (p.result.score > b.result.score ? p : b), points[0]);
}

const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

export function byDay(points: ForecastPoint[]): Array<{ day: string; points: ForecastPoint[]; best: ForecastPoint }> {
  const groups = new Map<string, ForecastPoint[]>();
  for (const p of points) {
    const k = dayKey.format(new Date(p.valid_time));
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  return [...groups.entries()].map(([day, pts]) => ({ day, points: pts, best: bestWindow(pts)! }));
}

/** The step used to draw the map layers for a day: the one nearest 12:00 New York time (today: nearest to now). */
export function representativePoint(points: ForecastPoint[], day: string, todayKey: string): ForecastPoint | null {
  const pts = points.filter((p) => dayKey.format(new Date(p.valid_time)) === day);
  if (!pts.length) return null;
  const target = day === todayKey ? Date.now() : Date.parse(`${day}T16:00:00Z`);   // 16Z ≈ noon EDT
  return pts.reduce((b, p) => (Math.abs(Date.parse(p.valid_time) - target) < Math.abs(Date.parse(b.valid_time) - target) ? p : b), pts[0]);
}
export const dayKeyOf = (iso: string | number) => dayKey.format(new Date(iso));

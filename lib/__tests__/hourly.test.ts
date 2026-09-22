import { describe, expect, it } from "vitest";
import { hourlySeries, localHourUtc } from "@/lib/hourly";
import { forecastFor, type ForecastPoint, type ForecastData } from "@/lib/forecast";
import { SPOTS } from "@/lib/spots";
const spot = SPOTS.find((s) => s.id === "nauset-beach-ma")!;
const record = (hour: number) => ({ hour, valid_time: new Date(Date.UTC(2026,8,22,hour)).toISOString(), hs: 1.5, tp: 12, dp: 95, wind_speed: 4, wind_dir: 270 });
describe("hourly forecast", () => {
  it("maps New York hours to UTC", () => {
    expect(new Date(localHourUtc("2026-09-22",0)).toISOString()).toBe("2026-09-22T04:00:00.000Z");
    expect(new Date(localHourUtc("2026-01-22",12)).toISOString()).toBe("2026-01-22T17:00:00.000Z");
  });
  it("recomputes quality when an intervening HRRR hour turns onshore", () => {
    const series = [record(3),record(6),record(9)];
    const data = { ww3: { index: { cycle: series[0].valid_time, steps: series }, spots: { spots: [{ id: spot.id, series }] } },
      hrrr: { spots: { spots: [{ id: spot.id, series: [{ hour: 2, valid_time: record(5).valid_time, speed_ms: 15, dir_from_deg: 90, gust_ms: 20 }] }] } },
      tides: {}, cal: null, bathy: { spots: {} } } as unknown as ForecastData;
    const hours = hourlySeries(forecastFor(spot,data),"2026-09-22");
    const offshore = hours.find((p) => p.hour === 0)!, onshore = hours.find((p) => p.hour === 1)!;
    expect(onshore.windFrom).toBe(90); expect(onshore.windKts).toBeCloseTo(29.16,1);
    expect(onshore.score).toBeLessThanOrEqual(20); expect(offshore.score).toBeGreaterThan(onshore.score);
    expect(hours.at(-1)!.t).toBe(Date.parse(record(9).valid_time));
  });
  it("preserves 23 and 25 actual hours on DST transition days", () => {
    for (const [day,n] of [["2026-03-08",23],["2026-11-01",25]] as const) {
      const t=localHourUtc(day,0), points=Array.from({length:27},(_,i) => ({valid_time:new Date(t+i*3600000).toISOString(),cond:{wind:null},result:{face_ft:0,dominant:null,score:0}} as ForecastPoint));
      const hours=hourlySeries(points,day);expect(hours).toHaveLength(n);expect(new Set(hours.map((p)=>p.t)).size).toBe(n);
    }
  });
});

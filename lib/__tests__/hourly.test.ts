import { describe, expect, it } from "vitest";
import { hourlySeries, localHourUtc } from "@/lib/hourly";
import type { ForecastPoint } from "@/lib/forecast";

const pt = (iso: string, face: number, tp: number, dp: number, wind: { speed_kts: number; dir_from_deg: number } | null, score: number): ForecastPoint =>
  ({ hour: 0, valid_time: iso, cond: { trains: [], wind, tide: null }, result: { score, face_ft: face, dominant: { tp, dp } } } as unknown as ForecastPoint);

describe("hourly series", () => {
  it("maps New York local hours to UTC across the day (EDT in September)", () => {
    expect(new Date(localHourUtc("2026-09-22", 0)).toISOString()).toBe("2026-09-22T04:00:00.000Z");
    expect(new Date(localHourUtc("2026-09-22", 23)).toISOString()).toBe("2026-09-23T03:00:00.000Z");
  });
  it("interpolates 3-hourly points to 24 local hours and prefers HRRR hourly wind", () => {
    const pts = [];
    for (let h = 0; h <= 30; h += 3) pts.push(pt(new Date(Date.UTC(2026, 8, 22, h)).toISOString(), 2 + h / 10, 8, 90, { speed_kts: 10, dir_from_deg: 350 }, 40 + h));
    const hrrr = [{ hour: 0, valid_time: "2026-09-22T05:00:00Z", speed_ms: 5, dir_from_deg: 200, gust_ms: null }];
    const s = hourlySeries(pts, "2026-09-22", hrrr);
    expect(s.length).toBe(24);
    expect(s[0].hour).toBe(0);
    expect(s[1].windFrom).toBe(200);                      // 01:00 EDT = 05:00Z → HRRR record wins
    expect(s[1].windKts).toBeCloseTo(5 * 1.94384, 3);
    expect(s[2].windFrom).toBeCloseTo(350, 3);            // no HRRR record → WW3 wind, vector-interpolated
    const f5 = s[5].faceFt, f6 = s[6].faceFt; expect(f6).toBeGreaterThan(f5);   // monotone ramp survives interpolation
    expect(s.every((p) => p.tp === 8)).toBe(true);
  });
});

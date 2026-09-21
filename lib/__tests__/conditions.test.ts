import { describe, expect, it } from "vitest";
import type { Calibration, TideStation, Ww3SpotRecord } from "../cache";
import { calibrationFor, tideAt, trainsFrom, windFrom } from "../conditions";
import { byDay, type ForecastPoint } from "../forecast";
import type { Spot } from "../quality/types";
import { SPOTS } from "../spots";

const matunuck = SPOTS.find((s) => s.id === "matunuck-ri") as Spot;

describe("trainsFrom", () => {
  it("builds one train per partition plus wind sea, skipping empties", () => {
    const r: Ww3SpotRecord = { hour: 0, valid_time: "2026-09-21T12:00:00Z", swell1_hs: 1, swell1_tp: 10, swell1_dp: 170,
      swell2_hs: 0.02, swell2_tp: 8, swell2_dp: 100, wind_hs: 0.5, wind_tp: 4, wind_dp: 40 };
    const t = trainsFrom(r);
    expect(t).toHaveLength(2);
    expect(t[1].kind).toBe("windsea");
  });
  it("falls back to combined fields when partitions are missing", () => {
    expect(trainsFrom({ hour: 0, valid_time: "x", hs: 1.2, tp: 9, dp: 150 })).toEqual([{ hs: 1.2, tp: 9, dp: 150, kind: "swell" }]);
  });
});

describe("windFrom", () => {
  it("prefers HRRR and converts m/s to knots", () => {
    const w = windFrom({ hour: 0, valid_time: "x", speed_ms: 10, dir_from_deg: 270, gust_ms: 15 }, { hour: 0, valid_time: "x", wind_speed: 3, wind_dir: 90 });
    expect(w?.speed_kts).toBeCloseTo(19.44, 1);
    expect(w?.dir_from_deg).toBe(270);
  });
  it("falls back to the GFS wind in the wave file", () => {
    expect(windFrom(null, { hour: 0, valid_time: "x", wind_speed: 5, wind_dir: 180 })?.dir_from_deg).toBe(180);
  });
});

describe("tideAt", () => {
  const st: TideStation = { id: "x", kind: "R", latest_obs: null, series: [],
    hilo: [{ t: "2026-09-21T00:00:00Z", v: 0.2, type: "L" }, { t: "2026-09-21T06:00:00Z", v: 1.2, type: "H" }, { t: "2026-09-21T12:00:00Z", v: 0.2, type: "L" }] };
  it("classifies mid-rise as mid/rising and peak-side as high/falling", () => {
    const mid = tideAt(st, "2026-09-21T03:00:00Z")!;
    expect(mid.state).toBe("mid"); expect(mid.phase).toBe("rising"); expect(mid.height_m).toBeCloseTo(0.7, 2);
    const hi = tideAt(st, "2026-09-21T06:30:00Z")!;
    expect(hi.state).toBe("high"); expect(hi.phase).toBe("falling");
  });
  it("returns null outside the prediction window", () => {
    expect(tideAt(st, "2026-09-22T00:00:00Z")).toBeNull();
  });
});

describe("calibrationFor", () => {
  const cal: Calibration = { generated_at: "x", cycle: "x", buoys: { "44097": { n_pairs: 12, low_confidence: true, ratio_hs: 1.4, obs_hs_mean: 1.4, model_hs_mean: 1, mae_hs: 0.4, period_bias_s: 0, dir_bias_deg: 0 } } };
  it("damps the ratio by pair count", () => {
    const c = calibrationFor(matunuck, cal)!;
    expect(c.buoy).toBe("44097");
    expect(c.applied).toBeCloseTo(1.2, 5); // 12/24 trust → half of +0.4
  });
  it("is null without calibration data", () => {
    expect(calibrationFor(matunuck, null)).toBeNull();
  });
});

describe("byDay", () => {
  it("groups by New York local day", () => {
    const mk = (iso: string, score: number): ForecastPoint => ({ hour: 0, valid_time: iso, cond: { trains: [], wind: null, tide: null },
      result: { score, band: "fair", color: "yellow", face_ft: 1, face_m: 0.3, components: { swell_angle: 1, swell_size: 1, swell_period: 1, wind: 1, tide: 1 }, dominant: null, usable_hs_m: 1, nearshore: { xi: null, breaker: "unknown", shape: 1, method: "x" }, reasons: [] } });
    const days = byDay([mk("2026-09-21T03:00:00Z", 10), mk("2026-09-21T06:00:00Z", 40), mk("2026-09-22T06:00:00Z", 20)]);
    expect(days).toHaveLength(3);           // 03Z on the 21st is still the 20th in New York; 06Z is the 21st; the 22nd is its own day
    expect(days.map((d) => d.day)).toEqual(["2026-09-20", "2026-09-21", "2026-09-22"]);
    expect(days[1].best.result.score).toBe(40);
  });
});

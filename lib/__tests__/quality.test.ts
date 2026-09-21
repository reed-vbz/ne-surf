import { describe, expect, it } from "vitest";
import spotsJson from "../../data/spots.json";
import { angleDiff, inSector, windComponents } from "../quality/geometry";
import { scoreSpot } from "../quality/score";
import { assessTrain, summarizeSwell } from "../quality/swellMatch";
import type { Conditions, Spot } from "../quality/types";
import { assessWind } from "../quality/windAlign";

const spots = (spotsJson as { spots: Spot[] }).spots;
const byId = (id: string) => spots.find((s) => s.id === id)!;

describe("geometry", () => {
  it("angleDiff wraps around north", () => {
    expect(angleDiff(350, 10)).toBe(20);
    expect(angleDiff(90, 270)).toBe(180);
  });
  it("inSector handles arcs crossing north", () => {
    expect(inSector(5, 340, 20)).toBe(true);
    expect(inSector(180, 340, 20)).toBe(false);
    expect(inSector(150, 120, 220)).toBe(true);
  });
  it("wind from behind an east-facing beach is offshore", () => {
    const { offshore, cross } = windComponents(10, 270, 90); // W wind, faces E
    expect(offshore).toBeCloseTo(10);
    expect(cross).toBeCloseTo(0);
    expect(windComponents(10, 90, 90).offshore).toBeCloseTo(-10); // E wind = onshore
  });
});

describe("swell match", () => {
  const nauset = byId("nauset-beach-ma");
  it("head-on swell gets full angle credit", () => {
    const a = assessTrain(nauset, { hs: 1.5, tp: 10, dp: 95, kind: "swell" });
    expect(a.angle_weight).toBe(1);
    expect(a.reach).toBe(1);
  });
  it("swell from behind the beach is unusable", () => {
    const a = assessTrain(nauset, { hs: 1.5, tp: 10, dp: 270, kind: "swell" });
    expect(a.angle_weight).toBe(0);
  });
  it("a south swell cannot reach Nantasket at all (window clipped to the open-sea arc)", () => {
    const nantasket = byId("nantasket-ma");
    const s = assessTrain(nantasket, { hs: 2, tp: 12, dp: 170, kind: "swell" });
    expect(s.angle_weight).toBe(0);
  });
  it("Block Island shadow at Matunuck comes from the ray-cast and is halved for long-period swell", () => {
    const m = byId("matunuck-ri");
    const bi = m.shadow_sectors!.find((x) => x.by === "Block Island")!;
    expect(bi).toBeDefined();
    expect(bi.distance_km).toBeGreaterThan(10);
    const short = assessTrain(m, { hs: 1, tp: 9, dp: 190, kind: "swell" });
    const long = assessTrain(m, { hs: 1, tp: 14, dp: 190, kind: "swell" });
    expect(short.shadowed_by).toBe("Block Island");
    expect(short.reach).toBeCloseTo(1 - bi.attenuation);
    expect(long.reach).toBeCloseTo(1 - bi.attenuation / 2);
  });
  it("usable Hs combines partitions by energy", () => {
    const s = summarizeSwell(nauset, [
      { hs: 1, tp: 10, dp: 90, kind: "swell" },
      { hs: 1, tp: 10, dp: 90, kind: "swell" },
    ]);
    expect(s.usable_hs_m).toBeCloseTo(Math.SQRT2);
    expect(s.angle_score).toBe(1);
  });
});

describe("wind", () => {
  const nauset = byId("nauset-beach-ma");
  it("light wind is glassy regardless of direction", () => {
    expect(assessWind(nauset, { speed_kts: 3, dir_from_deg: 90 }).label).toBe("glassy");
  });
  it("20 kt east wind blows out an east-facing beach", () => {
    const w = assessWind(nauset, { speed_kts: 20, dir_from_deg: 90 });
    expect(w.blown_out).toBe(true);
    expect(w.score).toBe(0);
  });
  it("west wind is offshore and scores ~1", () => {
    const w = assessWind(nauset, { speed_kts: 10, dir_from_deg: 270 });
    expect(w.label).toBe("offshore");
    expect(w.score).toBeGreaterThan(0.95);
  });
});

describe("scoreSpot", () => {
  const matunuck = byId("matunuck-ri");
  const ideal: Conditions = {
    trains: [{ hs: 1.8, tp: 11, dp: 175, kind: "swell" }],
    wind: { speed_kts: 8, dir_from_deg: 350 },
    tide: { state: "mid", phase: "rising", height_m: 0.6, range_fraction: 0.5 },
  };
  it("ideal conditions are green and at least Good", () => {
    const r = scoreSpot(matunuck, ideal);
    expect(r.color).toBe("green");
    expect(r.score).toBeGreaterThanOrEqual(85);
    expect(r.face_ft).toBeGreaterThan(5);
  });
  it("same swell, blown out onshore → red", () => {
    const r = scoreSpot(matunuck, { ...ideal, wind: { speed_kts: 22, dir_from_deg: 170 } });
    expect(r.color).toBe("red");
    expect(r.reasons[0]).toMatch(/Blown out/);
  });
  it("flat ocean → very poor", () => {
    const r = scoreSpot(matunuck, { ...ideal, trains: [{ hs: 0.2, tp: 5, dp: 175, kind: "windsea" }] });
    expect(r.score).toBeLessThan(15);
    expect(r.reasons).toContain("Too small for this spot");
  });
  it("dead low tide on a reef that avoids low is capped", () => {
    const r = scoreSpot(matunuck, { ...ideal, tide: { state: "low", phase: "falling", height_m: 0, range_fraction: 0 } });
    expect(r.score).toBeLessThanOrEqual(15);
  });
  it("missing wind and tide still scores (neutral)", () => {
    const r = scoreSpot(matunuck, { trains: ideal.trains, wind: null, tide: null });
    expect(r.score).toBeGreaterThan(40);
  });
});

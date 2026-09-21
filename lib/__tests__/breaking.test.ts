import { describe, expect, it } from "vitest";
import { breakingHeightM, breakerType, iribarren, nearshore, shapeFactor } from "../quality/breaking";

describe("breaking", () => {
  it("Komar-Gaughan: 1.5 m @ 10 s breaks around 2.1 m", () => {
    expect(breakingHeightM(1.5, 10)).toBeCloseTo(2.14, 1);
    expect(breakingHeightM(1, 8)).toBeCloseTo(1.42, 1);
    expect(breakingHeightM(0, 8)).toBe(0);
  });
  it("Iribarren classifies a flat beach as spilling and a steep reef as plunging", () => {
    const flat = iribarren(0.01, 1.5, 10)!, steep = iribarren(0.08, 1.5, 10)!;
    expect(breakerType(flat)).toBe("spilling");
    expect(breakerType(steep)).toBe("plunging");
    expect(shapeFactor(steep)).toBeGreaterThan(shapeFactor(flat));
  });
  it("falls back to shoaling_factor without bathymetry", () => {
    const n = nearshore(1.5, 10, null, 1.2);
    expect(n.method).toBe("shoaling_factor");
    expect(n.face_m).toBeCloseTo(breakingHeightM(1.5, 10) * 1.2, 5);
    expect(nearshore(1.5, 10, { slope_tan: 0.02, quality: "ok" }).method).toBe("komar-gaughan+crm");
  });
});

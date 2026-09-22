import { describe, expect, it } from "vitest";
import { hollowness, shapeWord } from "@/components/screen/WaveAvatar";

describe("wave avatar shape", () => {
  it("offshore long-period swell barrels, onshore short-period chop crumbles", () => {
    expect(hollowness(14, "offshore")).toBeGreaterThan(0.9);
    expect(hollowness(5, "onshore")).toBe(0);
    expect(hollowness(9, "cross")).toBeCloseTo(0.2 + 0.55 * (4 / 9), 3);
    expect(hollowness(null, "unknown")).toBeCloseTo(0.2 + 0.55 * 0.35, 3);
  });
  it("names the shape by hollowness", () => {
    expect(shapeWord(0.9)).toBe("Hollow"); expect(shapeWord(0.5)).toBe("Clean"); expect(shapeWord(0.3)).toBe("Soft"); expect(shapeWord(0.1)).toBe("Mushy");
  });
});

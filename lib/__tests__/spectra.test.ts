import { describe, expect, it } from "vitest";
import { hsFromSpectrum, modelledSpectrum, observedSpectrum } from "@/lib/spectra";

describe("wave spectra", () => {
  it("re-bins NDBC spectral density onto the period axis and conserves Hs", () => {
    // a single narrow peak at 0.0714 Hz (14 s): S = 4 m²/Hz over one 0.005 Hz bin → variance 0.02 m² → Hs = 4·√0.02
    const freqs = Array.from({ length: 40 }, (_, i) => 0.03 + i * 0.005), density = freqs.map((f) => (Math.abs(f - 0.0714) < 0.002 ? 4 : 0));
    const bins = observedSpectrum(freqs, density);
    const peak = bins.reduce((b, d) => (d.energy > b.energy ? d : b), bins[0]);
    expect(peak.period).toBe(14);
    expect(hsFromSpectrum(bins)).toBeCloseTo(4 * Math.sqrt(0.02), 2);
  });
  it("synthesises model partitions as peaks whose total variance is Hs²/16", () => {
    const bins = modelledSpectrum([{ hs: 2, tp: 14, dp: 150, kind: "swell" }, { hs: 0.8, tp: 6, dp: 120, kind: "windsea" }]);
    const peak = bins.reduce((b, d) => (d.energy > b.energy ? d : b), bins[0]);
    expect(peak.period).toBe(14);
    expect(bins.find((b) => b.period === 6)!.energy).toBeGreaterThan(bins.find((b) => b.period === 10)!.energy);
    expect(hsFromSpectrum(bins)).toBeCloseTo(Math.sqrt(4 + 0.64), 1);
  });
});

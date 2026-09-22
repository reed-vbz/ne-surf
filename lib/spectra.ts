/** Energies are variance (m²) in 1-second period bins, not arbitrary chart amplitudes. */
import type { SwellTrain } from "./quality/types";
export interface SpectrumBin { period: number; energy: number }
export const PERIODS = Array.from({ length: 19 }, (_, i) => 3 + i);
export function validSpectrum(freqs: number[], density: number[]): boolean {
  return freqs.length >= 2 && density.length === freqs.length && freqs.every((f, i) => Number.isFinite(f) && f > 0 && (!i || f > freqs[i - 1])) && density.every((s) => Number.isFinite(s) && s >= 0);
}
/** Midpoint edges, extrapolated half a bin at the endpoints. Preserve this convention in ingestion tests. */
export function frequencyEdges(freqs: number[]): number[] {
  return [Math.max(0, freqs[0] - (freqs[1] - freqs[0]) / 2), ...freqs.slice(1).map((f, i) => (f + freqs[i]) / 2), freqs.at(-1)! + (freqs.at(-1)! - freqs.at(-2)!) / 2];
}
export function spectrumVariance(freqs: number[], density: number[]): number | null {
  if (!validSpectrum(freqs, density)) return null;
  const edges = frequencyEdges(freqs);
  return density.reduce((sum, s, i) => sum + s * (edges[i + 1] - edges[i]), 0);
}
export function observedSpectrum(freqs: number[], density: number[]): SpectrumBin[] {
  const out = PERIODS.map((period) => ({ period, energy: 0 }));
  if (!validSpectrum(freqs, density)) return out;
  const edges = frequencyEdges(freqs);
  for (const bin of out) {
    const lo = 1 / (bin.period + 0.5), hi = 1 / (bin.period - 0.5);
    for (let i = 0; i < density.length; i++) bin.energy += density[i] * Math.max(0, Math.min(hi, edges[i + 1]) - Math.max(lo, edges[i]));
  }
  return out;
}
function erf(x: number): number {
  const sign = Math.sign(x), a = Math.abs(x), t = 1 / (1 + 0.3275911 * a);
  return sign * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a));
}
export function modelledSpectrum(trains: SwellTrain[]): SpectrumBin[] {
  return PERIODS.map((period) => ({ period, energy: trains.reduce((sum, t) => {
    if (!(t.hs > 0) || !(t.tp > 0) || !Number.isFinite(t.hs + t.tp)) return sum;
    const sigma = t.kind === "windsea" ? 1.6 : 0.9;
    const cdf = (x: number) => 0.5 * (1 + erf((x - t.tp) / (sigma * Math.SQRT2)));
    return sum + t.hs ** 2 / 16 * (cdf(period + 0.5) - cdf(period - 0.5)) / (1 - cdf(0));
  }, 0) }));
}
export const hsFromSpectrum = (bins: SpectrumBin[]) => 4 * Math.sqrt(bins.reduce((sum, b) => sum + b.energy, 0));

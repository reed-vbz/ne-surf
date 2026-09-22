/**
 * Wave-energy spectra for the buoy spectra graph.
 *  - Observed: NDBC realtime2 .data_spec gives spectral density S(f) in m²/Hz per frequency bin. We re-bin it onto a period
 *    axis as energy per period bin (m² per second of period): S(T) = S(f) · df/dT = S(f) / T², so a 14 s groundswell shows
 *    as a spike at 14 s and 6 s chop as a smaller bump at 6 s.
 *  - Modelled: when the buoy has no spectrum, the WW3 partitions at the break are synthesised as Gaussian peaks in period
 *    whose area is the partition's variance (Hs² / 16), so the model and the observation share one axis.
 */
import type { SwellTrain } from "./quality/types";

export interface SpectrumBin { period: number; energy: number }
export const PERIODS = Array.from({ length: 19 }, (_, i) => 3 + i);   // 3…21 s, 1 s bins

export function observedSpectrum(freqs: number[], density: number[]): SpectrumBin[] {
  const out = PERIODS.map((period) => ({ period, energy: 0 }));
  for (let i = 0; i < freqs.length && i < density.length; i++) {
    const f = freqs[i]; if (!(f > 0)) continue;
    const T = 1 / f, sT = density[i] / (T * T);   // m²/Hz → m² per second of period
    const df = i + 1 < freqs.length ? freqs[i + 1] - f : i > 0 ? f - freqs[i - 1] : 0.005;
    const dT = df / (f * f);                        // width of this bin on the period axis
    const k = Math.round(T) - 3; if (k >= 0 && k < out.length) out[k].energy += sT * dT;   // energy (m²) in the 1 s bin
  }
  return out;
}

export function modelledSpectrum(trains: SwellTrain[]): SpectrumBin[] {
  return PERIODS.map((period) => ({ period, energy: trains.reduce((acc, t) => {
    if (!(t.hs > 0) || !(t.tp > 0)) return acc;
    const sigma = t.kind === "windsea" ? 1.6 : 0.9;   // chop is broad, groundswell is peaked
    const g = Math.exp(-0.5 * ((period - t.tp) / sigma) ** 2) / (sigma * Math.sqrt(2 * Math.PI));
    return acc + ((t.hs * t.hs) / 16) * g;             // variance of the partition spread over the period axis
  }, 0) }));
}

/** Significant height implied by a period-binned spectrum: Hs = 4·√(Σ energy). */
export const hsFromSpectrum = (bins: SpectrumBin[]) => 4 * Math.sqrt(bins.reduce((a, b) => a + b.energy, 0));

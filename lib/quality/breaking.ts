/**
 * Nearshore transformation: deep-water (H0, T) + bottom slope → breaking height and breaker type.
 *
 * Breaking height: Komar & Gaughan (1972), Hb = 0.39 · g^(1/5) · (T · H0²)^(2/5). Empirical, well
 * established for beaches, needs no bathymetry beyond "it shoals". We use it whenever we have a period.
 *
 * Breaker type: deep-water Iribarren number ξ0 = tanβ / sqrt(H0 / L0), L0 = g T² / 2π.
 *   ξ0 < 0.5   spilling (mushy, crumbling)    0.5–3.3 plunging (hollow, the good stuff)   > 3.3 surging (no real break)
 * Surfers want the upper end of spilling through mid plunging, so the shape factor peaks around 0.35–1.2.
 *
 * Slope comes from data/bathymetry.json (NOAA CRM transects). Without a usable slope we fall back to the
 * spot's hand-tuned shoaling_factor and report shape as unknown.
 */
const G = 9.81;

export interface Bathy { slope_tan: number | null; quality: string; has_bar?: boolean }

export function breakingHeightM(h0: number, tp: number): number {
  if (h0 <= 0 || tp <= 0) return 0;
  return 0.39 * Math.pow(G, 0.2) * Math.pow(tp * h0 * h0, 0.4);
}

export function iribarren(slopeTan: number, h0: number, tp: number): number | null {
  if (h0 <= 0 || tp <= 0 || slopeTan <= 0) return null;
  const l0 = (G * tp * tp) / (2 * Math.PI);
  return slopeTan / Math.sqrt(h0 / l0);
}

export type BreakerType = "spilling" | "plunging" | "surging" | "unknown";

export function breakerType(xi: number | null): BreakerType {
  if (xi === null) return "unknown";
  return xi < 0.5 ? "spilling" : xi < 3.3 ? "plunging" : "surging";
}

/** 0.4–1: how surfable the breaker shape is. Peaks for strong-spilling to mid-plunging. */
export function shapeFactor(xi: number | null): number {
  if (xi === null) return 0.85; // unknown: mild penalty only
  if (xi < 0.12) return 0.5;                                   // barely breaking mush
  if (xi < 0.35) return 0.5 + 0.5 * ((xi - 0.12) / 0.23);      // ramps up to 1
  if (xi <= 1.2) return 1;                                     // hollow / ideal
  if (xi <= 3.3) return 1 - 0.5 * ((xi - 1.2) / 2.1);          // increasingly dumpy / heavy
  return 0.4;                                                  // surging: no wall to ride
}

export interface Nearshore { face_m: number; xi: number | null; breaker: BreakerType; shape: number; method: "komar-gaughan+crm" | "komar-gaughan" | "shoaling_factor" }

export function nearshore(h0: number, tp: number, bathy: Bathy | null, shoalingFactor = 1): Nearshore {
  const usable = bathy && bathy.slope_tan !== null && bathy.slope_tan > 0 && bathy.quality !== "no_water";
  if (tp <= 0 || h0 <= 0) return { face_m: 0, xi: null, breaker: "unknown", shape: 0.85, method: "shoaling_factor" };
  const hb = breakingHeightM(h0, tp);
  if (usable) {
    const xi = iribarren(bathy!.slope_tan!, h0, tp);
    return { face_m: hb, xi, breaker: breakerType(xi), shape: shapeFactor(xi), method: "komar-gaughan+crm" };
  }
  // no slope: still use the breaking formula for height (it does not need slope), shape unknown
  return { face_m: hb * shoalingFactor, xi: null, breaker: "unknown", shape: 0.85, method: shoalingFactor === 1 ? "komar-gaughan" : "shoaling_factor" };
}

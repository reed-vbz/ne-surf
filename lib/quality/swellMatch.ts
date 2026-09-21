import { angleDiff, falloff, inSector } from "./geometry";
import type { Spot, SwellTrain } from "./types";

export interface TrainAssessment {
  train: SwellTrain;
  angle_weight: number;   // 0-1 from direction vs spot window/ideal
  reach: number;          // 0-1 after island / cape shadowing
  usable_energy: number;  // hs² · angle_weight · reach  (m²)
  shadowed_by: string | null;
}

/** How much of one swell train's energy actually arrives at the break, and from a usable angle. */
export function assessTrain(spot: Spot, train: SwellTrain): TrainAssessment {
  const { window, ideal_deg, angle_tolerance_deg = 30 } = spot.swell;
  let angle_weight = 0;
  if (inSector(train.dp, window.from_deg, window.to_deg)) {
    // full credit within tolerance of ideal, cosine falloff to zero 60° past it
    angle_weight = falloff(angleDiff(train.dp, ideal_deg), angle_tolerance_deg, angle_tolerance_deg + 60);
    // never fall to zero while still inside the declared window
    angle_weight = Math.max(angle_weight, 0.15);
  }

  let reach = 1;
  let shadowed_by: string | null = null;
  for (const s of spot.shadow_sectors ?? []) {
    if (!inSector(train.dp, s.from_deg, s.to_deg)) continue;
    // long-period swell refracts around obstacles: halve the attenuation above the threshold
    const att = s.min_period_s !== undefined && train.tp >= s.min_period_s ? s.attenuation * 0.5 : s.attenuation;
    const r = 1 - att;
    if (r < reach) { reach = r; shadowed_by = s.by; }
  }

  return { train, angle_weight, reach, usable_energy: train.hs * train.hs * angle_weight * reach, shadowed_by };
}

export interface SwellSummary {
  assessments: TrainAssessment[];
  usable_hs_m: number;      // sqrt(Σ usable energy)
  total_hs_m: number;       // sqrt(Σ hs²) — what a buoy would report
  angle_score: number;      // usable / total energy, 0-1
  dominant: TrainAssessment | null;
}

export function summarizeSwell(spot: Spot, trains: SwellTrain[]): SwellSummary {
  const assessments = trains.filter((t) => t.hs > 0 && t.tp > 0).map((t) => assessTrain(spot, t));
  const usable = assessments.reduce((s, a) => s + a.usable_energy, 0);
  const total = assessments.reduce((s, a) => s + a.train.hs * a.train.hs, 0);
  const dominant = assessments.reduce<TrainAssessment | null>(
    (best, a) => (best === null || a.usable_energy > best.usable_energy ? a : best), null);
  return {
    assessments,
    usable_hs_m: Math.sqrt(usable),
    total_hs_m: Math.sqrt(total),
    angle_score: total > 0 ? usable / total : 0,
    dominant: dominant && dominant.usable_energy > 0 ? dominant : null,
  };
}

/**
 * Deep-water Hs → breaking face height. Empirical: longer period shoals higher.
 * factor = 0.75 + 0.05·Tp, clamped 0.9..1.7 (Tp 8 s → 1.15, 12 s → 1.35, 16 s → 1.55),
 * times the spot's calibratable shoaling_factor. APPROXIMATE until calibrated against buoys/reports.
 */
export function faceHeightM(usable_hs_m: number, tp_s: number, shoaling_factor = 1): number {
  const f = Math.min(1.7, Math.max(0.9, 0.75 + 0.05 * tp_s));
  return usable_hs_m * f * shoaling_factor;
}

/** 0-1: how close the usable deep-water height is to the spot's sweet spot. */
export function sizeScore(spot: Spot, usable_hs_m: number): number {
  const { min_height_m: min, ideal_height_m: ideal, max_height_m: max } = spot.swell;
  if (usable_hs_m <= min) return usable_hs_m <= 0 ? 0 : 0.1 * (usable_hs_m / min);
  if (usable_hs_m <= ideal) return 0.1 + 0.9 * ((usable_hs_m - min) / (ideal - min));
  if (usable_hs_m <= max) return 1 - 0.6 * ((usable_hs_m - ideal) / (max - ideal)); // still fun, getting heavy
  return 0.4 * falloff(usable_hs_m, max, max * 1.5);                                // maxed out / closing out
}

/** 0-1: period quality of the dominant train. */
export function periodScore(spot: Spot, tp_s: number): number {
  const { min_period_s: min, ideal_period_s: ideal } = spot.swell;
  if (tp_s <= min) return 0.1 * Math.max(0, tp_s / min);
  if (tp_s >= ideal) return 1;
  return 0.1 + 0.9 * ((tp_s - min) / (ideal - min));
}

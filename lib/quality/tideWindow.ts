import type { Spot, TidePhase, TideState } from "./types";

export interface TideAssessment { score: number; state: TideState | null; phase: TidePhase | null; blocked: boolean }

export function assessTide(spot: Spot, tide: { state: TideState; phase: TidePhase } | null): TideAssessment {
  if (!tide) return { score: 0.7, state: null, phase: null, blocked: false };
  const { preferred, avoid = [], phase: wantPhase = "any" } = spot.tide;
  if (avoid.includes(tide.state)) return { score: 0, state: tide.state, phase: tide.phase, blocked: true };
  let score = preferred.includes(tide.state) ? 1 : 0.5;
  if (wantPhase !== "any" && tide.phase !== wantPhase) score *= 0.8;
  return { score, state: tide.state, phase: tide.phase, blocked: false };
}

/** Classify a height as low/mid/high by its position within the surrounding low→high (or high→low) swing. */
export function tideStateFromFraction(f: number): TideState {
  return f < 1 / 3 ? "low" : f > 2 / 3 ? "high" : "mid";
}

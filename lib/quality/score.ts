import { nearshore } from "./breaking";
import { periodScore, sizeScore, summarizeSwell } from "./swellMatch";
import { assessTide } from "./tideWindow";
import type { Band, Color, Conditions, ScoreBreakdown, Spot } from "./types";
import { assessWind } from "./windAlign";

export const BANDS: Array<[number, Band]> = [
  [15, "very_poor"], [30, "poor"], [45, "poor_to_fair"], [60, "fair"], [72, "fair_to_good"], [85, "good"], [101, "epic"],
];
export const BAND_LABEL: Record<Band, string> = {
  very_poor: "Very Poor", poor: "Poor", poor_to_fair: "Poor to Fair", fair: "Fair",
  fair_to_good: "Fair to Good", good: "Good", epic: "Epic",
};

export const bandFor = (score: number): Band => BANDS.find(([max]) => score < max)![1];
export const colorFor = (score: number): Color => (score < 30 ? "red" : score < 60 ? "yellow" : "green");

/**
 * Surf Quality Score, 0-100.
 *
 * Multiplicative gates rather than a weighted sum: no amount of offshore wind rescues a flat day,
 * and a perfect swell scores badly when blown out. Ideal size AND period AND wind AND tide are all
 * required for "Good"/"Epic", matching how Surfline reserves those bands (see docs/surfline-method-notes.md).
 */
export function scoreSpot(spot: Spot, c: Conditions): ScoreBreakdown {
  const swell = summarizeSwell(spot, c.trains);
  const tp = swell.dominant?.train.tp ?? 0;
  const size = sizeScore(spot, swell.usable_hs_m);
  const period = periodScore(spot, tp);
  const wind = assessWind(spot, c.wind);
  const tide = assessTide(spot, c.tide);

  const ns = nearshore(swell.usable_hs_m, tp, c.bathy ?? null, spot.swell.shoaling_factor ?? 1);
  let score = 100 * size * (0.5 + 0.5 * period) * (0.35 + 0.65 * wind.score) * (0.6 + 0.4 * tide.score) * ns.shape;
  if (wind.blown_out) score = Math.min(score, 20);
  if (tide.blocked) score = Math.min(score, 15);
  score = Math.round(Math.max(0, Math.min(100, score)));

  const face_m = ns.face_m;
  const reasons: string[] = [];
  if (ns.breaker === "spilling" && ns.xi !== null && ns.xi < 0.2) reasons.push("Gentle bottom slope: soft, spilling waves");
  if (ns.breaker === "surging") reasons.push("Steep bottom: surging, no wall");
  if (swell.usable_hs_m < spot.swell.min_height_m) reasons.push("Too small for this spot");
  if (swell.dominant?.shadowed_by) reasons.push(`Swell partly blocked by ${swell.dominant.shadowed_by}`);
  if (swell.total_hs_m > 0 && swell.angle_score < 0.4) reasons.push("Swell direction poorly aligned with the break");
  if (tp > 0 && tp < spot.swell.min_period_s) reasons.push("Short-period wind chop");
  if (wind.blown_out) reasons.push(`Blown out: ${Math.round(-wind.offshore_kts)} kt onshore`);
  else if (wind.label === "onshore" || wind.label === "cross-on") reasons.push("Onshore wind");
  else if (wind.label === "offshore" && c.wind && c.wind.speed_kts >= (spot.wind.glassy_below_kts ?? 5)) reasons.push("Offshore wind grooming it");
  else if (wind.label === "glassy") reasons.push("Glassy");
  if (tide.blocked) reasons.push(`Wrong tide (${tide.state})`);
  else if (tide.state && !spot.tide.preferred.includes(tide.state)) reasons.push(`Tide ${tide.state}, prefers ${spot.tide.preferred.join("/")}`);
  if (swell.usable_hs_m > spot.swell.max_height_m) reasons.push("Maxed out");

  return {
    score, band: bandFor(score), color: colorFor(score),
    face_m, face_ft: face_m * 3.28084,
    components: { swell_angle: swell.angle_score, swell_size: size, swell_period: period, wind: wind.score, tide: tide.score },
    dominant: swell.dominant?.train ?? null,
    usable_hs_m: swell.usable_hs_m,
    nearshore: { xi: ns.xi, breaker: ns.breaker, shape: ns.shape, method: ns.method },
    reasons,
  };
}

import { angleDiff, falloff, norm360, windComponents } from "./geometry";
import type { Spot } from "./types";

export interface WindAssessment {
  score: number;          // 0-1
  label: "glassy" | "offshore" | "cross-off" | "cross" | "cross-on" | "onshore" | "unknown";
  offshore_kts: number;   // signed, + offshore
  cross_kts: number;
  blown_out: boolean;
}

export function assessWind(spot: Spot, wind: { speed_kts: number; dir_from_deg: number } | null): WindAssessment {
  if (!wind) return { score: 0.6, label: "unknown", offshore_kts: 0, cross_kts: 0, blown_out: false };
  const { offshore_deg, offshore_tolerance_deg, max_onshore_kts, max_cross_kts, glassy_below_kts = 5 } = spot.wind;
  const speed = wind.speed_kts;
  // decompose against the spot's declared offshore bearing (may differ from facing+180 on headlands)
  const facingForDecomp = norm360(offshore_deg + 180);
  const { offshore, cross } = windComponents(speed, wind.dir_from_deg, facingForDecomp);
  const onshore = Math.max(0, -offshore);

  if (speed < glassy_below_kts) return { score: 1, label: "glassy", offshore_kts: offshore, cross_kts: cross, blown_out: false };

  const rel = angleDiff(wind.dir_from_deg, offshore_deg);
  let label: WindAssessment["label"];
  if (rel <= offshore_tolerance_deg) label = "offshore";
  else if (rel <= 90) label = "cross-off";
  else if (rel <= 110) label = "cross";
  else if (rel <= 150) label = "cross-on";
  else label = "onshore";

  const blown_out = onshore >= max_onshore_kts;
  // onshore component: fine below ~3 kts, gone at the spot's threshold
  const onshoreScore = falloff(onshore, 3, max_onshore_kts);
  // cross-shore: fine below ~5 kts, degrades to 0.25 (never zero: some spots handle side-shore) at threshold
  const crossScore = 0.25 + 0.75 * falloff(cross, 5, max_cross_kts);
  // strong offshore also hurts (holds you off the wave): >25 kts offshore starts to cost
  const gale = offshore > 0 ? 0.6 + 0.4 * falloff(offshore, 25, 40) : 1;

  return { score: blown_out ? 0 : onshoreScore * crossScore * gale, label, offshore_kts: offshore, cross_kts: cross, blown_out };
}

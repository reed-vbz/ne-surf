/**
 * Colour mapping for the map canvases and HUD. Single source of truth for every hex the map paints,
 * so the legend can be generated from the same tables (Step 4 sync).
 */
export type RGB = [number, number, number];
export const hexToRgb = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
export const rgbToHex = (c: RGB) => "#" + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const mixRgb = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
/** Piecewise-linear ramp over [position, hex] stops. */
export function ramp(stops: Array<[number, string]>, v: number): RGB {
  if (v <= stops[0][0]) return hexToRgb(stops[0][1]);
  for (let i = 0; i < stops.length - 1; i++) {
    const [p0, c0] = stops[i], [p1, c1] = stops[i + 1];
    if (v <= p1) return mixRgb(hexToRgb(c0), hexToRgb(c1), (v - p0) / (p1 - p0));
  }
  return hexToRgb(stops[stops.length - 1][1]);
}

// ---------------------------------------------------------------- swell energy (ocean canvas, Swell mode)
export const SWELL_STOPS: Array<[number, string]> = [
  [0.0, "#0B192C"],   // low energy: 0–2 ft, short period → deep navy / charcoal
  [0.45, "#00E5FF"],  // medium: 3–5 ft, medium period → electric cyan
  [0.75, "#8A2BE2"],  // high: 6 ft+, long period → violet …
  [1.0, "#FF007F"],   // … to magenta for big long-period groundswell
];

/**
 * 0..1 swell-energy index from deep-water significant height and peak period.
 * Height (ft) carries 65 % of the weight, period (s) 35 %, so a 4 ft 12 s groundswell outranks 4 ft 6 s chop.
 *   0 ft → 0, 2 ft → 0.2, 5 ft → 0.5, 8 ft+ → 1   |   period 5 s → 0, 9 s → 0.4, 14 s+ → 1
 */
export function swellEnergy(hsFt: number, tpS: number): number {
  const h = Math.min(1, Math.max(0, hsFt / 8));
  const p = Math.min(1, Math.max(0, (tpS - 5) / 9));
  return 0.65 * h + 0.35 * p;
}
export const swellColor = (hsFt: number, tpS: number): RGB => ramp(SWELL_STOPS, swellEnergy(hsFt, tpS));
export const swellHex = (hsFt: number, tpS: number) => rgbToHex(swellColor(hsFt, tpS));

// ---------------------------------------------------------------- wind alignment (coastal ribbon)
export const WIND_ALIGN = { offshore: "#00FF88", cross: "#FFB800", onshore: "#FF3366", light: "#B9D3DF" } as const;
export const WIND_STOPS: Array<[number, string]> = [[-1, WIND_ALIGN.onshore], [-0.25, WIND_ALIGN.onshore], [0, WIND_ALIGN.cross], [0.35, WIND_ALIGN.offshore], [1, WIND_ALIGN.offshore]];

/**
 * Alignment of the wind with a beach segment: +1 = blowing straight offshore (land → sea), 0 = alongshore,
 * −1 = straight onshore. `windTowardDeg` is the direction the wind blows TOWARD; `normalDeg` is the segment's
 * land→sea normal (bearing). Both compass degrees.
 */
export function windAlignment(windTowardDeg: number, normalDeg: number): number {
  return Math.cos(((windTowardDeg - normalDeg) * Math.PI) / 180);
}
export type WindTier = "offshore" | "cross" | "onshore" | "light";
export const windTier = (alignment: number, speedKts = Infinity): WindTier => speedKts < 3 ? "light" : alignment >= 0.35 ? "offshore" : alignment > -0.25 ? "cross" : "onshore";
/** Categorical ribbon colour; pale light wind is distinct from cross-shore yellow. */
export function ribbonColor(windTowardDeg: number, speedKts: number, normalDeg: number): RGB {
  const a = windAlignment(windTowardDeg, normalDeg);
  return hexToRgb(WIND_ALIGN[windTier(a, speedKts)]);
}
export const ribbonHex = (windTowardDeg: number, speedKts: number, normalDeg: number) => rgbToHex(ribbonColor(windTowardDeg, speedKts, normalDeg));

// ---------------------------------------------------------------- quality tiers (pins, callouts, hotspot)
export const TIER = { green: "#41C776", moderate: "#F3C79E", poor: "#9C9EA1" } as const;   // build-spec tokens, unchanged
export type Tier = keyof typeof TIER;
export const tierFor = (score: number): Tier => (score >= 60 ? "green" : score >= 30 ? "moderate" : "poor");

// ---------------------------------------------------------------- legend descriptors (what the HUD should show)
export const LEGEND = {
  swell: { title: "Swell Interaction", stops: SWELL_STOPS, labels: ["Low", "Medium", "High"] as const },
  wind: { title: "Wind Overlay", stops: [[0, WIND_ALIGN.offshore], [0.5, WIND_ALIGN.cross], [1, WIND_ALIGN.onshore]] as Array<[number, string]>, labels: ["Offshore", "Cross-shore", "Onshore"] as const },
  tiers: TIER,
};
export const cssGradient = (stops: Array<[number, string]>) => `linear-gradient(90deg, ${stops.map(([p, c]) => `${c} ${Math.round(p * 100)}%`).join(", ")})`;

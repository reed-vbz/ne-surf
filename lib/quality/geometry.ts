/** Angle helpers. All bearings are compass degrees (0 = N, clockwise), "from" convention. */

export const norm360 = (deg: number): number => ((deg % 360) + 360) % 360;

/** Smallest absolute difference between two bearings, 0..180. */
export const angleDiff = (a: number, b: number): number => {
  const d = Math.abs(norm360(a) - norm360(b));
  return d > 180 ? 360 - d : d;
};

/** True when `deg` lies inside the clockwise arc from `from` to `to` (arc may cross north). */
export const inSector = (deg: number, from: number, to: number): boolean => {
  const x = norm360(deg), f = norm360(from), t = norm360(to);
  return f <= t ? x >= f && x <= t : x >= f || x <= t;
};

/** Signed cross/onshore decomposition of a wind FROM `windFrom` at a spot facing `facing`. */
export const windComponents = (speed: number, windFrom: number, facing: number) => {
  // Offshore wind blows from the land toward the sea, i.e. FROM (facing + 180).
  const offshoreFrom = norm360(facing + 180);
  const rel = (norm360(windFrom - offshoreFrom) * Math.PI) / 180;
  return {
    offshore: speed * Math.cos(rel),          // + = offshore, - = onshore
    cross: Math.abs(speed * Math.sin(rel)),   // side-shore magnitude
  };
};

/** Smooth 1 → 0 falloff: full credit inside `flat`, zero at `zero`. Cosine-shaped between. */
export const falloff = (x: number, flat: number, zero: number): number => {
  if (x <= flat) return 1;
  if (x >= zero) return 0;
  const t = (x - flat) / (zero - flat);
  return 0.5 * (1 + Math.cos(Math.PI * t));
};

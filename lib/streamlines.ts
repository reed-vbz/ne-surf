/**
 * Streamline integration for the GPU flow layers (Layer 1). Seeds are laid on a jittered grid over the ocean,
 * each integrated forward and backward through a vector field with RK2 (midpoint), producing polylines the
 * deck.gl TripsLayer renders as comets. Each line carries a random phase and a random length so the field reads
 * as a continuous flow rather than a grid of streaks that all start and stop together. All geometry is lon/lat.
 */
export interface FlowField { at(lat: number, lon: number): { u: number; v: number; speed: number } | null }
export interface Streamline { path: Array<[number, number]>; speed: number; phase: number; rank: number }   // phase ∈ [0,1) staggers the comet; rank ∈ [0,1) lets the renderer thin the field at low zoom

export function integrateStreamlines(field: FlowField, bbox: { south: number; north: number; west: number; east: number }, isOcean: (lat: number, lon: number) => boolean,
  opts: { seedsAcross?: number; stepM?: number; maxSteps?: number; seed?: number } = {}): Streamline[] {
  const { seedsAcross = 34, stepM = 220, maxSteps = 60, seed = 7 } = opts;
  let s = seed; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const kx = 111320 * Math.cos(((bbox.south + bbox.north) / 2 * Math.PI) / 180), ky = 110540;
  const dlon = (bbox.east - bbox.west) / seedsAcross, dlat = dlon * (kx / ky);
  const out: Streamline[] = [];
  const step = (lat: number, lon: number, dir: 1 | -1): [number, number] | null => {
    const a = field.at(lat, lon); if (!a) return null;
    const midLat = lat + (dir * a.v * stepM * 0.5) / ky, midLon = lon + (dir * a.u * stepM * 0.5) / kx;
    const b = field.at(midLat, midLon) ?? a;
    const nl = lat + (dir * b.v * stepM) / ky, no = lon + (dir * b.u * stepM) / kx;
    return isOcean(nl, no) && nl > bbox.south && nl < bbox.north && no > bbox.west && no < bbox.east ? [nl, no] : null;
  };
  for (let lat = bbox.south; lat < bbox.north; lat += dlat) for (let lon = bbox.west; lon < bbox.east; lon += dlon) {
    const la = lat + rnd() * dlat, lo = lon + rnd() * dlon;
    if (!isOcean(la, lo)) continue;
    const a0 = field.at(la, lo); if (!a0) continue;
    const phase = rnd(), rank = rnd(), steps = Math.round(maxSteps * (0.55 + 0.45 * rnd()));
    const fwd: Array<[number, number]> = []; let p: [number, number] | null = [la, lo];
    for (let i = 0; i < steps && p; i++) { p = step(p[0], p[1], 1); if (p) fwd.push([p[1], p[0]]); }
    const bwd: Array<[number, number]> = []; p = [la, lo];
    for (let i = 0; i < steps && p; i++) { p = step(p[0], p[1], -1); if (p) bwd.push([p[1], p[0]]); }
    const path = [...bwd.reverse(), [lo, la] as [number, number], ...fwd];
    if (path.length >= 6) out.push({ path, speed: a0.speed, phase, rank });
  }
  return out;
}

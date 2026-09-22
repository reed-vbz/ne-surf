/**
 * Bathymetry-driven wave refraction for one break (Step 3).
 *
 * Linear-theory phase speed c(h, T) from the dispersion relation ω² = g k tanh(k h); rays are traced from deep
 * water toward the beach with Snell's law in gradient form (dθ/ds = −(1/c) ∂c/∂n), which reduces to
 * sin θ₂ = (c₂ / c₁) sin θ₁ across each depth step. Wavefronts (crest lines) join points of equal travel time
 * across the ray fan, so they bend parallel to the depth contours as the swell shoals.
 *
 * Input: a small CRM depth tile around the break (metres, positive down; ≤ 0 = land) from data/bathy-tiles.json.
 */
export interface DepthTile { lat0: number; lon0: number; res: number; nlat: number; nlon: number; depth: number[] }   // row-major, lat ascending
export interface Crest { points: Array<[number, number]>; t: number }   // lon/lat polyline, travel time (s)
export interface RayField { rays: Array<Array<[number, number]>>; times: number[][]; depths: number[][]; tMax: number; breakingHeightM: number | null }
export interface Refraction extends RayField { crests: Crest[] }

const G = 9.81;

/** Phase speed for period T at depth h (Newton on the dispersion relation, 6 iterations is plenty). */
export function phaseSpeed(h: number, T: number): number {
  if (h <= 0.05) h = 0.05;
  const w = (2 * Math.PI) / T;
  let k = (w * w) / G;                                 // deep-water start
  for (let i = 0; i < 6; i++) { const th = Math.tanh(k * h); const f = G * k * th - w * w; const df = G * th + G * k * h * (1 - th * th); k -= f / df; }
  return w / k;
}

function sampler(tile: DepthTile) {
  const { lat0, lon0, res, nlat, nlon, depth } = tile;
  return (lat: number, lon: number): number | null => {
    const fi = (lat - lat0) / res, fj = (lon - lon0) / res;
    const i0 = Math.floor(fi), j0 = Math.floor(fj);
    if (i0 < 0 || j0 < 0 || i0 >= nlat - 1 || j0 >= nlon - 1) return null;
    const ti = fi - i0, tj = fj - j0;
    const d = (i: number, j: number) => depth[i * nlon + j];
    return d(i0, j0) * (1 - ti) * (1 - tj) + d(i0 + 1, j0) * ti * (1 - tj) + d(i0, j0 + 1) * (1 - ti) * tj + d(i0 + 1, j0 + 1) * ti * tj;
  };
}

/**
 * Trace a fan of rays for a swell arriving FROM `dirFromDeg` with period `tpS` and deep-water height `h0M`,
 * starting on a line `startKm` offshore of the break, and build crest lines every `crestEverySec` of travel time.
 */
export function traceRays(tile: DepthTile, breakLat: number, breakLon: number, dirFromDeg: number, tpS: number, h0M: number,
  opts: { rays?: number; spanM?: number; startKm?: number; stepM?: number; runKm?: number } = {}): RayField {
  const { rays: nRays = 21, spanM = 4000, startKm = 6, stepM = 60, runKm = startKm + 5 } = opts;   // runKm: rays stop after this distance (a shore-parallel swell would otherwise run for tens of km)
  const maxSteps = Math.round((runKm * 1000) / stepM);
  const depthAt = sampler(tile);
  const kx = 111320 * Math.cos((breakLat * Math.PI) / 180), ky = 110540;   // m per degree
  const travel = ((dirFromDeg + 180) * Math.PI) / 180;                      // direction of propagation (toward)
  const ux = Math.sin(travel), uy = Math.cos(travel);                        // unit vector, x = east, y = north
  const px = -uy, py = ux;                                                  // perpendicular (along the crest)
  // start line: startKm up-wave of the break, spanM wide
  const sx = breakLon + (-ux * startKm * 1000) / kx, sy = breakLat + (-uy * startKm * 1000) / ky;
  const rays: Array<Array<[number, number]>> = [], times: number[][] = [], depths: number[][] = [];
  const c0 = phaseSpeed(2000, tpS);
  const maxTurn = 0.035;                                                   // rad per step: caps the swing a noisy 90 m cell can inflict
  for (let r = 0; r < nRays; r++) {
    const off = (r / (nRays - 1) - 0.5) * spanM;
    let x = sx + (px * off) / kx, y = sy + (py * off) / ky;
    let theta = Math.atan2(ux, uy);                       // ray heading, radians clockwise from north
    let cPrev = c0, t = 0;
    const pts: Array<[number, number]> = [[x, y]], ts: number[] = [0], hs: number[] = [depthAt(y, x) ?? 2000];
    for (let s = 0; s < maxSteps; s++) {
      const h = depthAt(y, x); if (h === null || h <= 0.3) break;   // hit land or left the tile
      const c = phaseSpeed(h, tpS);
      // gradient of c across the ray (finite difference perpendicular to heading), Snell in gradient form
      const nx = Math.cos(theta), ny = -Math.sin(theta);              // left-hand normal (east, north)
      const dn = 150;                                                 // metres (wider than one CRM cell: smoother turning)
      const hL = depthAt(y + (ny * dn) / ky, x + (nx * dn) / kx), hR = depthAt(y - (ny * dn) / ky, x - (nx * dn) / kx);
      if (hL !== null && hR !== null && hL > 0.3 && hR > 0.3) {
        const dcdn = (phaseSpeed(hL, tpS) - phaseSpeed(hR, tpS)) / (2 * dn);
        theta += Math.max(-maxTurn, Math.min(maxTurn, -(dcdn / c) * stepM));   // dθ/ds = −(1/c) ∂c/∂n  (bends toward shallower water)
      }
      x += (Math.sin(theta) * stepM) / kx; y += (Math.cos(theta) * stepM) / ky;
      t += stepM / ((c + cPrev) / 2); cPrev = c;
      pts.push([x, y]); ts.push(t); hs.push(h);
    }
    rays.push(pts); times.push(ts); depths.push(hs);
  }
  const tMax = Math.max(0, ...times.map((ts) => ts[ts.length - 1]));
  const breakingHeightM = h0M > 0 ? 0.39 * Math.pow(G, 0.2) * Math.pow(tpS * h0M * h0M, 0.4) : null;   // Komar & Gaughan
  return { rays, times, depths, tMax, breakingHeightM };
}

/**
 * Crest lines (wavefronts): the point on every ray at equal travel time, every `everySec`, offset by `phaseSec` for
 * animation. Only the refracting part is drawn (`maxDepth`, metres): in deep water the crests are straight and add
 * nothing. Where neighbouring rays have crossed (a caustic) the crest folds back on itself — those points are
 * dropped — and the line is Chaikin-smoothed once so it reads as a wavefront, not a polyline through noise.
 */
export function crestsAt(rf: RayField, phaseSec: number, everySec = 25, maxDepth = Infinity): Crest[] {
  const crests: Crest[] = [];
  for (let T = phaseSec; T < rf.tMax; T += everySec) {
    if (T <= 0) continue;
    const runs: Array<Array<[number, number]>> = [[]];
    rf.rays.forEach((ray, r) => {
      const ts = rf.times[r]; const k = ts.findIndex((v) => v >= T);
      if (k <= 0 || rf.depths[r][k] > maxDepth) { if (runs[runs.length - 1].length) runs.push([]); return; }
      const f = (T - ts[k - 1]) / (ts[k] - ts[k - 1]);
      const run = runs[runs.length - 1];
      const pt: [number, number] = [ray[k - 1][0] + (ray[k][0] - ray[k - 1][0]) * f, ray[k - 1][1] + (ray[k][1] - ray[k - 1][1]) * f];
      if (run.length >= 2) {   // fold test: keep the crest advancing along its own tangent
        const a = run[run.length - 2], b = run[run.length - 1];
        if ((b[0] - a[0]) * (pt[0] - b[0]) + (b[1] - a[1]) * (pt[1] - b[1]) < 0) return;
      }
      run.push(pt);
    });
    for (const run of runs) if (run.length >= 3) crests.push({ points: chaikin(run), t: T });
  }
  return crests;
}

function chaikin(pts: Array<[number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    out.push([0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1], [0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

export function refract(tile: DepthTile, breakLat: number, breakLon: number, dirFromDeg: number, tpS: number, h0M: number,
  opts: { rays?: number; spanM?: number; startKm?: number; stepM?: number; crestEverySec?: number } = {}): Refraction {
  const rf = traceRays(tile, breakLat, breakLon, dirFromDeg, tpS, h0M, opts);
  return { ...rf, crests: crestsAt(rf, opts.crestEverySec ?? 25, opts.crestEverySec ?? 25) };
}

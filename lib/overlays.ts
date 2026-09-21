/**
 * Per-step overlay rasters, all driven by the timeline's current step.
 *   swellQuality*   ocean shading + streamline colour: blue/teal = clean long-period groundswell, orange/yellow = messy windswell
 *   windShade*      coastal land band: green = offshore, grey = alongshore, orange = onshore (fades inland)
 * Both are cut on the same 1 km land mask (data/coast.json) so they meet exactly at the shoreline.
 */
import type { Flat, GridIndex, HrrrStep, Ww3Step } from "./cache";
import coastJson from "@/data/coast.json";
import { cellIndex } from "./grid";

export interface Coast { res: number; lat0: number; lon0: number; nlat: number; nlon: number; band: number; cells: number[][]; land_mask_b64: string }
export const COAST = coastJson as Coast;

let landBits: Uint8Array | null = null;
function landMask(): Uint8Array {
  if (!landBits) { const bin = atob(COAST.land_mask_b64); landBits = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) landBits[i] = bin.charCodeAt(i); }
  return landBits;
}
/** True where the 1 km mask says land. Outside the mask → false. */
export function isLand(lat: number, lon: number): boolean {
  const i = Math.round((lat - COAST.lat0) / COAST.res), j = Math.round((lon - COAST.lon0) / COAST.res);
  if (i < 0 || j < 0 || i >= COAST.nlat || j >= COAST.nlon) return false;
  const bit = i * COAST.nlon + j;
  return (landMask()[bit >> 3] >> (7 - (bit & 7)) & 1) === 1;
}

export type RGBA = [number, number, number, number];
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mix = (c1: RGBA, c2: RGBA, t: number): RGBA => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t), lerp(c1[3], c2[3], t)].map(Math.round) as RGBA;
const ramp = (stops: Array<[number, RGBA]>, v: number): RGBA => {
  if (v <= stops[0][0]) return stops[0][1];
  for (let i = 0; i < stops.length - 1; i++) if (v <= stops[i + 1][0]) return mix(stops[i][1], stops[i + 1][1], (v - stops[i][0]) / (stops[i + 1][0] - stops[i][0]));
  return stops[stops.length - 1][1];
};

/** 0 = messy short-period windswell, 1 = clean long-period groundswell, per WW3 cell. null = land. */
export function swellQuality(step: Ww3Step): Flat {
  const f = step.fields;
  const n = f.hs.length; const out: Flat = new Array(n);
  for (let k = 0; k < n; k++) {
    const hs = f.hs[k];
    if (hs == null) { out[k] = null; continue; }
    const e = (x?: number | null) => (x == null ? 0 : x * x);
    const swellE = e(f.swell1_hs?.[k]) + e(f.swell2_hs?.[k]) + e(f.swell3_hs?.[k]);
    const totalE = Math.max(hs * hs, swellE + e(f.wind_hs?.[k]), 1e-6);
    const clean = Math.min(1, swellE / totalE);                          // energy fraction that is swell
    const tp = f.swell1_tp?.[k] ?? f.tp[k] ?? 0;
    const period = Math.min(1, Math.max(0, (tp - 6) / 8));               // 6 s → 0, 14 s → 1
    out[k] = 0.55 * clean + 0.45 * period;
  }
  return out;
}

// vivid, fixed-alpha palettes (readability over subtlety)
export const SWELL_HEX = ["#ff6a00", "#ffc400", "#16c3b0", "#1f6dff", "#1230c8"];
const SWELL_STOPS: Array<[number, RGBA]> = [[0, [255, 106, 0, 255]], [0.28, [255, 196, 0, 255]], [0.52, [22, 195, 176, 255]], [0.78, [31, 109, 255, 255]], [1, [18, 48, 200, 255]]];
export const swellQualityColor = (q: number): RGBA => ramp(SWELL_STOPS, q);

export const WIND_HEX = { offshore: "#1fe06b", cross: "#8b95a3", onshore: "#ff5a1f" };
const WIND_STOPS: Array<[number, RGBA]> = [[-1, [255, 90, 31, 255]], [-0.25, [232, 120, 60, 255]], [0, [139, 149, 163, 255]], [0.25, [70, 200, 110, 255]], [1, [31, 224, 107, 255]]];

/** Nearest-neighbour fill of null (land-masked) WW3 cells from wet neighbours, `passes` cells deep, so the field reaches the shoreline. */
function extend(f: Flat, nlat: number, nlon: number, passes = 2): Flat {
  let cur = f.slice();
  for (let p = 0; p < passes; p++) {
    const next = cur.slice();
    for (let i = 0; i < nlat; i++) for (let j = 0; j < nlon; j++) {
      const k = i * nlon + j; if (cur[k] != null) continue;
      let acc = 0, n = 0;
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
        const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= nlat || jj >= nlon) continue;
        const v = cur[ii * nlon + jj]; if (v != null) { acc += v; n++; }
      }
      if (n) next[k] = acc / n;
    }
    cur = next;
  }
  return cur;
}

/** Ocean shading: bilinear over the WW3 grid, extended to the coast, cut on the 1 km land mask. */
export function swellShadeDataUrl(index: GridIndex, step: Ww3Step, quality: Flat, scale = 12): string {
  const [nlat, nlon] = index.shape;
  const q = extend(quality, nlat, nlon);
  const c = document.createElement("canvas"); c.width = nlon * scale; c.height = nlat * scale;
  const ctx = c.getContext("2d")!; const img = ctx.createImageData(c.width, c.height);
  const lat0 = index.lat[0], lat1 = index.lat[nlat - 1], lon0 = index.lon[0], lon1 = index.lon[nlon - 1];
  const sample = (f: Flat, fi: number, fj: number): number | null => {
    const i0 = Math.floor(fi), j0 = Math.floor(fj), ti = fi - i0, tj = fj - j0;
    let acc = 0, wsum = 0;
    for (const [di, dj, w] of [[0, 0, (1 - ti) * (1 - tj)], [1, 0, ti * (1 - tj)], [0, 1, (1 - ti) * tj], [1, 1, ti * tj]] as const) {
      const i = i0 + di, j = j0 + dj; if (i < 0 || j < 0 || i >= nlat || j >= nlon || w === 0) continue;
      const v = f[i * nlon + j]; if (v == null) continue;
      acc += v * w; wsum += w;
    }
    return wsum < 0.2 ? null : acc / wsum;
  };
  for (let y = 0; y < c.height; y++) {
    const fi = (c.height - 1 - y + 0.5) / scale - 0.5;
    const lat = lat0 + (lat1 - lat0) * ((c.height - 1 - y + 0.5) / c.height);
    for (let x = 0; x < c.width; x++) {
      const fj = (x + 0.5) / scale - 0.5;
      const lon = lon0 + (lon1 - lon0) * ((x + 0.5) / c.width);
      if (isLand(lat, lon)) continue;
      const v = sample(q, fi, fj); if (v === null) continue;
      const col = swellQualityColor(v);
      const edge = Math.min(1, Math.min(x, c.width - 1 - x, y, c.height - 1 - y) / (2 * scale));
      const p = (y * c.width + x) * 4;
      img.data[p] = col[0]; img.data[p + 1] = col[1]; img.data[p + 2] = col[2]; img.data[p + 3] = Math.round(255 * edge);
    }
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL("image/png");
}

/** Coastal band raster from the current wind field (HRRR, or the GFS wind on the WW3 grid beyond 48 h). */
export function windShadeDataUrl(wind: { index: GridIndex; step: HrrrStep } | { index: GridIndex; step: Ww3Step } | null): string | null {
  if (!wind) return null;
  const { nlat, nlon, lat0, lon0, res, band, cells } = COAST;
  const c = document.createElement("canvas"); c.width = nlon; c.height = nlat;
  const ctx = c.getContext("2d")!; const img = ctx.createImageData(nlon, nlat);
  const isHrrr = "u10" in wind.step.fields;
  const uv = (lat: number, lon: number): [number, number] | null => {
    const k = cellIndex(wind.index, lat, lon); if (k === null) return null;
    if (isHrrr) { const f = (wind.step as HrrrStep).fields; return f.u10[k] == null || f.v10[k] == null ? null : [f.u10[k]!, f.v10[k]!]; }
    const f = (wind.step as Ww3Step).fields; const s = f.wind_speed?.[k], d = f.wind_dir?.[k];
    if (s == null || d == null) return null;
    const r = ((d + 180) * Math.PI) / 180; return [s * Math.sin(r), s * Math.cos(r)];   // toward
  };
  // GFS wind on the WW3 grid is land-masked: borrow the nearest wet cell so the band is never left blank
  const uvNear = (lat: number, lon: number): [number, number] | null => {
    const direct = uv(lat, lon); if (direct) return direct;
    for (const d of [0.1, 0.2, 0.35]) for (const [dl, dn] of [[0, d], [0, -d], [d, 0], [-d, 0], [d, d], [-d, -d], [d, -d], [-d, d]]) { const v = uv(lat + dl, lon + dn); if (v) return v; }
    return null;
  };
  for (const [i, j, normal, dist] of cells) {
    const w = uvNear(lat0 + i * res, lon0 + j * res); if (!w) continue;
    const speed = Math.hypot(w[0], w[1]);
    const nr = (normal * Math.PI) / 180;
    const offshore = speed < 0.3 ? 0 : (w[0] * Math.sin(nr) + w[1] * Math.cos(nr)) / speed;   // +1 land→sea
    const col = ramp(WIND_STOPS, offshore);
    const strength = 0.55 + 0.45 * Math.min(1, speed / 8);                                     // calm still shows as grey
    const fade = 1 - 0.75 * ((dist - 1) / band);                                                // 1 at the waterline → 0.25 inland
    const p = ((nlat - 1 - i) * nlon + j) * 4;
    img.data[p] = col[0]; img.data[p + 1] = col[1]; img.data[p + 2] = col[2]; img.data[p + 3] = Math.round(255 * strength * fade);
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL("image/png");
}

/**
 * Map layer rasters and vector fields for the build spec (docs: "NE Surf Overview — Build Spec").
 *   zonesDataUrl      layer 1: surf-quality zones (green / peach / grey) feathered around the breaks, ocean only
 *   bathyDataUrl      layer 1 alt: refraction-map depth shade from data/bathy-grid.json
 *   windVectorField   layer 2: bilinear 10 m wind (HRRR, or GFS on the wave grid beyond 48 h), ocean only
 *   windShadeDataUrl  coastal wind band (offshore → cross-shore → onshore), spec wind gradient
 * Everything is cut on the same 1 km land mask (data/coast.json), so land is never tinted.
 */
import type { Flat, GridIndex, HrrrStep, Ww3Step } from "./cache";
import coastJson from "@/data/coast.json";
import bathyJson from "@/data/bathy-grid.json";
import { cellIndex } from "./grid";
import { swellColor } from "./colors";

export interface Coast { res: number; lat0: number; lon0: number; nlat: number; nlon: number; band: number; cells: number[][]; land_mask_b64: string }
export const COAST = coastJson as Coast;
interface BathyGrid { res: number; lat0: number; lon0: number; nlat: number; nlon: number; data_b64: string }
const BATHY = bathyJson as BathyGrid;

const b64 = (s: string) => { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
let landBits: Uint8Array | null = null;
export function isLand(lat: number, lon: number): boolean {
  if (!landBits) landBits = b64(COAST.land_mask_b64);
  const i = Math.round((lat - COAST.lat0) / COAST.res), j = Math.round((lon - COAST.lon0) / COAST.res);
  if (i < 0 || j < 0 || i >= COAST.nlat || j >= COAST.nlon) return false;
  const bit = i * COAST.nlon + j;
  return ((landBits[bit >> 3] >> (7 - (bit & 7))) & 1) === 1;
}

export type RGBA = [number, number, number, number];
export const TOKENS = {
  good: "#41C776", moderate: "#F3C79E", poor: "#9C9EA1", streamline: "#64D5CC", accent: "#4798B7", chrome: "#0E2029",
  swellGrad: ["#64D5CC", "#4798B7", "#2B5BC7", "#163797"], windGrad: ["#27A055", "#A8C24A", "#F0A24A", "#E66729"],
};
export type Band = "good" | "moderate" | "poor";
export const bandFor = (score: number): Band => (score >= 60 ? "good" : score >= 30 ? "moderate" : "poor");
export const BAND_HEX: Record<Band, string> = { good: TOKENS.good, moderate: TOKENS.moderate, poor: TOKENS.poor };
export const BAND_WORD: Record<Band, string> = { good: "EXCELLENT", moderate: "MODERATE", poor: "POOR" };
const hex = (h: string): RGBA => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 255];
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mix = (c1: RGBA, c2: RGBA, t: number): RGBA => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t), lerp(c1[3], c2[3], t)].map(Math.round) as RGBA;
const ramp = (stops: Array<[number, RGBA]>, v: number): RGBA => {
  if (v <= stops[0][0]) return stops[0][1];
  for (let i = 0; i < stops.length - 1; i++) if (v <= stops[i + 1][0]) return mix(stops[i][1], stops[i + 1][1], (v - stops[i][0]) / (stops[i + 1][0] - stops[i][0]));
  return stops[stops.length - 1][1];
};

/** Canvas covering the coast grid (0.0125°, 521×401) with a per-pixel painter; returns a data URL. */
function paintCoastGrid(paint: (lat: number, lon: number) => RGBA | null, upscale = 1, blurPx = 0): string {
  const { nlat, nlon, lat0, lon0, res } = COAST;
  const c = document.createElement("canvas"); c.width = nlon; c.height = nlat;
  const ctx = c.getContext("2d")!; const img = ctx.createImageData(nlon, nlat);
  for (let i = 0; i < nlat; i++) { const lat = lat0 + i * res; const row = nlat - 1 - i;
    for (let j = 0; j < nlon; j++) { const col = paint(lat, lon0 + j * res); if (!col) continue;
      const p = (row * nlon + j) * 4; img.data[p] = col[0]; img.data[p + 1] = col[1]; img.data[p + 2] = col[2]; img.data[p + 3] = col[3]; } }
  ctx.putImageData(img, 0, 0);
  if (upscale === 1 && !blurPx) return c.toDataURL("image/png");
  const o = document.createElement("canvas"); o.width = nlon * upscale; o.height = nlat * upscale;
  const octx = o.getContext("2d")!; octx.imageSmoothingEnabled = true; octx.imageSmoothingQuality = "high";
  if (blurPx) octx.filter = `blur(${blurPx}px)`;
  octx.drawImage(c, 0, 0, o.width, o.height);
  return o.toDataURL("image/png");
}

export interface ZoneSpot { lat: number; lon: number; band: Band }

/**
 * Surf-quality zones: each break paints its band colour into the ocean around it with a Gaussian falloff
 * (σ ≈ 22 km), blended by weight, at ≤65 % opacity, so zones feather into the open sea and into each other.
 */
export function zonesDataUrl(spots: ZoneSpot[]): string {
  const cols = spots.map((s) => hex(BAND_HEX[s.band]));
  const sigma = 22, reach = 70; // km
  return paintCoastGrid((lat, lon) => {
    if (isLand(lat, lon)) return null;
    let r = 0, g = 0, b = 0, w = 0;
    const kx = 111.32 * Math.cos((lat * Math.PI) / 180);
    for (let k = 0; k < spots.length; k++) {
      const dx = (lon - spots[k].lon) * kx, dy = (lat - spots[k].lat) * 111.32; const d2 = dx * dx + dy * dy;
      if (d2 > reach * reach) continue;
      const wk = Math.exp(-d2 / (2 * sigma * sigma));
      r += cols[k][0] * wk; g += cols[k][1] * wk; b += cols[k][2] * wk; w += wk;
    }
    if (w < 0.02) return null;
    const a = Math.min(0.65, w * 0.9);                  // fades out ~2σ from the nearest break
    return [Math.round(r / w), Math.round(g / w), Math.round(b / w), Math.round(255 * a)];
  }, 2, 1.2);
}

/** Refraction map: depth shade from the coarse CRM grid, shallow = cyan, deep = navy; ocean only. */
export function bathyDataUrl(): string {
  const q = b64(BATHY.data_b64);
  const stops: Array<[number, RGBA]> = [[0, hex("#9ff0e8")], [0.25, hex(TOKENS.swellGrad[0])], [0.5, hex(TOKENS.swellGrad[1])], [0.75, hex(TOKENS.swellGrad[2])], [1, hex(TOKENS.swellGrad[3])]];
  return paintCoastGrid((lat, lon) => {
    if (isLand(lat, lon)) return null;
    const i = Math.round((lat - BATHY.lat0) / BATHY.res), j = Math.round((lon - BATHY.lon0) / BATHY.res);
    if (i < 0 || j < 0 || i >= BATHY.nlat || j >= BATHY.nlon) return null;
    const v = q[i * BATHY.nlon + j]; if (!v) return null;
    const c = ramp(stops, (v - 1) / 254); return [c[0], c[1], c[2], 190];
  }, 2, 0.8);
}

/** Uniform navy wash over water so the ocean reads as one surface under the zones (spec: satellite, no tint on land). */
export function oceanTintDataUrl(): string {
  const c = hex(TOKENS.swellGrad[3]);
  return paintCoastGrid((lat, lon) => (isLand(lat, lon) ? null : [c[0], c[1], c[2], 80]), 1, 0);
}

export interface VectorField { at(lat: number, lon: number): { u: number; v: number; speed: number } | null; bounds: { lat0: number; lat1: number; lon0: number; lon1: number } }

/** Bilinear 10 m wind (m/s, toward) on HRRR or GFS, including shoreline and land samples. */
export function windVectorField(src: { index: GridIndex; step: HrrrStep } | { index: GridIndex; step: Ww3Step }): VectorField {
  const { index } = src; const [nlat, nlon] = index.shape;
  let u: Flat, v: Flat;
  if ("u10" in src.step.fields) { u = src.step.fields.u10; v = src.step.fields.v10; }
  else {
    const f = src.step.fields; u = new Array(nlat * nlon); v = new Array(nlat * nlon);
    for (let k = 0; k < nlat * nlon; k++) { const s = f.wind_speed?.[k], d = f.wind_dir?.[k];
      if (s == null || d == null) { u[k] = null; v[k] = null; continue; } const r = ((d + 180) * Math.PI) / 180; u[k] = s * Math.sin(r); v[k] = s * Math.cos(r); }
    // the wave grid is land-masked: borrow neighbours so lines reach the shore
    for (let pass = 0; pass < 2; pass++) { const nu = u.slice(), nv = v.slice();
      for (let i = 0; i < nlat; i++) for (let j = 0; j < nlon; j++) { const k = i * nlon + j; if (u[k] != null) continue; let au = 0, av = 0, n = 0;
        for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) { const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= nlat || jj >= nlon) continue; const kk = ii * nlon + jj; if (u[kk] != null) { au += u[kk]!; av += v[kk]!; n++; } }
        if (n) { nu[k] = au / n; nv[k] = av / n; } }
      u = nu; v = nv; }
  }
  const lat0 = index.lat[0], lat1 = index.lat[nlat - 1], lon0 = index.lon[0], lon1 = index.lon[nlon - 1];
  const bil = (f: Flat, fi: number, fj: number): number | null => {
    const i0 = Math.floor(fi), j0 = Math.floor(fj), ti = fi - i0, tj = fj - j0; let acc = 0, ws = 0;
    for (const [di, dj, w] of [[0, 0, (1 - ti) * (1 - tj)], [1, 0, ti * (1 - tj)], [0, 1, (1 - ti) * tj], [1, 1, ti * tj]] as const) {
      const i = i0 + di, j = j0 + dj; if (i < 0 || j < 0 || i >= nlat || j >= nlon) continue; const x = f[i * nlon + j]; if (x == null) continue; acc += x * w; ws += w; }
    return ws < 0.3 ? null : acc / ws;
  };
  return {
    at(lat, lon) {
      if (lat < lat0 || lat > lat1 || lon < lon0 || lon > lon1) return null;
      const fi = ((lat - lat0) / (lat1 - lat0)) * (nlat - 1), fj = ((lon - lon0) / (lon1 - lon0)) * (nlon - 1);
      const uu = bil(u, fi, fj), vv = bil(v, fi, fj); if (uu === null || vv === null) return null;
      const s = Math.hypot(uu, vv) || 1e-6; return { u: uu / s, v: vv / s, speed: s };
    },
    bounds: { lat0, lat1, lon0, lon1 },
  };
}

const WIND_STOPS: Array<[number, RGBA]> = [[-1, hex(TOKENS.windGrad[3])], [-0.2, hex(TOKENS.windGrad[2])], [0.2, hex(TOKENS.windGrad[1])], [1, hex(TOKENS.windGrad[0])]];

/** Coastal band: land within ~5 km of water coloured by the wind's component on the local coast normal. */
export function windShadeDataUrl(src: { index: GridIndex; step: HrrrStep } | { index: GridIndex; step: Ww3Step } | null): string | null {
  if (!src) return null;
  const { nlat, nlon, lat0, lon0, res, band, cells } = COAST;
  const isHrrr = "u10" in src.step.fields;
  const uv = (lat: number, lon: number): [number, number] | null => {
    const k = cellIndex(src.index, lat, lon); if (k === null) return null;
    if (isHrrr) { const f = (src.step as HrrrStep).fields; return f.u10[k] == null || f.v10[k] == null ? null : [f.u10[k]!, f.v10[k]!]; }
    const f = (src.step as Ww3Step).fields; const s = f.wind_speed?.[k], d = f.wind_dir?.[k]; if (s == null || d == null) return null;
    const r = ((d + 180) * Math.PI) / 180; return [s * Math.sin(r), s * Math.cos(r)];
  };
  const uvNear = (lat: number, lon: number): [number, number] | null => {
    const d0 = uv(lat, lon); if (d0) return d0;
    for (const d of [0.1, 0.2, 0.35]) for (const [dl, dn] of [[0, d], [0, -d], [d, 0], [-d, 0], [d, d], [-d, -d], [d, -d], [-d, d]]) { const x = uv(lat + dl, lon + dn); if (x) return x; }
    return null;
  };
  const c = document.createElement("canvas"); c.width = nlon; c.height = nlat;
  const ctx = c.getContext("2d")!; const img = ctx.createImageData(nlon, nlat);
  for (const [i, j, normal, dist] of cells) {
    const w = uvNear(lat0 + i * res, lon0 + j * res); if (!w) continue;
    const speed = Math.hypot(w[0], w[1]); const nr = (normal * Math.PI) / 180;
    const offshore = speed < 0.3 ? 0 : (w[0] * Math.sin(nr) + w[1] * Math.cos(nr)) / speed;
    const col = ramp(WIND_STOPS, offshore);
    const strength = 0.5 + 0.5 * Math.min(1, speed / 8), fade = 1 - 0.8 * ((dist - 1) / band);
    const p = ((nlat - 1 - i) * nlon + j) * 4; img.data[p] = col[0]; img.data[p + 1] = col[1]; img.data[p + 2] = col[2]; img.data[p + 3] = Math.round(255 * strength * fade);
  }
  ctx.putImageData(img, 0, 0);
  const o = document.createElement("canvas"); o.width = nlon * 2; o.height = nlat * 2;
  const octx = o.getContext("2d")!; octx.imageSmoothingEnabled = true; octx.imageSmoothingQuality = "high"; octx.filter = "blur(1.6px)"; octx.drawImage(c, 0, 0, o.width, o.height);
  return o.toDataURL("image/png");
}


/**
 * Swell-energy canvas (Step 2): WW3 significant height + peak period → navy / cyan / violet / magenta.
 * Bilinear over the 1/6° grid, extended to the shoreline; the 1 km mask is only a coarse pre-cut here —
 * the high-resolution land fill layer above does the real clipping.
 */
export function swellEnergyDataUrl(index: GridIndex, step: Ww3Step, scale = 12): string {
  const [nlat, nlon] = index.shape;
  const ext = (f: Flat) => { let cur = f.slice(); for (let p = 0; p < 3; p++) { const next = cur.slice();
    for (let i = 0; i < nlat; i++) for (let j = 0; j < nlon; j++) { const k = i * nlon + j; if (cur[k] != null) continue; let acc = 0, n = 0;
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) { const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= nlat || jj >= nlon) continue; const v = cur[ii * nlon + jj]; if (v != null) { acc += v; n++; } }
      if (n) next[k] = acc / n; } cur = next; } return cur; };
  const hs = ext(step.fields.hs), tp = ext(step.fields.tp);
  const c = document.createElement("canvas"); c.width = nlon * scale; c.height = nlat * scale;
  const ctx = c.getContext("2d")!; const img = ctx.createImageData(c.width, c.height);
  const lat0 = index.lat[0], lat1 = index.lat[nlat - 1], lon0 = index.lon[0], lon1 = index.lon[nlon - 1];
  const bil = (f: Flat, fi: number, fj: number): number | null => {
    const i0 = Math.floor(fi), j0 = Math.floor(fj), ti = fi - i0, tj = fj - j0; let acc = 0, ws = 0;
    for (const [di, dj, w] of [[0, 0, (1 - ti) * (1 - tj)], [1, 0, ti * (1 - tj)], [0, 1, (1 - ti) * tj], [1, 1, ti * tj]] as const) {
      const i = i0 + di, j = j0 + dj; if (i < 0 || j < 0 || i >= nlat || j >= nlon) continue; const v = f[i * nlon + j]; if (v == null) continue; acc += v * w; ws += w; }
    return ws < 0.2 ? null : acc / ws;
  };
  for (let y = 0; y < c.height; y++) {
    const fi = (c.height - 1 - y + 0.5) / scale - 0.5, lat = lat0 + (lat1 - lat0) * ((c.height - 1 - y + 0.5) / c.height);
    for (let x = 0; x < c.width; x++) {
      const fj = (x + 0.5) / scale - 0.5, lon = lon0 + (lon1 - lon0) * ((x + 0.5) / c.width);
      if (isLand(lat, lon)) continue;
      const h = bil(hs, fi, fj), t = bil(tp, fi, fj); if (h === null || t === null) continue;
      const col = swellColor(h * 3.28084, t);
      const edge = Math.min(1, Math.min(x, c.width - 1 - x, y, c.height - 1 - y) / (4 * scale));
      const p = (y * c.width + x) * 4; img.data[p] = col[0]; img.data[p + 1] = col[1]; img.data[p + 2] = col[2]; img.data[p + 3] = Math.round(255 * edge);
    }
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL("image/png");
}


/** Bilinear scalar sampler over a flat WW3/HRRR grid, extended 3 cells past the land mask so fields reach the shore. */
export function bilinearField(index: GridIndex, f: Flat): (lat: number, lon: number) => number | null {
  const [nlat, nlon] = index.shape;
  let cur = f.slice();
  for (let p = 0; p < 3; p++) { const next = cur.slice();
    for (let i = 0; i < nlat; i++) for (let j = 0; j < nlon; j++) { const k = i * nlon + j; if (cur[k] != null) continue; let acc = 0, n = 0;
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) { const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= nlat || jj >= nlon) continue; const v = cur[ii * nlon + jj]; if (v != null) { acc += v; n++; } }
      if (n) next[k] = acc / n; } cur = next; }
  const lat0 = index.lat[0], lat1 = index.lat[nlat - 1], lon0 = index.lon[0], lon1 = index.lon[nlon - 1];
  return (lat, lon) => {
    if (lat < lat0 || lat > lat1 || lon < lon0 || lon > lon1) return null;
    const fi = ((lat - lat0) / (lat1 - lat0)) * (nlat - 1), fj = ((lon - lon0) / (lon1 - lon0)) * (nlon - 1);
    const i0 = Math.floor(fi), j0 = Math.floor(fj), ti = fi - i0, tj = fj - j0; let acc = 0, ws = 0;
    for (const [di, dj, w] of [[0, 0, (1 - ti) * (1 - tj)], [1, 0, ti * (1 - tj)], [0, 1, (1 - ti) * tj], [1, 1, ti * tj]] as const) {
      const i = i0 + di, j = j0 + dj; if (i < 0 || j < 0 || i >= nlat || j >= nlon) continue; const v = cur[i * nlon + j]; if (v == null) continue; acc += v * w; ws += w; }
    return ws < 0.2 ? null : acc / ws;
  };
}


/** Depth (m, positive down) from the coarse CRM grid for the refraction-map canvas; null over land / no data. */
let bathyBytes: Uint8Array | null = null;
export function depthAt(lat: number, lon: number): number | null {
  if (!bathyBytes) bathyBytes = b64(BATHY.data_b64);
  const i = Math.round((lat - BATHY.lat0) / BATHY.res), j = Math.round((lon - BATHY.lon0) / BATHY.res);
  if (i < 0 || j < 0 || i >= BATHY.nlat || j >= BATHY.nlon) return null;
  const v = bathyBytes[i * BATHY.nlon + j]; if (!v) return null;
  return Math.expm1(((v - 1) / 254) * Math.log1p(300));
}

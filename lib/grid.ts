/** Helpers for the flat row-major [lat][lon] grids the workers write. */
import type { Flat, GridIndex } from "./cache";

export const BBOX = { south: 40.0, north: 45.0, west: -72.5, east: -66.0 };

export function cellIndex(idx: GridIndex, lat: number, lon: number): number | null {
  const { lat: lats, lon: lons } = idx;
  if (lat < lats[0] || lat > lats[lats.length - 1] || lon < lons[0] || lon > lons[lons.length - 1]) return null;
  const i = Math.round(((lat - lats[0]) / (lats[lats.length - 1] - lats[0])) * (lats.length - 1));
  const j = Math.round(((lon - lons[0]) / (lons[lons.length - 1] - lons[0])) * (lons.length - 1));
  return i * lons.length + j;
}

export const sample = (idx: GridIndex, field: Flat, lat: number, lon: number): number | null => {
  const k = cellIndex(idx, lat, lon);
  return k === null ? null : field[k];
};

/** Meteorological direction (from) + speed → u/v components (toward). */
export const toUV = (speed: number, fromDeg: number) => {
  const r = ((fromDeg + 180) * Math.PI) / 180;
  return { u: speed * Math.sin(r), v: speed * Math.cos(r) };
};

/** Colour ramp for wind speed in knots → rgba. Calm = transparent, 30 kt+ = deep magenta. */
export function windColor(kts: number): [number, number, number, number] {
  const stops: Array<[number, [number, number, number]]> = [
    [0, [120, 200, 255]], [8, [80, 200, 120]], [14, [250, 210, 60]], [20, [250, 120, 40]], [30, [200, 30, 120]],
  ];
  let a = stops[0], b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) if (kts >= stops[i][0] && kts <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; break; }
  const t = Math.min(1, Math.max(0, (kts - a[0]) / (b[0] - a[0] || 1)));
  const c = a[1].map((x, i) => Math.round(x + (b[1][i] - x) * t)) as [number, number, number];
  return [c[0], c[1], c[2], Math.round(40 + 160 * Math.min(1, kts / 25))];
}

/** Rasterise a grid to a PNG data URL (north row first, as an image expects). */
export function gridToDataUrl(idx: GridIndex, value: (k: number) => number | null, color: (v: number) => [number, number, number, number], scale = 4): string {
  const [nlat, nlon] = idx.shape;
  const c = document.createElement("canvas");
  c.width = nlon * scale; c.height = nlat * scale;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(c.width, c.height);
  for (let i = 0; i < nlat; i++) for (let j = 0; j < nlon; j++) {
    const v = value(i * nlon + j);
    const rgba = v === null ? [0, 0, 0, 0] : color(v);
    const row = nlat - 1 - i; // flip: image row 0 is north
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const p = ((row * scale + dy) * c.width + (j * scale + dx)) * 4;
      img.data[p] = rgba[0]; img.data[p + 1] = rgba[1]; img.data[p + 2] = rgba[2]; img.data[p + 3] = rgba[3];
    }
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL("image/png");
}

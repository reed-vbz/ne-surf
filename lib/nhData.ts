/** New Hampshire Sandbox static data (public/data/nh, produced by workers/nesurf/sandbox_nh.py). */
export const NH_BBOX = { south: 42.70, north: 43.35, west: -70.95, east: -70.15 };
/** true when (lat, lon) falls inside the depth grid (outside it depthAt() reports 0, which would read as land) */
export const inGrid = (g: DepthGrid, lat: number, lon: number) => lat >= g.lat0 && lon >= g.lon0 && lat < g.lat0 + g.nlat * g.res && lon < g.lon0 + g.nlon * g.res;

export interface DepthGrid { lat0: number; lon0: number; res: number; nlat: number; nlon: number; data: Uint16Array }

export async function loadDepth(): Promise<DepthGrid> {
  const j = await fetch("/data/nh/depth.json").then((r) => r.json());
  const bin = atob(j.data_b64); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { lat0: j.lat0, lon0: j.lon0, res: j.res, nlat: j.nlat, nlon: j.nlon, data: new Uint16Array(bytes.buffer) };
}
/** metres, positive down; 0 = land / outside */
export const depthAt = (g: DepthGrid, lat: number, lon: number): number => {
  const i = Math.round((lat - g.lat0) / g.res), j = Math.round((lon - g.lon0) / g.res);
  if (i < 0 || j < 0 || i >= g.nlat || j >= g.nlon) return 0;
  return g.data[i * g.nlon + j] / 10;
};
/** DepthTile shape for lib/refraction.ts, cut from the sandbox grid around a break (±7 km). */
export function tileAround(g: DepthGrid, lat: number, lon: number) {
  const dlat = 7000 / 110540, dlon = 7000 / (111320 * Math.cos((lat * Math.PI) / 180));
  const i0 = Math.max(0, Math.floor((lat - dlat - g.lat0) / g.res)), i1 = Math.min(g.nlat - 1, Math.ceil((lat + dlat - g.lat0) / g.res));
  const j0 = Math.max(0, Math.floor((lon - dlon - g.lon0) / g.res)), j1 = Math.min(g.nlon - 1, Math.ceil((lon + dlon - g.lon0) / g.res));
  const nlat = i1 - i0 + 1, nlon = j1 - j0 + 1, depth = new Array<number>(nlat * nlon);
  for (let i = 0; i < nlat; i++) for (let j = 0; j < nlon; j++) depth[i * nlon + j] = g.data[(i0 + i) * g.nlon + (j0 + j)] / 10;
  return { lat0: g.lat0 + i0 * g.res, lon0: g.lon0 + j0 * g.res, res: g.res, nlat, nlon, depth };
}

export interface RibbonFeature { type: "Feature"; id: number; geometry: { type: "LineString"; coordinates: [[number, number], [number, number]] }; properties: { n: number; e: number; m: [number, number] } }
export const loadRibbon = () => fetch("/data/nh/ribbon.geojson").then((r) => r.json()) as Promise<{ features: RibbonFeature[] }>;
export const loadOcean = () => fetch("/data/nh/ocean.geojson").then((r) => r.json());
export const loadSpotsGeo = () => fetch("/data/nh/spots.geojson").then((r) => r.json()) as Promise<{ features: Array<{ properties: { id: string; name: string; state: string; facing: number }; geometry: { coordinates: [number, number] } }> }>;

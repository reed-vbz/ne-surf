/**
 * Regional map data (MA · NH · southern ME), produced by workers/nesurf/sandbox_nh.py into public/data/nh + public/tiles/nh.
 * The bbox is Reed's 2026-09-22 directive: it bounds the default camera, the vector-tile source and the deck.gl physics.
 */
export const REGION_BBOX = { south: 42.8, north: 43.6, west: -70.85, east: -70.2 };
export const REGION_ID = "nh";
export const inRegion = (lat: number, lon: number) => lat >= REGION_BBOX.south && lat <= REGION_BBOX.north && lon >= REGION_BBOX.west && lon <= REGION_BBOX.east;

export interface DepthGrid { lat0: number; lon0: number; res: number; nlat: number; nlon: number; data: Uint16Array }

export async function loadDepth(): Promise<DepthGrid> {
  const j = await fetch(`/data/${REGION_ID}/depth.json`).then((r) => r.json());
  const bin = atob(j.data_b64); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { lat0: j.lat0, lon0: j.lon0, res: j.res, nlat: j.nlat, nlon: j.nlon, data: new Uint16Array(bytes.buffer) };
}
/** metres, positive down; 0 = land / outside */
export const depthAt = (g: DepthGrid, lat: number, lon: number): number => {
  const i = Math.round((lat - g.lat0) / g.res), j = Math.round((lon - g.lon0) / g.res);
  if (i < 0 || j < 0 || i >= g.nlat || j >= g.nlon) return 0;
  return g.data[i * g.nlon + j] / 10;
};
/** true when (lat, lon) falls inside the depth grid (outside it depthAt() reports 0, which would read as land) */
export const inGrid = (g: DepthGrid, lat: number, lon: number) => lat >= g.lat0 && lon >= g.lon0 && lat < g.lat0 + g.nlat * g.res && lon < g.lon0 + g.nlon * g.res;

/** DepthTile shape for lib/refraction.ts, cut from the regional grid around a break (±7 km). */
export function tileAround(g: DepthGrid, lat: number, lon: number) {
  const dlat = 7000 / 110540, dlon = 7000 / (111320 * Math.cos((lat * Math.PI) / 180));
  const i0 = Math.max(0, Math.floor((lat - dlat - g.lat0) / g.res)), i1 = Math.min(g.nlat - 1, Math.ceil((lat + dlat - g.lat0) / g.res));
  const j0 = Math.max(0, Math.floor((lon - dlon - g.lon0) / g.res)), j1 = Math.min(g.nlon - 1, Math.ceil((lon + dlon - g.lon0) / g.res));
  const nlat = i1 - i0 + 1, nlon = j1 - j0 + 1, depth = new Array<number>(nlat * nlon);
  for (let i = 0; i < nlat; i++) for (let j = 0; j < nlon; j++) depth[i * nlon + j] = g.data[(i0 + i) * g.nlon + (j0 + j)] / 10;
  return { lat0: g.lat0 + i0 * g.res, lon0: g.lon0 + j0 * g.res, res: g.res, nlat, nlon, depth };
}

export interface RibbonFeature { type: "Feature"; id: number; geometry: { type: "LineString"; coordinates: [[number, number], [number, number]] }; properties: { n: number; e: number; m: [number, number] } }
export const loadRibbon = () => fetch(`/data/${REGION_ID}/ribbon.geojson`).then((r) => r.json()) as Promise<{ features: RibbonFeature[] }>;

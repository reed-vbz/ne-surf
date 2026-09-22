"use client";
/** Satellite basemap plus a standalone deck canvas with a shared ocean mask.
 * Depth, wavefronts and particle fragments are clipped by the published ocean polygon.
 * The ribbon follows the polygon boundary; pins sit above the deck canvas.
 */
import { Map as MLMap, Marker, setWorkerUrl, type LngLatBoundsLike, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./map.css";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { GeoJsonLayer, PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import { TripsLayer } from "@deck.gl/geo-layers";
import RollingWavefrontsLayer from "./RollingWavefrontsLayer";
import type { Wavefield } from "@/lib/wavefield";
import { MaskExtension } from "@deck.gl/extensions";
import type { FeatureCollection } from "geojson";
import type { Layer } from "@deck.gl/core";
import { useEffect, useRef, useState } from "react";
import { hexToRgb, ramp, ribbonColor, windAlignment, windTier, TIER, type Tier } from "@/lib/colors";
import { REGION_BBOX, REGION_ID, depthAt, inGrid, type DepthGrid, type RibbonFeature } from "@/lib/region";
import { isLand } from "@/lib/overlays";
import { phaseSpeed } from "@/lib/refraction";
import type { FlowField, Streamline } from "@/lib/streamlines";
import { integrateStreamlines } from "@/lib/streamlines";

export interface MapSpot { id: string; name: string; state: string; lat: number; lon: number; tier: Tier; score: number; face_ft: number; tp: number | null; dp: number | null; hs_m: number; windKts: number | null; windFrom: number | null; callout?: string }
export interface MapBuoy { id: string; lat: number; lon: number; ok: boolean; label: string }
export type MapHover = { kind: "spot"; spot: MapSpot; x: number; y: number; ribbonAngle: number | null; ribbonTier: string | null } | { kind: "buoy"; buoy: MapBuoy; x: number; y: number };
interface Props {
  spots: MapSpot[]; buoys: MapBuoy[]; wind: FlowField | null; windSea: FlowField | null; swell: FlowField | null; wavefield: Wavefield | null; depth: DepthGrid | null; ribbon: RibbonFeature[];
  onHover: (h: MapHover | null) => void; selectedId: string | null; onSelect: (id: string | null) => void; flyTo: { lon: number; lat: number; key: number } | null;
}

const B = REGION_BBOX;
const BOUNDS: LngLatBoundsLike = [[B.west, B.south], [B.east, B.north]];
const FIT = { padding: { top: 120, bottom: 216, left: 8, right: 8 } };
const maskExtension = new MaskExtension();
const oceanClip = { extensions: [maskExtension], maskId: "ocean-mask", maskByInstance: false };
const DEPTH_COLORS: Array<[number,string]> = [[0,"#387477"],[2,"#2E666F"],[5,"#235665"],[10,"#1A4659"],[20,"#13384C"],[40,"#102C40"],[80,"#0D2234"],[150,"#091725"]];
const LAND = "#1a2a33";
const STYLE: StyleSpecification = {
  version: 8, glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
  sources: {
    esri: { type: "raster", tileSize: 256, maxzoom: 18, tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"], attribution: "Imagery © Esri, Maxar, Earthstar Geographics · Bathymetry NOAA CRM" },
    region: { type: "vector", tiles: [`${typeof window !== "undefined" ? window.location.origin : ""}/tiles/${REGION_ID}/{z}/{x}/{y}.pbf`], minzoom: 8, maxzoom: 13, bounds: [B.west, B.south, B.east, B.north] },
    coastline: { type: "geojson", data: `/data/${REGION_ID}/coastline.geojson` },
    coverage: { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[B.west,B.south],[B.east,B.south],[B.east,B.north],[B.west,B.north],[B.west,B.south]] } } },
    dem: { type: "raster-dem", tiles: [`${typeof window !== "undefined" ? window.location.origin : ""}/tiles/${REGION_ID}-dem/{z}/{x}/{y}.png`], tileSize: 256, encoding: "mapbox", minzoom: 8, maxzoom: 13, bounds: [B.west, B.south, B.east, B.north] },
  },

  layers: [
    { id: "bg", type: "background", paint: { "background-color": LAND } },
    { id: "esri", type: "raster", source: "esri", paint: { "raster-saturation": -0.3, "raster-brightness-max": 0.75 } },
    // L0 — ocean floor: data-driven on the isobath polygon's min_depth
    { id: "bathy", type: "fill", source: "region", "source-layer": "bathy", paint: {
      "fill-color": ["interpolate", ["linear"], ["get", "min_depth"], 0, "#387477", 2, "#2E666F", 5, "#235665", 10, "#1A4659", 20, "#13384C", 40, "#102C40", 80, "#0D2234", 150, "#091725"],
      "fill-opacity": 0, "fill-antialias": false } },
    { id: "bathy-edge", type: "line", source: "region", "source-layer": "bathy", paint: { "line-color": "#00E5FF", "line-opacity": 0, "line-width": 0.6 } },
    { id: "hillshade", type: "hillshade", source: "dem", paint: { "hillshade-exaggeration": 0.20, "hillshade-shadow-color": "#03101d", "hillshade-highlight-color": "#bff4ff", "hillshade-accent-color": "#00E5FF", "hillshade-illumination-direction": 320 } },
    { id: "deck-anchor", type: "background", paint: { "background-opacity": 0 } },   // L1 + L2 (deck.gl) interleave before this
    // L3 — land above L0–L2: satellite shows through (fill at 0), the antialiased shoreline line marks the exact 0 m edge
    { id: "land-fill", type: "fill", source: "region", "source-layer": "land", paint: { "fill-color": LAND, "fill-opacity": 0, "fill-antialias": true } },
    { id: "land-edge", type: "line", source: "coastline", paint: { "line-color": "#dff7ff", "line-opacity": 0.5, "line-width": 1 } },
    { id: "coverage", type: "line", source: "coverage", paint: { "line-color": "#9fb1bc", "line-dasharray": [3, 4], "line-width": 1, "line-opacity": 0.55 } },
    { id: "deck-top", type: "background", paint: { "background-opacity": 0 } },      // L4 deck layers interleave before this
  ],
};
setWorkerUrl("/vendor/maplibre/maplibre-gl-worker.mjs");

const pin = (tier: Tier, state: string) => `<svg width="22" height="28" viewBox="0 0 22 28"><path d="M11 0 C5 0 0 4.8 0 10.8 C0 18.5 11 28 11 28 C11 28 22 18.5 22 10.8 C22 4.8 17 0 11 0 Z" fill="${TIER[tier]}" stroke="#0e2029" stroke-width="1.5"/><text x="11" y="14.5" text-anchor="middle" font-family="Barlow, sans-serif" font-size="8" font-weight="800" fill="#0e2029">${state}</text></svg>`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
const FLOW_BBOX = { south: B.south - 0.15, north: B.north + 0.15, west: B.west - 0.15, east: B.east + 0.15 };   // physics runs a little past the tile bbox so comets never stop on a hard line
const LOOP = { wind: 30, swell: 52 };   // points between particle heads on one streamline
const TRAIL = { wind: 5, swell: 14 };   // wind waves: short fast dashes · groundswell: longer smooth trails
const GS_STOPS: Array<[number, string]> = [[6, "#7FF6FF"], [9, "#00E5FF"], [12, "#2F8CFF"], [16, "#3B4CFF"]];   // groundswell trail colour by period: cyan (short) → blue (long)
const groundswellColor = (tpS: number) => ramp(GS_STOPS, Math.max(6, Math.min(16, tpS)));
interface Comet extends Streamline { shift: number; times: number[] }
/**
 * Emit each streamline in LOOP-spaced copies: as currentTime wraps, copy j's head lands exactly where copy j+1's was → seamless
 * flow. `clock(lon, lat)` returns the time one path step takes there (1 in deep water); for swell it is c_deep / c(h), the
 * shoaling slow-down from the dispersion relation, so heads decelerate over the shallows.
 */
function comets(lines: Streamline[], loop: number, trail: number, clock: (lon: number, lat: number) => number = () => 1): Comet[] {
  const out: Comet[] = [];
  for (const l of lines) {
    const times: number[] = [0]; for (let i = 1; i < l.path.length; i++) times.push(times[i - 1] + clock(l.path[i][0], l.path[i][1]));
    const total = times[times.length - 1], copies = Math.ceil((total + trail) / loop) + 1;
    for (let j = 0; j < copies; j++) out.push({ ...l, times, shift: l.phase * loop - j * loop });
  }
  return out;
}
const hash01 = (id: string) => { let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0; return (h % 1000) / 1000; };
/** Snell-refract a deep-water swell field on the depth grid inside `maxDepth`: sin θ₂ = (c₂ / c₁) sin θ₁ about the up-slope normal. */
function refractSwell(field: FlowField, g: DepthGrid, tpS: number, maxDepth = 45): FlowField {
  const c1 = phaseSpeed(2000, tpS), dl = 400 / 110540;
  return { at: (lat, lon) => {
    const a = field.at(lat, lon); if (!a || !inGrid(g, lat, lon)) return a;
    const h = depthAt(g, lat, lon); if (h <= 0 || h >= maxDepth) return a;
    const kx = Math.cos((lat * Math.PI) / 180);
    const gx = depthAt(g, lat, lon + dl / kx) - depthAt(g, lat, lon - dl / kx), gy = depthAt(g, lat + dl, lon) - depthAt(g, lat - dl, lon);
    const gm = Math.hypot(gx, gy); if (gm < 0.5) return a;
    const nx = -gx / gm, ny = -gy / gm;
    const cos1 = a.u * nx + a.v * ny; if (cos1 <= 0) return a;
    const sin1 = a.u * ny - a.v * nx;
    const s2 = Math.max(-1, Math.min(1, (phaseSpeed(h, tpS) / c1) * sin1)), c2 = Math.sqrt(1 - s2 * s2);
    return { u: nx * c2 + ny * s2, v: ny * c2 - nx * s2, speed: a.speed };
  } };
}

export default function MarineMap({ spots, buoys, wind, windSea, swell, wavefield, depth, ribbon, onHover, selectedId, onSelect, flyTo }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const overlay = useRef<MapboxOverlay | null>(null);
  const markers = useRef<Map<string, Marker>>(new Map());
  const [ready, setReady] = useState(false);
  const windLines = useRef<Streamline[]>([]);
  const swellLines = useRef<Streamline[]>([]);
  const windComets = useRef<Comet[]>([]);
  const swellComets = useRef<Comet[]>([]);
  const thin = useRef({ key: -1, wind: [] as Comet[], swell: [] as Comet[] });
  const tpRef = useRef(9);
  const [geometry, setGeometry] = useState<{ ocean: FeatureCollection; bathy: FeatureCollection } | null>(null);
  useEffect(() => { let live = true; Promise.all(["ocean", "bathy"].map((name) => fetch(`/data/${REGION_ID}/${name}.geojson`).then((r) => { if (!r.ok) throw Error(name); return r.json() as Promise<FeatureCollection>; }))).then(([ocean,bathy]) => { if (live) setGeometry({ ocean,bathy }); }).catch(() => {}); return () => { live = false; }; }, []);
  const raf = useRef(0);
  const animationTime = useRef(0);
  const propsRef = useRef({ spots, buoys, ribbon, wind, wavefield, selectedId, onHover, onSelect });
  useEffect(() => { propsRef.current = { spots, buoys, ribbon, wind, wavefield, selectedId, onHover, onSelect }; });

  useEffect(() => {
    if (!el.current || map.current) return;
    const m = new MLMap({ container: el.current, style: STYLE, bounds: BOUNDS, fitBoundsOptions: FIT, pitch: 0, bearing: 0, maxPitch: 0, dragRotate: false, pitchWithRotate: false, touchPitch: false, minZoom: 7.5, maxZoom: 15, attributionControl: { compact: true } });
    m.on("load", () => {
      // deck.gl 9.4's interleaved integration reads map.transform; MapLibre 6 no longer exposes it on Map
      const mm = m as unknown as { transform?: unknown; _camera?: { transform?: unknown }; painter?: { transform?: unknown } };
      if (mm.transform === undefined) Object.defineProperty(m, "transform", { get: () => mm._camera?.transform ?? mm.painter?.transform, configurable: true });
      overlay.current = new MapboxOverlay({ interleaved: false, layers: [] }); m.addControl(overlay.current); setReady(true);
      m.touchZoomRotate.disableRotation();
    });
    m.on("click", () => propsRef.current.onSelect(null));
    map.current = m;
    if (process.env.NODE_ENV !== "production") (window as unknown as { __map?: MLMap }).__map = m;
    const mk = markers.current;
    return () => { cancelAnimationFrame(raf.current); mk.forEach((k) => k.remove()); mk.clear(); m.remove(); map.current = null; overlay.current = null; setReady(false); };
  }, []);

  useEffect(() => { if (flyTo && map.current && ready) map.current.flyTo({ center: [flyTo.lon, flyTo.lat], zoom: Math.max(map.current.getZoom(), 12.2), padding: { top: 170, bottom: 220, left: 30, right: window.innerWidth >= 900 ? 420 : 30 }, duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 900 }); }, [flyTo, ready]);

  // L1 precompute per time step: streamlines (wind, swell) and ray fields (crests)
  useEffect(() => {
    if (!depth) return;
    const isOcean = (lat: number, lon: number) => (inGrid(depth, lat, lon) ? depthAt(depth, lat, lon) > 0 : !isLand(lat, lon));
    const tp = spots.find((s) => s.tp !== null)?.tp ?? 9; tpRef.current = tp;
    windLines.current = windSea ? integrateStreamlines(windSea, FLOW_BBOX, isOcean, { seedsAcross: 40, stepM: 160, maxSteps: 40, seed: 3 }) : [];
    swellLines.current = swell ? integrateStreamlines(refractSwell(swell, depth, tp), FLOW_BBOX, isOcean, { seedsAcross: 28, stepM: 220, maxSteps: 80, seed: 11 }) : [];
    windComets.current = comets(windLines.current, LOOP.wind, TRAIL.wind); thin.current.key = -1;
    const cDeep = phaseSpeed(2000, tp);
    swellComets.current = comets(swellLines.current, LOOP.swell, TRAIL.swell, (lon, lat) => { if (!inGrid(depth, lat, lon)) return 1; const h = depthAt(depth, lat, lon); return h <= 0 ? 1 : Math.min(3, cDeep / phaseSpeed(h, tp)); });

  }, [windSea, swell, spots, depth]);

  // Label collision: the selected break first, then by score; a label (with its callout) is shown only when its screen
  // rect does not overlap an already-placed one. Re-run on every camera move. Widths are estimated from the text
  // (11 px Barlow uppercase ≈ 6.6 px/char) because hidden spans cannot be measured.
  const layoutLabels = () => {
    const m = map.current; if (!m) return;
    const { spots: S, selectedId: sel } = propsRef.current;
    const order = [...S].sort((a, b) => (a.id === sel ? -1 : b.id === sel ? 1 : b.score - a.score));
    const kept: Array<[number, number, number, number]> = [];
    const hits = (r: [number, number, number, number]) => kept.some((k) => r[0] < k[2] && r[2] > k[0] && r[1] < k[3] && r[3] > k[1]);
    const at = new Map(order.map((s) => [s.id, m.project([s.lon, s.lat])]));
    for (const s of order) { const pt = at.get(s.id)!; kept.push([pt.x - 11, pt.y - 28, pt.x + 11, pt.y]); }   // pins always draw: labels must clear every pin
    for (const s of order) {
      const el = markers.current.get(s.id)?.getElement(); if (!el) continue;
      const lab = el.querySelector<HTMLElement>("[data-label]"), co = el.querySelector<HTMLElement>("[data-callout]");
      const pt = at.get(s.id)!, short = s.name.split(" (")[0];
      const labRect: [number, number, number, number] = [pt.x + 15, pt.y - 25, pt.x + 27 + 6.6 * short.length, pt.y - 3];
      const coRect: [number, number, number, number] = [pt.x + 15, pt.y - 26, pt.x + 35 + 5.6 * (short.length + 2 + (s.callout?.length ?? 0)), pt.y - 2];
      const showCo = !!co && !hits(coRect), showLab = !showCo && !hits(labRect);   // the callout carries the name, so it replaces the label
      if (co) co.style.display = showCo ? "" : "none";
      if (lab) lab.style.display = showLab ? "" : "none";
      if (showCo) kept.push(coRect); else if (showLab) kept.push(labRect);
    }
  };
  // L4 HTML pins + callouts
  useEffect(() => {
    const m = map.current; if (!m || !ready) return;
    const seen = new Set<string>();
    for (const s of spots) {
      seen.add(s.id);
      let k = markers.current.get(s.id);
      if (!k) {
        const root = document.createElement("div"); root.style.cursor = "pointer"; root.tabIndex = 0; root.setAttribute("role", "button");
        root.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); propsRef.current.onSelect(s.id); } });
        root.addEventListener("click", (ev) => { ev.stopPropagation(); propsRef.current.onSelect(s.id); });
        k = new Marker({ element: root, anchor: "bottom-left", offset: [-11, 0] }).setLngLat([s.lon, s.lat]).addTo(m); markers.current.set(s.id, k);   // pin tip on the point; label + callout grow to the right
      }
      const sel = selectedId === s.id;
      k.getElement().innerHTML = `<div style="display:flex;align-items:center;gap:4px">${pin(s.tier, s.state)}<span data-label style="padding:3px 6px;border-radius:4px;background:${sel ? "#4798b7" : "rgba(14,33,42,.78)"};font:700 11px 'Barlow',sans-serif;letter-spacing:.04em;text-transform:uppercase;color:${sel ? "#0e2029" : "#fff"}">${esc(s.name.split(" (")[0])}</span>${s.callout ? `<span data-callout style="height:24px;padding:0 8px;border-radius:4px;background:#0e212a;box-shadow:0 3px 10px rgba(0,0,0,.4);display:flex;align-items:center;gap:4px;white-space:nowrap;font:500 10px 'Barlow',sans-serif;color:#fff"><b style="color:${TIER[s.tier]};letter-spacing:.02em">${esc(s.name.split(" (")[0].toUpperCase())}:</b>${esc(s.callout)}</span>` : ""}</div>`;
      k.getElement().setAttribute("aria-label", `${s.name}, score ${s.score}, select forecast`);
      k.getElement().style.zIndex = sel ? "5" : "4";
    }
    for (const [id, k] of markers.current) if (!seen.has(id)) { k.remove(); markers.current.delete(id); }
    layoutLabels();
  }, [spots, ready, selectedId]);

  useEffect(() => { const m = map.current; if (!m || !ready) return; m.on("move", layoutLabels); return () => { m.off("move", layoutLabels); }; }, [ready]);

  // deck.gl frame loop: update animated layers at up to 30 fps (animation state lives here)
  useEffect(() => {
    if (!ready) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let last = 0, paused = performance.now();
    const tick = () => {
      if (document.hidden) return;
      raf.current = reduced.matches ? 0 : requestAnimationFrame(tick);
      const now = performance.now();
      if (!reduced.matches && now-last < 1000/30) return;
      if (!reduced.matches) animationTime.current += Math.min(0.1, Math.max(0, (now-paused)/1000));
      paused = now; last = now;
      const ov = overlay.current; if (!ov) return;
      const { ribbon: R, wind: Wf, spots: S, buoys: Bu, wavefield: WF, onHover: hov } = propsRef.current;
      const t = animationTime.current;
      const keep = Math.round(Math.min(1, Math.pow(3, (map.current?.getZoom() ?? 12) - 11.5)) * 40) / 40;   // density follows zoom
      if (keep !== thin.current.key) thin.current = { key: keep, wind: windComets.current.filter((c) => c.rank < keep), swell: swellComets.current.filter((c) => c.rank < keep) };
      const out: Layer[] = [];
      if (geometry) {
        out.push(new GeoJsonLayer({ id: "ocean-mask", data: geometry.ocean, operation: "mask", filled: true, stroked: false }));
        out.push(new GeoJsonLayer({ id: "ocean-depth", data: geometry.bathy, ...oceanClip, filled: true, stroked: false,
          getFillColor: (f) => [...ramp(DEPTH_COLORS, Number(f.properties?.min_depth ?? 0)), 225] as [number,number,number,number] }));
      }
      const beforeId = "deck-anchor";
      // L1 groundswell: the Rolling Wavefronts shader over the backend wave field; particle trails only while no field is loaded
      if (geometry && WF) out.push(new RollingWavefrontsLayer({ id: "wavefronts", beforeId, ...oceanClip, image: WF.image, geometry: WF.geometry, bounds: WF.bounds, _imageCoordinateSystem: "lnglat", time: t, omega: WF.omega, speed: 1, tScale: WF.tScale, hMax: WF.hMax, crestEvery: 3, crestWidth: 0.08, opacity: 1, textureParameters: { minFilter: "nearest", magFilter: "nearest" } }));
      else if (geometry && thin.current.swell.length) out.push(new TripsLayer({ id: "groundswell", beforeId, ...oceanClip, data: thin.current.swell,
        getPath: (d: Comet) => d.path, getTimestamps: (d: Comet) => d.times.map((t) => t + d.shift), getColor: () => { const c = groundswellColor(tpRef.current); return [c[0], c[1], c[2], 230]; }, updateTriggers: { getColor: tpRef.current },
        widthUnits: "pixels", getWidth: 2, capRounded: true, jointRounded: true, trailLength: TRAIL.swell, currentTime: (t * 4.5) % LOOP.swell, fadeTrail: true, opacity: 0.9 }));
      if (geometry && thin.current.wind.length) out.push(new TripsLayer({ id: "wind-waves", beforeId, ...oceanClip, data: thin.current.wind,
        getPath: (d: Comet) => d.path, getTimestamps: (d: Comet) => d.times.map((t) => t + d.shift), getColor: () => [255, 255, 255, 150], widthUnits: "pixels", getWidth: 1.1, capRounded: true,
        trailLength: TRAIL.wind, currentTime: (t * 12) % LOOP.wind, fadeTrail: true, opacity: 0.55 }));
      if (R.length) out.push(new PathLayer({ id: "ribbon", beforeId, data: R, getPath: (f: RibbonFeature) => f.geometry.coordinates,
        getColor: (f: RibbonFeature) => { const w = Wf?.at(f.properties.m[1], f.properties.m[0]); if (!w) return [180, 180, 180, 120]; const c = ribbonColor((Math.atan2(w.u, w.v) * 180) / Math.PI, w.speed * 1.944, f.properties.n); return [c[0], c[1], c[2], 235]; },
        updateTriggers: { getColor: [Wf] }, widthUnits: "pixels", getWidth: 4, widthMinPixels: 3, capRounded: true, jointRounded: true }));
      // L4 (above land): pulses on non-poor breaks (staggered per break, eased), buoy status dots, pickable spot targets
      { const ph = (s: MapSpot) => (t / 2.6 + hash01(s.id)) % 1, ease = (p: number) => 1 - (1 - p) * (1 - p);
        out.push(new ScatterplotLayer({ id: "pulses", beforeId: "deck-top", data: reduced.matches ? [] : S.filter((s) => s.id === propsRef.current.selectedId), getPosition: (s: MapSpot) => [s.lon, s.lat], radiusUnits: "meters", getRadius: (s: MapSpot) => 200 + 1000 * ease(ph(s)) * (s.hs_m / 2 + 0.5), stroked: true, filled: true,
          getFillColor: (s: MapSpot) => { const c = hexToRgb(TIER[s.tier]); return [c[0], c[1], c[2], Math.round(36 * (1 - ph(s)))]; }, getLineColor: (s: MapSpot) => { const c = hexToRgb(TIER[s.tier]); return [c[0], c[1], c[2], Math.round(200 * (1 - ph(s)) ** 2)]; }, lineWidthUnits: "pixels", getLineWidth: 1.5, updateTriggers: { getRadius: t, getFillColor: t, getLineColor: t } })); }
      out.push(new ScatterplotLayer({ id: "buoys", beforeId: "deck-top", data: Bu, getPosition: (b: MapBuoy) => [b.lon, b.lat], radiusUnits: "pixels", getRadius: 5, stroked: true, filled: true, lineWidthUnits: "pixels", getLineWidth: 1.5,
        getFillColor: (b: MapBuoy) => (b.ok ? [65, 199, 118, 230] : [156, 158, 161, 200]), getLineColor: [14, 32, 41, 255], pickable: true, updateTriggers: { getFillColor: [Bu] },
        onHover: (info) => { if (!info.object) { hov(null); return; } hov({ kind: "buoy", buoy: info.object as MapBuoy, x: info.x, y: info.y }); } }));
      out.push(new ScatterplotLayer({ id: "spot-hit", beforeId: "deck-top", data: S, getPosition: (s: MapSpot) => [s.lon, s.lat], radiusUnits: "pixels", getRadius: 18, getFillColor: [0, 0, 0, 0], pickable: true,
        onHover: (info) => { if (!info.object) { hov(null); return; } const s = info.object as MapSpot; let best: RibbonFeature | null = null, bd = Infinity;
          for (const f of R) { const dx = (f.properties.m[0] - s.lon) * Math.cos((s.lat * Math.PI) / 180), dy = f.properties.m[1] - s.lat; const d = dx * dx + dy * dy; if (d < bd) { bd = d; best = f; } }
          const w = best ? Wf?.at(best.properties.m[1], best.properties.m[0]) : null; const toward = w ? (Math.atan2(w.u, w.v) * 180) / Math.PI : null;
          const ang = best && toward !== null ? Math.abs((((toward - best.properties.n) + 540) % 360) - 180) : null;
          const rt = best && toward !== null ? windTier(windAlignment(toward, best.properties.n), (w?.speed ?? 0) * 1.944) : null;
          hov({ kind: "spot", spot: s, x: info.x, y: info.y, ribbonAngle: ang, ribbonTier: rt }); } }));
      ov.setProps({ layers: out });
    };
    const resume = () => { cancelAnimationFrame(raf.current); paused = performance.now(); last = 0; if (!document.hidden) tick(); };
    document.addEventListener("visibilitychange", resume); reduced.addEventListener("change", resume); map.current?.on("move", resume);
    resume();
    return () => { cancelAnimationFrame(raf.current); document.removeEventListener("visibilitychange", resume); reduced.removeEventListener("change", resume); map.current?.off("move", resume); };
  }, [ready, geometry, wavefield, wind, spots, selectedId, buoys]);

  return <div className="nesurf-map absolute inset-0" style={{ zIndex: 0, isolation: "isolate" }}><div ref={el} className="h-full w-full" /></div>;
}

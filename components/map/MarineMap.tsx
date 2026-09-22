"use client";
/**
 * The map engine: 5-layer permanent marine architecture on MapLibre GL + deck.gl (interleaved) + self-hosted MVT.
 * All five layers render concurrently; there are no user toggles.
 *
 *   L0 ocean floor      MapLibre vector `fill`, `interpolate` on min_depth (NOAA CRM 3″ isobaths, public/tiles/nh layer `bathy`):
 *                       0 m #00E5FF → 20 m #0099CC → 100 m+ #0B192C
 *   L1 swell + wind     deck.gl TripsLayer comets (wind cyan, swell energy-coloured) + PathLayer refraction crests.
 *                       Every streamline has a random phase and is emitted in loop-spaced copies, so heads flow continuously
 *                       (no pulsing); the swell field is Snell-refracted on the depth grid before integration.
 *   L2 nearshore ribbon deck.gl PathLayer, 100 m shoreline segments, wind-to-beach colour #00FF88 / #FFB800 / #FF3366
 *   L3 land mask        satellite land (Reed, 2026-09-22: "I want satellite view for the land"), so the mask is enforced by
 *                       the data instead of an opaque fill: L0 polygons are ocean-only and share the 0 m outline with the
 *                       land polygon, L1 streamlines exist only over water and rays stop at the shore, L2 sits on the
 *                       shoreline. The antialiased shoreline line (layer `land`) is drawn above L0–L2; the opaque fill is
 *                       kept in the style at opacity 0 (`land-fill`) for a chart look if ever wanted.
 *   L4 annotations      pulses (deck.gl), spot pins + callouts (HTML markers), buoy status dots, hover → React tooltip.
 *
 * Deviation from the directive, verified: deck.gl 9.4's MaskExtension does not render interleaved on MapLibre 6, and
 * MapLibre 6 hides map.transform (shimmed below). The bathymetry source is self-hosted CRM MVT (no Mapbox token).
 */
import { Map as MLMap, Marker, setWorkerUrl, type LngLatBoundsLike, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./map.css";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import { TripsLayer } from "@deck.gl/geo-layers";
import type { Layer } from "@deck.gl/core";
import { useEffect, useRef, useState } from "react";
import { hexToRgb, ramp, ribbonColor, swellEnergy, SWELL_STOPS, TIER, type Tier } from "@/lib/colors";
import { REGION_BBOX, REGION_ID, depthAt, inGrid, tileAround, type DepthGrid, type RibbonFeature } from "@/lib/region";
import { isLand } from "@/lib/overlays";
import { crestsAt, phaseSpeed, traceRays, type RayField } from "@/lib/refraction";
import type { FlowField, Streamline } from "@/lib/streamlines";
import { integrateStreamlines } from "@/lib/streamlines";

export interface MapSpot { id: string; name: string; state: string; lat: number; lon: number; tier: Tier; score: number; face_ft: number; tp: number | null; dp: number | null; hs_m: number; windKts: number | null; windFrom: number | null; callout?: string }
export interface MapBuoy { id: string; lat: number; lon: number; ok: boolean; label: string }
export type MapHover = { kind: "spot"; spot: MapSpot; x: number; y: number; ribbonAngle: number | null; ribbonTier: string | null } | { kind: "buoy"; buoy: MapBuoy; x: number; y: number };
interface Props {
  spots: MapSpot[]; buoys: MapBuoy[]; wind: FlowField | null; swell: FlowField | null; depth: DepthGrid | null; ribbon: RibbonFeature[];
  onHover: (h: MapHover | null) => void; selectedId: string | null; onSelect: (id: string | null) => void; flyTo: { lon: number; lat: number; key: number } | null;
}

const B = REGION_BBOX;
const BOUNDS: LngLatBoundsLike = [[B.west, B.south], [B.east, B.north]];
const LAND = "#1a2a33";
const STYLE: StyleSpecification = {
  version: 8, glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
  sources: {
    esri: { type: "raster", tileSize: 256, maxzoom: 18, tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"], attribution: "Imagery © Esri, Maxar, Earthstar Geographics · Bathymetry NOAA CRM" },
    region: { type: "vector", tiles: [`${typeof window !== "undefined" ? window.location.origin : ""}/tiles/${REGION_ID}/{z}/{x}/{y}.pbf`], minzoom: 8, maxzoom: 13, bounds: [B.west, B.south, B.east, B.north] },
  },
  layers: [
    { id: "bg", type: "background", paint: { "background-color": LAND } },
    { id: "esri", type: "raster", source: "esri", paint: { "raster-saturation": -0.3, "raster-brightness-max": 0.75 } },
    // L0 — ocean floor: data-driven on the isobath polygon's min_depth
    { id: "bathy", type: "fill", source: "region", "source-layer": "bathy", paint: {
      "fill-color": ["interpolate", ["linear"], ["get", "min_depth"], 0, "#00E5FF", 5, "#00C4EA", 10, "#00ADD8", 20, "#0099CC", 40, "#0A6FA6", 80, "#0C3F72", 100, "#0B192C"],
      "fill-opacity": 0.85, "fill-antialias": false } },
    { id: "bathy-edge", type: "line", source: "region", "source-layer": "bathy", paint: { "line-color": "#00E5FF", "line-opacity": 0.10, "line-width": 0.6 } },
    { id: "deck-anchor", type: "background", paint: { "background-opacity": 0 } },   // L1 + L2 (deck.gl) interleave before this
    // L3 — land above L0–L2: satellite shows through (fill at 0), the antialiased shoreline line marks the exact 0 m edge
    { id: "land-fill", type: "fill", source: "region", "source-layer": "land", paint: { "fill-color": LAND, "fill-opacity": 0, "fill-antialias": true } },
    { id: "land-edge", type: "line", source: "region", "source-layer": "land", paint: { "line-color": "#dff7ff", "line-opacity": 0.5, "line-width": 1 } },
    { id: "deck-top", type: "background", paint: { "background-opacity": 0 } },      // L4 deck layers interleave before this
  ],
};
setWorkerUrl("/vendor/maplibre/maplibre-gl-worker.mjs");

const pin = (tier: Tier, state: string) => `<svg width="22" height="28" viewBox="0 0 22 28"><path d="M11 0 C5 0 0 4.8 0 10.8 C0 18.5 11 28 11 28 C11 28 22 18.5 22 10.8 C22 4.8 17 0 11 0 Z" fill="${TIER[tier]}" stroke="#0e2029" stroke-width="1.5"/><text x="11" y="14.5" text-anchor="middle" font-family="Barlow, sans-serif" font-size="8" font-weight="800" fill="#0e2029">${state}</text></svg>`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
const FLOW_BBOX = { south: B.south - 0.15, north: B.north + 0.15, west: B.west - 0.15, east: B.east + 0.15 };   // physics runs a little past the tile bbox so comets never stop on a hard line
const LOOP = { wind: 48, swell: 44 };   // points between comet heads on one streamline
const TRAIL = { wind: 12, swell: 14 };  // lit points behind each head (¼–⅓ of the loop: comets read as motion, not lines)
const CREST_MAX_DEPTH = 15;             // metres: crest lines only where the swell is visibly refracting
const cometColor = (hsM: number, tpS: number) => ramp(SWELL_STOPS, 0.35 + 0.65 * swellEnergy(hsM * 3.28084, tpS));   // ramp low end lifted: a 1 px mark must stay visible on the dark base
interface Comet extends Streamline { shift: number }
/** Emit each streamline in LOOP-spaced copies: as currentTime wraps, copy j's head lands exactly where copy j+1's was → seamless flow. */
function comets(lines: Streamline[], loop: number, trail: number): Comet[] {
  const out: Comet[] = [];
  for (const l of lines) { const copies = Math.ceil((l.path.length + trail) / loop) + 1; for (let j = 0; j < copies; j++) out.push({ ...l, shift: l.phase * loop - j * loop }); }
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

export default function MarineMap({ spots, buoys, wind, swell, depth, ribbon, onHover, selectedId, onSelect, flyTo }: Props) {
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
  const rayFields = useRef<Array<{ id: string; field: RayField; tCut: number }>>([]);
  const raf = useRef(0);
  const t0 = useRef(0);
  const propsRef = useRef({ spots, buoys, ribbon, wind, selectedId, onHover, onSelect });
  useEffect(() => { propsRef.current = { spots, buoys, ribbon, wind, selectedId, onHover, onSelect }; });

  useEffect(() => {
    if (!el.current || map.current) return;
    const m = new MLMap({ container: el.current, style: STYLE, bounds: BOUNDS, fitBoundsOptions: { padding: { top: 210, bottom: 150, left: 8, right: 8 } }, minZoom: 7.5, maxZoom: 15, attributionControl: { compact: true } });
    t0.current = performance.now();
    m.on("load", () => {
      // deck.gl 9.4's interleaved integration reads map.transform; MapLibre 6 no longer exposes it on Map
      const mm = m as unknown as { transform?: unknown; _camera?: { transform?: unknown }; painter?: { transform?: unknown } };
      if (mm.transform === undefined) Object.defineProperty(m, "transform", { get: () => mm._camera?.transform ?? mm.painter?.transform, configurable: true });
      overlay.current = new MapboxOverlay({ interleaved: true, layers: [] }); m.addControl(overlay.current); setReady(true);
    });
    m.on("click", () => propsRef.current.onSelect(null));
    map.current = m;
    if (process.env.NODE_ENV !== "production") (window as unknown as { __map?: MLMap }).__map = m;
    const mk = markers.current;
    return () => { cancelAnimationFrame(raf.current); mk.forEach((k) => k.remove()); mk.clear(); m.remove(); map.current = null; overlay.current = null; setReady(false); };
  }, []);

  useEffect(() => { if (flyTo && map.current && ready) map.current.flyTo({ center: [flyTo.lon, flyTo.lat], zoom: Math.max(map.current.getZoom(), 12.2), duration: 900 }); }, [flyTo, ready]);

  // L1 precompute per time step: streamlines (wind, swell) and ray fields (crests)
  useEffect(() => {
    if (!depth) return;
    const isOcean = (lat: number, lon: number) => (inGrid(depth, lat, lon) ? depthAt(depth, lat, lon) > 0 : !isLand(lat, lon));
    const tp = spots.find((s) => s.tp !== null)?.tp ?? 9; tpRef.current = tp;
    windLines.current = wind ? integrateStreamlines(wind, FLOW_BBOX, isOcean, { seedsAcross: 44, stepM: 200, maxSteps: 70, seed: 3 }) : [];
    swellLines.current = swell ? integrateStreamlines(refractSwell(swell, depth, tp), FLOW_BBOX, isOcean, { seedsAcross: 30, stepM: 220, maxSteps: 60, seed: 11 }) : [];
    windComets.current = comets(windLines.current, LOOP.wind, TRAIL.wind); thin.current.key = -1;
    swellComets.current = comets(swellLines.current, LOOP.swell, TRAIL.swell);
    rayFields.current = spots.filter((s) => s.dp !== null && s.tp !== null && s.hs_m > 0.3).map((s) => {
      const field = traceRays(tileAround(depth, s.lat, s.lon), s.lat, s.lon, s.dp!, s.tp!, s.hs_m, { rays: 25, spanM: 5000, startKm: 7, stepM: 50 });
      let tCut = Infinity;
      field.depths.forEach((hs, r) => { const k = hs.findIndex((h) => h <= CREST_MAX_DEPTH); if (k > 0) tCut = Math.min(tCut, field.times[r][k]); });
      return { id: s.id, field, tCut: Number.isFinite(tCut) ? tCut : 0 };
    });
  }, [wind, swell, spots, depth]);

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
        const root = document.createElement("div"); root.style.cursor = "pointer";
        root.addEventListener("click", (ev) => { ev.stopPropagation(); propsRef.current.onSelect(s.id); });
        k = new Marker({ element: root, anchor: "bottom-left", offset: [-11, 0] }).setLngLat([s.lon, s.lat]).addTo(m); markers.current.set(s.id, k);   // pin tip on the point; label + callout grow to the right
      }
      const sel = selectedId === s.id;
      k.getElement().innerHTML = `<div style="display:flex;align-items:center;gap:4px">${pin(s.tier, s.state)}<span data-label style="padding:3px 6px;border-radius:4px;background:${sel ? "#4798b7" : "rgba(14,33,42,.78)"};font:700 11px 'Barlow',sans-serif;letter-spacing:.04em;text-transform:uppercase;color:${sel ? "#0e2029" : "#fff"}">${esc(s.name.split(" (")[0])}</span>${s.callout ? `<span data-callout style="height:24px;padding:0 8px;border-radius:4px;background:#0e212a;box-shadow:0 3px 10px rgba(0,0,0,.4);display:flex;align-items:center;gap:4px;white-space:nowrap;font:500 10px 'Barlow',sans-serif;color:#fff"><b style="color:${TIER[s.tier]};letter-spacing:.02em">${esc(s.name.split(" (")[0].toUpperCase())}:</b>${esc(s.callout)}</span>` : ""}</div>`;
      k.getElement().style.zIndex = sel ? "3" : "1";
    }
    for (const [id, k] of markers.current) if (!seen.has(id)) { k.remove(); markers.current.delete(id); }
    layoutLabels();
  }, [spots, ready, selectedId]);

  useEffect(() => { const m = map.current; if (!m || !ready) return; m.on("move", layoutLabels); return () => { m.off("move", layoutLabels); }; }, [ready]);

  // deck.gl frame loop: rebuild the interleaved layer stack every frame (animation state lives here)
  useEffect(() => {
    if (!ready) return;
    const tick = () => {
      raf.current = requestAnimationFrame(tick);
      const ov = overlay.current; if (!ov) return;
      const { ribbon: R, wind: Wf, spots: S, buoys: Bu, selectedId: sel, onHover: hov } = propsRef.current;
      const t = (performance.now() - t0.current) / 1000;
      const keep = Math.round(Math.min(1, Math.pow(3, (map.current?.getZoom() ?? 12) - 11.5)) * 40) / 40;   // density follows zoom
      if (keep !== thin.current.key) thin.current = { key: keep, wind: windComets.current.filter((c) => c.rank < keep), swell: swellComets.current.filter((c) => c.rank < keep) };
      const out: Layer[] = [];
      const beforeId = "deck-anchor";
      if (thin.current.wind.length) out.push(new TripsLayer({ id: "wind-flow", beforeId, data: thin.current.wind,
        getPath: (d: Comet) => d.path, getTimestamps: (d: Comet) => d.path.map((_, i) => i + d.shift), getColor: () => [100, 213, 204, 190], widthUnits: "pixels", getWidth: 1.3, capRounded: true, jointRounded: true,
        trailLength: TRAIL.wind, currentTime: (t * 9) % LOOP.wind, fadeTrail: true, opacity: 0.8 }));
      if (thin.current.swell.length) out.push(new TripsLayer({ id: "swell-flow", beforeId, data: thin.current.swell,
        getPath: (d: Comet) => d.path, getTimestamps: (d: Comet) => d.path.map((_, i) => i + d.shift), getColor: (d: Comet) => { const c = cometColor(d.speed, tpRef.current); return [c[0], c[1], c[2], 235]; }, updateTriggers: { getColor: tpRef.current },
        widthUnits: "pixels", getWidth: 2, capRounded: true, jointRounded: true, trailLength: TRAIL.swell, currentTime: (t * 5.5) % LOOP.swell, fadeTrail: true, opacity: 0.85 }));
      { const every = Math.max(12, Math.min(60, 250 / (1.56 * tpRef.current))), phase = (t % (every / 10)) * 10;   // ≈250 m between crests in deep water
        const paths: Array<{ path: Array<[number, number]>; color: number[]; w: number }> = [];
        for (const rf of rayFields.current) { const dim = sel && sel !== rf.id;
          for (const cr of crestsAt(rf.field, phase, every, CREST_MAX_DEPTH)) {
            const near = Math.max(0, Math.min(1, (cr.t - rf.tCut) / Math.max(1, rf.field.tMax - rf.tCut)));
            const a = 185 * Math.min(1, near / 0.25) * (0.4 + 0.6 * near) * (dim ? 0.35 : 1);
            paths.push({ path: cr.points, color: [205, 242, 255, Math.round(a)], w: 1.1 + 1.1 * near }); } }
        if (paths.length) out.push(new PathLayer({ id: "crests", beforeId, data: paths, getPath: (d) => d.path, getColor: (d) => d.color as [number, number, number, number], getWidth: (d) => d.w, widthUnits: "pixels", capRounded: true, jointRounded: true })); }
      if (R.length) out.push(new PathLayer({ id: "ribbon", beforeId, data: R, getPath: (f: RibbonFeature) => f.geometry.coordinates,
        getColor: (f: RibbonFeature) => { const w = Wf?.at(f.properties.m[1], f.properties.m[0]); if (!w) return [180, 180, 180, 120]; const c = ribbonColor((Math.atan2(w.u, w.v) * 180) / Math.PI, w.speed * 1.944, f.properties.n); return [c[0], c[1], c[2], 235]; },
        updateTriggers: { getColor: [Wf] }, widthUnits: "pixels", getWidth: 4, widthMinPixels: 3, capRounded: true }));
      // L4 (above land): pulses on non-poor breaks (staggered per break, eased), buoy status dots, pickable spot targets
      { const ph = (s: MapSpot) => (t / 2.6 + hash01(s.id)) % 1, ease = (p: number) => 1 - (1 - p) * (1 - p);
        out.push(new ScatterplotLayer({ id: "pulses", beforeId: "deck-top", data: S.filter((s) => s.tier !== "poor"), getPosition: (s: MapSpot) => [s.lon, s.lat], radiusUnits: "meters", getRadius: (s: MapSpot) => 200 + 1000 * ease(ph(s)) * (s.hs_m / 2 + 0.5), stroked: true, filled: true,
          getFillColor: (s: MapSpot) => { const c = hexToRgb(TIER[s.tier]); return [c[0], c[1], c[2], Math.round(36 * (1 - ph(s)))]; }, getLineColor: (s: MapSpot) => { const c = hexToRgb(TIER[s.tier]); return [c[0], c[1], c[2], Math.round(200 * (1 - ph(s)) ** 2)]; }, lineWidthUnits: "pixels", getLineWidth: 1.5, updateTriggers: { getRadius: t, getFillColor: t, getLineColor: t } })); }
      out.push(new ScatterplotLayer({ id: "buoys", beforeId: "deck-top", data: Bu, getPosition: (b: MapBuoy) => [b.lon, b.lat], radiusUnits: "pixels", getRadius: 5, stroked: true, filled: true, lineWidthUnits: "pixels", getLineWidth: 1.5,
        getFillColor: (b: MapBuoy) => (b.ok ? [65, 199, 118, 230] : [156, 158, 161, 200]), getLineColor: [14, 32, 41, 255], pickable: true, updateTriggers: { getFillColor: [Bu] },
        onHover: (info) => { if (!info.object) { hov(null); return; } hov({ kind: "buoy", buoy: info.object as MapBuoy, x: info.x, y: info.y }); } }));
      out.push(new ScatterplotLayer({ id: "spot-hit", beforeId: "deck-top", data: S, getPosition: (s: MapSpot) => [s.lon, s.lat], radiusUnits: "pixels", getRadius: 18, getFillColor: [0, 0, 0, 0], pickable: true,
        onHover: (info) => { if (!info.object) { hov(null); return; } const s = info.object as MapSpot; let best: RibbonFeature | null = null, bd = Infinity;
          for (const f of R) { const dx = (f.properties.m[0] - s.lon) * Math.cos((s.lat * Math.PI) / 180), dy = f.properties.m[1] - s.lat; const d = dx * dx + dy * dy; if (d < bd) { bd = d; best = f; } }
          const w = Wf?.at(s.lat, s.lon); const toward = w ? (Math.atan2(w.u, w.v) * 180) / Math.PI : null;
          const ang = best && toward !== null ? Math.abs((((toward - best.properties.n) + 540) % 360) - 180) : null;
          const rt = ang === null ? null : ang <= 60 ? "offshore" : ang <= 105 ? "cross" : "onshore";
          hov({ kind: "spot", spot: s, x: info.x, y: info.y, ribbonAngle: ang, ribbonTier: rt }); } }));
      ov.setProps({ layers: out });
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [ready]);

  return <div className="nesurf-map absolute inset-0" style={{ zIndex: 0, isolation: "isolate" }}><div ref={el} className="h-full w-full" /></div>;
}

"use client";
/**
 * New Hampshire Sandbox — 5-layer marine architecture on MapLibre GL + deck.gl (interleaved) + self-hosted MVT.
 *   L0 bathymetric base   MapLibre vector fill, `interpolate` on min_depth (public/tiles/nh, layer `bathy`)
 *   L1 physics            deck.gl TripsLayer comets for wind + swell, PathLayer refraction crests — GPU, masked to the ocean.
 *                         Comets: every streamline carries a random phase and the path is emitted in LOOP-spaced copies, so
 *                         heads flow continuously along each line and the field never pulses in lockstep. The swell field
 *                         is refracted on the CRM depth grid with Snell's law before integration, so comets bend into the
 *                         beaches and wrap the points instead of running as parallel 0.16° streaks.
 *   L2 nearshore ribbon   deck.gl PathLayer, 100 m segments, wind-to-beach colour
 *   L3 land mask          zero bleed is enforced at the data level: streamlines are integrated only over CRM water
 *                         cells (90 m) and refraction rays stop at the shoreline, so no physics geometry exists over
 *                         land; the `land` MVT layer can be drawn as an opaque fill above L0–L2 ("chart" look).
 *                         (deck.gl 9.4 MaskExtension does not render in interleaved mode with MapLibre 6 — verified.)
 *   L4 annotations        deck.gl ScatterplotLayer pulses + HTML pins; hover → React tooltip
 */
import { Map as MLMap, Marker, setWorkerUrl, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "../map/map.css";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import { TripsLayer } from "@deck.gl/geo-layers";
import type { Layer } from "@deck.gl/core";
import { useEffect, useRef, useState } from "react";
import { hexToRgb, ramp, ribbonColor, swellEnergy, SWELL_STOPS, TIER, type Tier } from "@/lib/colors";
import { NH_BBOX, depthAt, inGrid, tileAround, type DepthGrid, type RibbonFeature } from "@/lib/nhData";
import { isLand } from "@/lib/overlays";
import { crestsAt, phaseSpeed, traceRays, type RayField } from "@/lib/refraction";
import type { FlowField, Streamline } from "@/lib/streamlines";
import { integrateStreamlines } from "@/lib/streamlines";

export interface NhSpot { id: string; name: string; state: string; lat: number; lon: number; tier: Tier; score: number; face_ft: number; tp: number | null; dp: number | null; hs_m: number; windKts: number | null; windFrom: number | null }
export interface NhLayers { bathy: boolean; wind: boolean; swell: boolean; crests: boolean; ribbon: boolean; landFill: boolean; pulses: boolean }
export interface NhHover { spot: NhSpot; x: number; y: number; ribbonAngle: number | null; ribbonTier: string | null }
interface Props {
  spots: NhSpot[]; wind: FlowField | null; swell: FlowField | null; layers: NhLayers; depth: DepthGrid | null;
  ribbon: RibbonFeature[]; ocean: unknown | null; onHover: (h: NhHover | null) => void; selectedId: string | null; onSelect: (id: string | null) => void;
}

const STYLE: StyleSpecification = {
  version: 8, glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
  sources: {
    esri: { type: "raster", tileSize: 256, maxzoom: 18, tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"], attribution: "Imagery © Esri, Maxar, Earthstar Geographics · Bathymetry NOAA CRM" },
    nh: { type: "vector", tiles: [`${typeof window !== "undefined" ? window.location.origin : ""}/tiles/nh/{z}/{x}/{y}.pbf`], minzoom: 8, maxzoom: 13, bounds: [NH_BBOX.west, NH_BBOX.south, NH_BBOX.east, NH_BBOX.north] },
  },
  layers: [
    { id: "esri", type: "raster", source: "esri", paint: { "raster-saturation": -0.3, "raster-brightness-max": 0.75 } },
    // L0 — bathymetric base: data-driven on the isobath polygon's min_depth
    { id: "bathy", type: "fill", source: "nh", "source-layer": "bathy", paint: {
      "fill-color": ["interpolate", ["linear"], ["get", "min_depth"], 0, "#00E5FF", 5, "#00C2E6", 10, "#0099CC", 20, "#0B6FA8", 40, "#0F4C80", 80, "#0D3258", 150, "#0B192C"],
      "fill-opacity": 0.78, "fill-antialias": false } },
    { id: "bathy-edge", type: "line", source: "nh", "source-layer": "bathy", paint: { "line-color": "#00E5FF", "line-opacity": 0.12, "line-width": 0.6 } },
    { id: "deck-anchor", type: "background", paint: { "background-opacity": 0 } },   // deck layers interleave before this
    // L3 — opaque land (chart look), off by default so the satellite land shows
    { id: "land-fill", type: "fill", source: "nh", "source-layer": "land", layout: { visibility: "none" }, paint: { "fill-color": "#16262f", "fill-opacity": 1 } },
    { id: "land-edge", type: "line", source: "nh", "source-layer": "land", paint: { "line-color": "#0e2029", "line-opacity": 0.9, "line-width": 1 } },
  ],
};
setWorkerUrl("/vendor/maplibre/maplibre-gl-worker.mjs");

const pin = (tier: Tier, state: string) => `<svg width="22" height="28" viewBox="0 0 22 28"><path d="M11 0 C5 0 0 4.8 0 10.8 C0 18.5 11 28 11 28 C11 28 22 18.5 22 10.8 C22 4.8 17 0 11 0 Z" fill="${TIER[tier]}" stroke="#0e2029" stroke-width="1.5"/><text x="11" y="14.5" text-anchor="middle" font-family="Barlow, sans-serif" font-size="8" font-weight="800" fill="#0e2029">${state}</text></svg>`;
const FLOW_BBOX = { south: NH_BBOX.south - 0.2, north: NH_BBOX.north + 0.2, west: NH_BBOX.west - 0.2, east: NH_BBOX.east + 0.2 };   // physics runs past the tile bbox so comets do not stop on a hard line
const LOOP = { wind: 48, swell: 44 };   // points between comet heads on one streamline
const TRAIL = { wind: 12, swell: 14 };  // lit points behind each head (¼–⅓ of the loop, so comets read as motion, not as lines)
/** Comet colour: the swell-energy ramp with its near-black low end lifted — a 1 px mark must stay visible on the dark base. */
const cometColor = (hsM: number, tpS: number) => ramp(SWELL_STOPS, 0.35 + 0.65 * swellEnergy(hsM * 3.28084, tpS));
const CREST_MAX_DEPTH = 15;             // metres: crest lines are drawn only where the swell is visibly refracting (inside ~the 15 m contour)   // points between comet heads on one streamline
interface Comet extends Streamline { shift: number }
/** Emit each streamline in LOOP-spaced copies: as currentTime wraps, copy j's head lands exactly where copy j+1's was → seamless flow. */
function comets(lines: Streamline[], loop: number, trail: number): Comet[] {
  const out: Comet[] = [];
  for (const l of lines) { const copies = Math.ceil((l.path.length + trail) / loop) + 1; for (let j = 0; j < copies; j++) out.push({ ...l, shift: l.phase * loop - j * loop }); }
  return out;
}
const hash01 = (id: string) => { let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0; return (h % 1000) / 1000; };
/**
 * Snell-refract a deep-water swell field on the CRM grid: inside `maxDepth` the ray turns toward the up-slope normal so
 * that sin θ₂ = (c₂ / c₁) sin θ₁ (c from the dispersion relation for period tpS). Gradient over a 400 m stencil.
 */
function refractSwell(field: FlowField, g: DepthGrid, tpS: number, maxDepth = 45): FlowField {
  const c1 = phaseSpeed(2000, tpS), dl = 400 / 110540;
  return { at: (lat, lon) => {
    const a = field.at(lat, lon); if (!a) return a;
    if (!inGrid(g, lat, lon)) return a;
    const h = depthAt(g, lat, lon); if (h <= 0 || h >= maxDepth) return a;
    const kx = Math.cos((lat * Math.PI) / 180);
    const gx = depthAt(g, lat, lon + dl / kx) - depthAt(g, lat, lon - dl / kx), gy = depthAt(g, lat + dl, lon) - depthAt(g, lat - dl, lon);
    const gm = Math.hypot(gx, gy); if (gm < 0.5) return a;
    const nx = -gx / gm, ny = -gy / gm;                              // toward shallower water
    const cos1 = a.u * nx + a.v * ny; if (cos1 <= 0) return a;      // travelling away from the shore: leave it
    const sin1 = a.u * ny - a.v * nx;                                 // signed sine of the angle to the normal
    const s2 = Math.max(-1, Math.min(1, (phaseSpeed(h, tpS) / c1) * sin1)), c2 = Math.sqrt(1 - s2 * s2);
    return { u: nx * c2 + ny * s2, v: ny * c2 - nx * s2, speed: a.speed };
  } };
}

export default function NhMap({ spots, wind, swell, layers, depth, ribbon, ocean, onHover, selectedId, onSelect }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const overlay = useRef<MapboxOverlay | null>(null);
  const markers = useRef<Map<string, Marker>>(new Map());
  const [ready, setReady] = useState(false);
  const windLines = useRef<Streamline[]>([]);
  const swellLines = useRef<Streamline[]>([]);
  const rayFields = useRef<Array<{ id: string; field: RayField; tier: Tier; tCut: number }>>([]);
  const raf = useRef(0);
  const t0 = useRef(0);
  const propsRef = useRef({ spots, layers, ribbon, ocean, wind, selectedId, onHover, onSelect });
  useEffect(() => { propsRef.current = { spots, layers, ribbon, ocean, wind, selectedId, onHover, onSelect }; });

  useEffect(() => {
    if (!el.current || map.current) return;
    const m = new MLMap({ container: el.current, style: STYLE, bounds: [[NH_BBOX.west, NH_BBOX.south], [NH_BBOX.east, NH_BBOX.north]], fitBoundsOptions: { padding: 8 }, maxZoom: 15, attributionControl: { compact: true } });
    t0.current = performance.now();
    m.on("load", () => {
      // deck.gl 9.4's interleaved integration reads map.transform; MapLibre 6 no longer exposes it on Map
      const mm = m as unknown as { transform?: unknown; _camera?: { transform?: unknown }; painter?: { transform?: unknown } };
      if (mm.transform === undefined) Object.defineProperty(m, "transform", { get: () => mm._camera?.transform ?? mm.painter?.transform, configurable: true });
      overlay.current = new MapboxOverlay({ interleaved: true, layers: [] }); m.addControl(overlay.current); setReady(true);
    });
    m.on("click", () => propsRef.current.onSelect(null));
    map.current = m;
    if (process.env.NODE_ENV !== "production") (window as unknown as { __nhMap?: MLMap }).__nhMap = m;
    return () => { cancelAnimationFrame(raf.current); markers.current.forEach((k) => k.remove()); markers.current.clear(); m.remove(); map.current = null; overlay.current = null; setReady(false); };
  }, []);

  // L3 chart-mode land fill
  useEffect(() => { const m = map.current; if (!m || !ready) return; if (m.getLayer("land-fill")) m.setLayoutProperty("land-fill", "visibility", layers.landFill ? "visible" : "none"); if (m.getLayer("bathy")) m.setLayoutProperty("bathy", "visibility", layers.bathy ? "visible" : "none"); }, [layers.landFill, layers.bathy, ready]);

  // L1 precompute per step: streamlines (wind, swell) and ray fields (crests)
  const windComets = useRef<Comet[]>([]);
  const swellComets = useRef<Comet[]>([]);
  const tpRef = useRef(9);
  const thin = useRef({ key: -1, wind: [] as Comet[], swell: [] as Comet[] });   // zoom-thinned views of the comet arrays (stable identity per zoom step)
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
      let tCut = Infinity;   // travel time at which the fan first enters the refraction zone (drives the crest fade-in)
      field.depths.forEach((hs, r) => { const k = hs.findIndex((h) => h <= CREST_MAX_DEPTH); if (k > 0) tCut = Math.min(tCut, field.times[r][k]); });
      return { id: s.id, tier: s.tier, field, tCut: Number.isFinite(tCut) ? tCut : 0 };
    });
    if (process.env.NODE_ENV !== "production") (window as unknown as { __nhFlow?: unknown }).__nhFlow = { wind, swell, swellR: swell && refractSwell(swell, depth, tp), lines: swellLines.current, windLines: windLines.current, rayFields, crestsAt, spots };
  }, [wind, swell, spots, depth]);

  // L4 HTML pins
  useEffect(() => {
    const m = map.current; if (!m || !ready) return;
    const seen = new Set<string>();
    for (const s of spots) {
      seen.add(s.id);
      let k = markers.current.get(s.id);
      if (!k) {
        const root = document.createElement("div"); root.style.cursor = "pointer";
        root.addEventListener("click", (ev) => { ev.stopPropagation(); propsRef.current.onSelect(s.id); });
        k = new Marker({ element: root, anchor: "bottom" }).setLngLat([s.lon, s.lat]).addTo(m); markers.current.set(s.id, k);
      }
      k.getElement().innerHTML = `<div style="display:flex;align-items:center;gap:4px">${pin(s.tier, s.state)}<span style="padding:3px 6px;border-radius:4px;background:rgba(14,33,42,.72);font:700 11px 'Barlow',sans-serif;letter-spacing:.04em;text-transform:uppercase;color:#fff">${s.name.split(" (")[0]}</span></div>`;
    }
    for (const [id, k] of markers.current) if (!seen.has(id)) { k.remove(); markers.current.delete(id); }
  }, [spots, ready]);

  // deck.gl frame loop: rebuild the interleaved layer stack every frame (animation state lives here)
  useEffect(() => {
    if (!ready) return;
    const tick = () => {
      raf.current = requestAnimationFrame(tick);
      const ov = overlay.current; if (!ov) return;
      const { layers: L, ribbon: R, wind: Wf, spots: S, selectedId: sel, onHover: hov } = propsRef.current;
      const t = (performance.now() - t0.current) / 1000;
      // density follows zoom: all streamlines from z11.5 up, a third per zoom level below (seed rank is random, so thinning stays uniform)
      const keep = Math.round(Math.min(1, Math.pow(3, (map.current?.getZoom() ?? 12) - 11.5)) * 40) / 40;
      if (keep !== thin.current.key) thin.current = { key: keep, wind: windComets.current.filter((c) => c.rank < keep), swell: swellComets.current.filter((c) => c.rank < keep) };
      const out: Layer[] = [];
      const masked = {};
      const beforeId = "deck-anchor";
      if (L.wind && thin.current.wind.length) out.push(new TripsLayer({ id: "wind-flow", beforeId, data: thin.current.wind, ...masked,
        getPath: (d: Comet) => d.path, getTimestamps: (d: Comet) => d.path.map((_, i) => i + d.shift), getColor: () => [100, 213, 204, 190], widthUnits: "pixels", getWidth: 1.3, capRounded: true, jointRounded: true,
        trailLength: TRAIL.wind, currentTime: (t * 9) % LOOP.wind, fadeTrail: true, opacity: 0.8 }));
      if (L.swell && thin.current.swell.length) out.push(new TripsLayer({ id: "swell-flow", beforeId, data: thin.current.swell, ...masked,
        getPath: (d: Comet) => d.path, getTimestamps: (d: Comet) => d.path.map((_, i) => i + d.shift), getColor: (d: Comet) => { const c = cometColor(d.speed, tpRef.current); return [c[0], c[1], c[2], 235]; }, updateTriggers: { getColor: tpRef.current },
        widthUnits: "pixels", getWidth: 2, capRounded: true, jointRounded: true, trailLength: TRAIL.swell, currentTime: (t * 5.5) % LOOP.swell, fadeTrail: true, opacity: 0.85 }));
      if (L.crests) { const every = Math.max(12, Math.min(60, 250 / (1.56 * tpRef.current))), phase = (t % (every / 10)) * 10;   /* ≈250 m between crests in deep water, whatever the period */ const paths: Array<{ path: Array<[number, number]>; color: number[]; w: number }> = [];
        for (const rf of rayFields.current) { const dim = sel && sel !== rf.id;
          for (const cr of crestsAt(rf.field, phase, every, CREST_MAX_DEPTH)) {
            const near = Math.max(0, Math.min(1, (cr.t - rf.tCut) / Math.max(1, rf.field.tMax - rf.tCut)));
            const a = 185 * Math.min(1, near / 0.25) * (0.4 + 0.6 * near) * (dim ? 0.35 : 1);
            paths.push({ path: cr.points, color: [205, 242, 255, Math.round(a)], w: 1.1 + 1.1 * near }); } }
        out.push(new PathLayer({ id: "crests", beforeId, data: paths, ...masked, getPath: (d) => d.path, getColor: (d) => d.color as [number, number, number, number], getWidth: (d) => d.w, widthUnits: "pixels", capRounded: true, jointRounded: true })); }
      if (L.ribbon && R.length) out.push(new PathLayer({ id: "ribbon", beforeId, data: R, getPath: (f: RibbonFeature) => f.geometry.coordinates,
        getColor: (f: RibbonFeature) => { const w = Wf?.at(f.properties.m[1], f.properties.m[0]); if (!w) return [180, 180, 180, 120]; const c = ribbonColor((Math.atan2(w.u, w.v) * 180) / Math.PI, w.speed * 1.944, f.properties.n); return [c[0], c[1], c[2], 235]; },
        updateTriggers: { getColor: [Wf] }, widthUnits: "pixels", getWidth: 4, widthMinPixels: 3, capRounded: true }));
      if (L.pulses) { const ph = (s: NhSpot) => (t / 2.6 + hash01(s.id)) % 1, ease = (p: number) => 1 - (1 - p) * (1 - p);   // staggered per break, eased
        out.push(new ScatterplotLayer({ id: "pulses", beforeId, data: S.filter((s) => s.tier !== "poor"), getPosition: (s: NhSpot) => [s.lon, s.lat], radiusUnits: "meters", getRadius: (s: NhSpot) => 200 + 1000 * ease(ph(s)) * (s.hs_m / 2 + 0.5), stroked: true, filled: true,
          getFillColor: (s: NhSpot) => { const c = hexToRgb(TIER[s.tier]); return [c[0], c[1], c[2], Math.round(36 * (1 - ph(s)))]; }, getLineColor: (s: NhSpot) => { const c = hexToRgb(TIER[s.tier]); return [c[0], c[1], c[2], Math.round(200 * (1 - ph(s)) ** 2)]; }, lineWidthUnits: "pixels", getLineWidth: 1.5, updateTriggers: { getRadius: t, getFillColor: t, getLineColor: t } })); }
      // pickable hit targets for hover tooltips (React-driven)
      out.push(new ScatterplotLayer({ id: "spot-hit", data: S, getPosition: (s: NhSpot) => [s.lon, s.lat], radiusUnits: "pixels", getRadius: 18, getFillColor: [0, 0, 0, 0], pickable: true,
        onHover: (info) => { if (!info.object) { hov(null); return; } const s = info.object as NhSpot; let best: RibbonFeature | null = null, bd = Infinity;
          for (const f of R) { const dx = (f.properties.m[0] - s.lon) * Math.cos((s.lat * Math.PI) / 180), dy = f.properties.m[1] - s.lat; const d = dx * dx + dy * dy; if (d < bd) { bd = d; best = f; } }
          const w = Wf?.at(s.lat, s.lon); const toward = w ? (Math.atan2(w.u, w.v) * 180) / Math.PI : null;
          const ang = best && toward !== null ? Math.abs((((toward - best.properties.n) + 540) % 360) - 180) : null;
          const rt = ang === null ? null : ang <= 60 ? "offshore" : ang <= 105 ? "cross" : "onshore";
          hov({ spot: s, x: info.x, y: info.y, ribbonAngle: ang, ribbonTier: rt }); } }));
      ov.setProps({ layers: out });
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [ready]);

  return <div className="nesurf-map absolute inset-0" style={{ zIndex: 0, isolation: "isolate" }}><div ref={el} className="h-full w-full" /></div>;
}

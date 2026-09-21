"use client";
/**
 * New Hampshire Sandbox — 5-layer marine architecture on MapLibre GL + deck.gl (interleaved) + self-hosted MVT.
 *   L0 bathymetric base   MapLibre vector fill, `interpolate` on min_depth (public/tiles/nh, layer `bathy`)
 *   L1 physics            deck.gl TripsLayer comets for wind + swell, PathLayer refraction crests — GPU, masked to the ocean
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
import { hexToRgb, ribbonColor, swellColor, TIER, type Tier } from "@/lib/colors";
import { NH_BBOX, depthAt, tileAround, type DepthGrid, type RibbonFeature } from "@/lib/nhData";
import { crestsAt, traceRays, type RayField } from "@/lib/refraction";
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
    nh: { type: "vector", tiles: [`${typeof window !== "undefined" ? window.location.origin : ""}/tiles/nh/{z}/{x}/{y}.pbf`], minzoom: 8, maxzoom: 14, bounds: [NH_BBOX.west, NH_BBOX.south, NH_BBOX.east, NH_BBOX.north] },
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
const cyan = hexToRgb("#00E5FF");

export default function NhMap({ spots, wind, swell, layers, depth, ribbon, ocean, onHover, selectedId, onSelect }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const overlay = useRef<MapboxOverlay | null>(null);
  const markers = useRef<Map<string, Marker>>(new Map());
  const [ready, setReady] = useState(false);
  const windLines = useRef<Streamline[]>([]);
  const swellLines = useRef<Streamline[]>([]);
  const rayFields = useRef<Array<{ id: string; field: RayField; tier: Tier }>>([]);
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
  useEffect(() => {
    if (!depth) return;
    const isOcean = (lat: number, lon: number) => depthAt(depth, lat, lon) > 0;
    windLines.current = wind ? integrateStreamlines(wind, NH_BBOX, isOcean, { seedsAcross: 36, stepM: 200, maxSteps: 70, seed: 3 }) : [];
    swellLines.current = swell ? integrateStreamlines(swell, NH_BBOX, isOcean, { seedsAcross: 13, stepM: 360, maxSteps: 46, seed: 11 }) : [];
    rayFields.current = spots.filter((s) => s.dp !== null && s.tp !== null && s.hs_m > 0.3).map((s) => ({ id: s.id, tier: s.tier, field: traceRays(tileAround(depth, s.lat, s.lon), s.lat, s.lon, s.dp!, s.tp!, s.hs_m, { rays: 25, spanM: 5000, startKm: 7, stepM: 50 }) }));
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
      const out: Layer[] = [];
      const masked = {};
      const beforeId = "deck-anchor";
      if (L.wind && windLines.current.length) out.push(new TripsLayer({ id: "wind-flow", beforeId, data: windLines.current, ...masked,
        getPath: (d: Streamline) => d.path, getTimestamps: (d: Streamline) => d.path.map((_, i) => i), getColor: () => [100, 213, 204, 210], widthUnits: "pixels", getWidth: 1.4, capRounded: true, jointRounded: true,
        trailLength: 18, currentTime: (t * 10) % 90, fadeTrail: true, opacity: 0.85 }));
      if (L.swell && swellLines.current.length) out.push(new TripsLayer({ id: "swell-flow", beforeId, data: swellLines.current, ...masked,
        getPath: (d: Streamline) => d.path, getTimestamps: (d: Streamline) => d.path.map((_, i) => i), getColor: (d: Streamline) => { const c = swellColor(d.speed * 3.28084, 10); return [c[0], c[1], c[2], 200]; },
        widthUnits: "pixels", getWidth: 1.6, capRounded: true, trailLength: 22, currentTime: (t * 5 + 30) % 70, fadeTrail: true, opacity: 0.7 }));
      if (L.crests) { const phase = (t % 2.5) * 10; const paths: Array<{ path: Array<[number, number]>; color: number[]; w: number }> = [];
        for (const rf of rayFields.current) { const dim = sel && sel !== rf.id; const c = hexToRgb(TIER[rf.tier]);
          for (const cr of crestsAt(rf.field, phase, 25)) { const near = cr.t / Math.max(1, rf.field.tMax); paths.push({ path: cr.points, color: [c[0], c[1], c[2], Math.round((70 + 160 * near) * (dim ? 0.4 : 1))], w: 1.2 + near }); } }
        out.push(new PathLayer({ id: "crests", beforeId, data: paths, ...masked, getPath: (d) => d.path, getColor: (d) => d.color as [number, number, number, number], getWidth: (d) => d.w, widthUnits: "pixels", capRounded: true, jointRounded: true })); }
      if (L.ribbon && R.length) out.push(new PathLayer({ id: "ribbon", beforeId, data: R, getPath: (f: RibbonFeature) => f.geometry.coordinates,
        getColor: (f: RibbonFeature) => { const w = Wf?.at(f.properties.m[1], f.properties.m[0]); if (!w) return [180, 180, 180, 120]; const c = ribbonColor((Math.atan2(w.u, w.v) * 180) / Math.PI, w.speed * 1.944, f.properties.n); return [c[0], c[1], c[2], 235]; },
        updateTriggers: { getColor: [Wf] }, widthUnits: "pixels", getWidth: 4, widthMinPixels: 3, capRounded: true }));
      if (L.pulses) { const p = (t % 2) / 2;
        out.push(new ScatterplotLayer({ id: "pulses", beforeId, data: S.filter((s) => s.tier !== "poor"), getPosition: (s: NhSpot) => [s.lon, s.lat], radiusUnits: "meters", getRadius: (s: NhSpot) => 250 + 900 * p * (s.hs_m / 2 + 0.5), stroked: true, filled: true,
          getFillColor: (s: NhSpot) => { const c = hexToRgb(TIER[s.tier]); return [c[0], c[1], c[2], Math.round(40 * (1 - p))]; }, getLineColor: (s: NhSpot) => { const c = hexToRgb(TIER[s.tier]); return [c[0], c[1], c[2], Math.round(220 * (1 - p))]; }, lineWidthUnits: "pixels", getLineWidth: 2, updateTriggers: { getRadius: p, getFillColor: p, getLineColor: p } })); }
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

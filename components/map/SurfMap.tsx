"use client";
import { Map as MLMap, Marker, setWorkerUrl, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./map.css";
import { useEffect, useRef, useState } from "react";
import type { GridIndex, HrrrStep, Ww3Step } from "@/lib/cache";
import { TIER, WIND_ALIGN, windAlignment, windTier, type Tier } from "@/lib/colors";
import { BBOX } from "@/lib/grid";
import { windVectorField, type VectorField } from "@/lib/overlays";
import { traceRays, type DepthTile } from "@/lib/refraction";
import { FieldCanvas, type RibbonSeg } from "./FieldCanvas";
import { FlowCanvas, type CrestSet } from "./FlowCanvas";

export interface SpotMarker {
  id: string; name: string; state: string; lat: number; lon: number; tier: Tier; score: number; featured: boolean;
  callout?: { name: string; body: string }; swell?: { dp: number; tp: number; hs_m: number } | null;
}
export interface BuoyMarker { id: string; lat: number; lon: number; label: string; ok: boolean }
export type Mode = "forecast" | "refraction" | "buoys";
export interface Layers { satellite: boolean; energy: boolean; streamlines: boolean; crests: boolean; ribbon: boolean; labels: boolean }
export interface HoverInfo { id: string; windAlign: number; windTier: "offshore" | "cross" | "onshore" | null; windFrom: number | null; windKts: number | null; period: number | null; tier: Tier; normal: number | null }

interface Props {
  spots: SpotMarker[]; buoys: BuoyMarker[]; selectedId: string | null; onSelect: (id: string | null) => void; onHover?: (h: HoverInfo | null) => void;
  mode: Mode; layers: Layers; wind: { index: GridIndex; step: HrrrStep } | { index: GridIndex; step: Ww3Step } | null; swell: { index: GridIndex; step: Ww3Step } | null;
  flyTo: { lon: number; lat: number; key: number } | null;
}

const SATELLITE: StyleSpecification = {
  version: 8, glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
  sources: { esri: { type: "raster", tileSize: 256, maxzoom: 18, tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"], attribution: "Imagery © Esri, Maxar, Earthstar Geographics, GIS User Community" } },
  layers: [{ id: "esri", type: "raster", source: "esri", paint: { "raster-saturation": -0.25, "raster-brightness-max": 0.8 } }],
};
const PLAIN: StyleSpecification = { version: 8, glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf", sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#0B192C" } }] };
setWorkerUrl("/vendor/maplibre/maplibre-gl-worker.mjs");

const pinSvg = (tier: Tier, featured: boolean, state: string) => featured
  ? `<svg width="22" height="28" viewBox="0 0 22 28"><path d="M11 0 C5 0 0 4.8 0 10.8 C0 18.5 11 28 11 28 C11 28 22 18.5 22 10.8 C22 4.8 17 0 11 0 Z" fill="${TIER[tier]}" stroke="#0e2029" stroke-width="1.5"/><text x="11" y="14.5" text-anchor="middle" font-family="Barlow, sans-serif" font-size="8" font-weight="800" fill="#0e2029">${state}</text></svg>`
  : `<svg width="16" height="20" viewBox="0 0 16 20"><path d="M8 0 C3.6 0 0 3.5 0 7.8 C0 13.4 8 20 8 20 C8 20 16 13.4 16 7.8 C16 3.5 12.4 0 8 0 Z" fill="${TIER[tier]}" stroke="#0e2029" stroke-width="1.2"/><circle cx="8" cy="7.8" r="2.6" fill="#0e2029"/></svg>`;

interface Entry { marker: Marker; el: HTMLDivElement; pin: HTMLDivElement; label: HTMLDivElement; callout: HTMLDivElement; tip: HTMLDivElement }
type Rings = number[][][];
const dist2 = (a: [number, number], b: [number, number], lat: number) => { const kx = Math.cos((lat * Math.PI) / 180); const dx = (a[0] - b[0]) * kx, dy = a[1] - b[1]; return dx * dx + dy * dy; };

export default function SurfMap({ spots, buoys, selectedId, onSelect, onHover, mode, layers, wind, swell, flyTo }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const flow = useRef<FlowCanvas | null>(null);
  const field = useRef<FieldCanvas | null>(null);
  const entries = useRef<Map<string, Entry>>(new Map());
  const buoyMarkers = useRef<Marker[]>([]);
  const land = useRef<Rings>([]);
  const ribbon = useRef<RibbonSeg[]>([]);
  const tiles = useRef<Record<string, DepthTile>>({});
  const windField = useRef<VectorField | null>(null);
  const onSelectRef = useRef(onSelect); useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);
  const onHoverRef = useRef(onHover); useEffect(() => { onHoverRef.current = onHover; }, [onHover]);
  const [ready, setReady] = useState(false);
  const [geoReady, setGeoReady] = useState(0);

  /** Callouts win, then labels by rank: drop whatever overlaps something already kept (pins always stay). */
  const collide = () => {
    const m = map.current; if (!m) return;
    const W = m.getContainer().clientWidth; const kept: DOMRect[] = [];
    const hits = (r: DOMRect) => kept.some((k) => !(r.right < k.left || r.left > k.right || r.bottom < k.top || r.top > k.bottom));
    const sorted = [...entries.current.values()].sort((a, b) => Number(b.el.dataset.score) - Number(a.el.dataset.score));
    for (const e of sorted) { if (e.callout.style.display === "none") continue; e.callout.style.left = "12px"; e.callout.style.right = "auto"; let r = e.callout.getBoundingClientRect(); if (r.right > W - 8) { e.callout.style.left = "auto"; e.callout.style.right = "12px"; r = e.callout.getBoundingClientRect(); } kept.push(r); }
    for (const e of sorted) { e.label.style.visibility = "visible"; const r = e.label.getBoundingClientRect(); if (hits(r)) e.label.style.visibility = "hidden"; else kept.push(r); }
  };

  /** Hover (Step 4): highlight the spot's nearest ribbon segment and show wind angle · period · tier. */
  const hover = (id: string, on: boolean) => {
    const e = entries.current.get(id); const s = spots.find((x) => x.id === id); if (!e || !s) return;
    if (!on) { e.tip.style.display = "none"; flow.current?.setHighlight(null); onHoverRef.current?.(null); return; }
    let best: RibbonSeg | null = null, bd = Infinity;
    for (const seg of ribbon.current) { const d = dist2(seg.m, [s.lon, s.lat], s.lat); if (d < bd) { bd = d; best = seg; } }
    if (best && bd > (2 / 111) ** 2) best = null;   // no ribbon within ~2 km
    const w = windField.current?.at(s.lat, s.lon) ?? null;
    const toward = w ? (Math.atan2(w.u, w.v) * 180) / Math.PI : null;
    const align = w && best ? windAlignment(toward!, best.n) : 0;
    const wt = w && best ? windTier(align) : null;
    const info: HoverInfo = { id, windAlign: align, windTier: wt, windFrom: toward === null ? null : (toward + 180) % 360, windKts: w ? w.speed * 1.944 : null, period: s.swell?.tp ?? null, tier: s.tier, normal: best?.n ?? null };
    const tierWord = s.tier === "green" ? "Green" : s.tier === "moderate" ? "Moderate" : "Poor";
    const angle = best && toward !== null ? `${Math.round(Math.abs((((toward - best.n) + 540) % 360) - 180))}° off the beach normal` : "no beach normal";
    e.tip.innerHTML = `<div style="font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:${TIER[s.tier]}">${tierWord}</div>` +
      `<div>Wind ${w ? `${Math.round(w.speed * 1.944)} kt from ${Math.round(info.windFrom!)}° · ${angle}` : "n/a"}${wt ? ` · <span style="color:${WIND_ALIGN[wt]}">${wt}</span>` : ""}</div>` +
      `<div>Swell ${s.swell ? `${s.swell.tp.toFixed(0)}s from ${Math.round(s.swell.dp)}°` : "n/a"}</div>`;
    e.tip.style.display = "block";
    flow.current?.setHighlight(best ? { a: best.a, b: best.b, color: wt ? WIND_ALIGN[wt] : "#ffffff" } : null);
    onHoverRef.current?.(info);
  };

  // map + static geodata (land polygons, ribbon, depth tiles) once
  useEffect(() => {
    if (!el.current || map.current) return;
    const m = new MLMap({ container: el.current, style: SATELLITE, attributionControl: { compact: true },
      bounds: [[-72.2, 40.9], [-69.6, 43.6]], fitBoundsOptions: { padding: 12 }, maxBounds: [[BBOX.west - 1, BBOX.south - 1], [BBOX.east + 1, BBOX.north + 1]], minZoom: 5.5 });
    m.on("load", () => { field.current = new FieldCanvas(m); flow.current = new FlowCanvas(m); setReady(true); });
    m.on("click", () => onSelectRef.current(null));
    m.on("move", () => collide());
    map.current = m;
    if (process.env.NODE_ENV !== "production") (window as unknown as { __nesurfMap?: MLMap }).__nesurfMap = m;
    let live = true;
    fetch("/data/coast-land.geojson").then((r) => r.json()).then((fc: { features: Array<{ geometry: { type: string; coordinates: number[][][] | number[][][][] } }> }) => {
      if (!live) return; const rings: Rings = [];
      // exterior rings only: holes are inland ponds/lakes, which stay land for clipping (estuaries are part of the exterior)
      for (const f of fc.features) { const g = f.geometry; if (g.type === "Polygon") rings.push((g.coordinates as number[][][])[0]); else (g.coordinates as number[][][][]).forEach((poly) => rings.push(poly[0])); }
      land.current = rings; field.current?.setLand(rings); flow.current?.setLand(rings); setGeoReady((n) => n + 1);
    }).catch(() => {});
    fetch("/data/coast-ribbon.compact.json").then((r) => r.json()).then((c: { ids: number[]; segs: number[][] }) => {
      if (!live) return;
      ribbon.current = c.segs.map((s, k) => ({ id: c.ids[k], a: [s[0], s[1]], b: [s[2], s[3]], m: [(s[0] + s[2]) / 2, (s[1] + s[3]) / 2], n: s[4] }));
      field.current?.setRibbon(ribbon.current); setGeoReady((n) => n + 1);
    }).catch(() => {});
    fetch("/data/bathy-tiles.json").then((r) => r.json()).then((t: Record<string, DepthTile>) => { if (live) { tiles.current = t; setGeoReady((n) => n + 1); } }).catch(() => {});
    return () => { live = false; flow.current?.destroy(); field.current?.destroy(); flow.current = null; field.current = null; entries.current.forEach((e) => e.marker.remove()); entries.current.clear(); m.remove(); map.current = null; setReady(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // when the canvases come up after the geodata arrived
  useEffect(() => { if (!ready) return; field.current?.setLand(land.current); flow.current?.setLand(land.current); field.current?.setRibbon(ribbon.current); }, [ready, geoReady]);

  // basemap toggle
  useEffect(() => {
    const m = map.current; if (!m || !ready) return;
    const want = layers.satellite ? "sat" : "plain"; const cur = (m as unknown as { __base?: string }).__base ?? "sat";
    if (want === cur) return; (m as unknown as { __base?: string }).__base = want;
    m.setStyle(layers.satellite ? SATELLITE : PLAIN);
  }, [layers.satellite, ready]);

  // ocean field + ribbon + streamlines per step / mode
  useEffect(() => {
    if (!ready) return;
    windField.current = wind ? windVectorField(wind) : null;
    const f = field.current!;
    f.mode = mode === "refraction" ? "bathy" : layers.energy ? "energy" : "none";
    f.setWind(layers.ribbon ? windField.current : null);
    f.setSwell(swell);
    flow.current?.setField(layers.streamlines && mode !== "buoys" ? windField.current : null);
  }, [wind, swell, mode, layers.energy, layers.ribbon, layers.streamlines, ready]);

  // refraction crest lines per active break (Step 3): trace rays once per day/step, animate per frame
  useEffect(() => {
    if (!ready) return;
    const sets: CrestSet[] = [];
    if (layers.crests && mode !== "buoys") for (const s of spots) {
      const tile = tiles.current[s.id]; if (!tile || !s.swell || s.swell.hs_m < 0.3) continue;
      if (s.tier === "poor" && !s.featured && s.id !== selectedId) continue;
      sets.push({ id: s.id, field: traceRays(tile, s.lat, s.lon, s.swell.dp, s.swell.tp, s.swell.hs_m), color: TIER[s.tier], dim: !!selectedId && selectedId !== s.id });
    }
    flow.current?.setCrests(sets);
  }, [spots, selectedId, layers.crests, mode, ready, geoReady]);

  // pins, labels, callouts, hover tooltips
  useEffect(() => {
    const m = map.current; if (!m || !ready) return;
    const seen = new Set<string>();
    for (const s of spots) {
      seen.add(s.id);
      let e = entries.current.get(s.id);
      if (!e) {
        const root = document.createElement("div"); root.className = "relative"; root.style.cursor = "pointer";
        const pin = document.createElement("div"); pin.className = "absolute -translate-x-1/2 -translate-y-full";
        const label = document.createElement("div"); label.className = "absolute whitespace-nowrap";
        Object.assign(label.style, { left: "12px", top: "-22px", padding: "3px 6px", borderRadius: "4px", background: "rgba(14,33,42,0.72)", fontSize: "11px", fontWeight: "700", letterSpacing: "0.04em", textTransform: "uppercase", color: "#ffffff", lineHeight: "normal", fontFamily: "'Barlow', system-ui, sans-serif" });
        const callout = document.createElement("div"); callout.className = "absolute whitespace-nowrap";
        Object.assign(callout.style, { display: "none", left: "12px", top: "12px", height: "24px", padding: "0px 8px", borderRadius: "4px", background: "#0e212a", boxShadow: "0px 3px 10px rgba(0,0,0,0.4)", alignItems: "center", gap: "4px", fontSize: "10px", fontWeight: "500", color: "#ffffff", lineHeight: "normal", fontFamily: "'Barlow', system-ui, sans-serif" });
        const tip = document.createElement("div"); tip.className = "absolute whitespace-nowrap";
        Object.assign(tip.style, { display: "none", left: "12px", top: "40px", padding: "4px 8px", borderRadius: "4px", background: "#0e212a", boxShadow: "0px 3px 10px rgba(0,0,0,0.4)", fontSize: "10px", fontWeight: "500", color: "#ffffff", lineHeight: "1.35", fontFamily: "'Barlow', system-ui, sans-serif", zIndex: "40" });
        root.append(pin, label, callout, tip);
        root.addEventListener("click", (ev) => { ev.stopPropagation(); onSelectRef.current(s.id); });
        root.addEventListener("mouseenter", () => hover(s.id, true));
        root.addEventListener("mouseleave", () => hover(s.id, false));
        const marker = new Marker({ element: root, anchor: "bottom" }).setLngLat([s.lon, s.lat]).addTo(m);
        e = { marker, el: root, pin, label, callout, tip }; entries.current.set(s.id, e);
      }
      e.el.dataset.score = String(s.score); e.el.dataset.tier = s.tier;
      e.pin.innerHTML = pinSvg(s.tier, s.featured, s.state);
      e.label.textContent = s.name; e.label.style.display = layers.labels ? "" : "none"; e.label.style.top = s.featured ? "-27px" : "-21px";
      const showCallout = s.id === selectedId || (!selectedId && !!s.callout);
      if (showCallout && s.callout) { e.callout.innerHTML = `<span style="font-weight:700;color:${TIER[s.tier]};letter-spacing:0.02em">${s.callout.name}:</span><span>${s.callout.body}</span>`; e.callout.style.display = "flex"; }
      else e.callout.style.display = "none";
      e.marker.getElement().style.zIndex = s.id === selectedId ? "30" : s.featured ? "20" : "10";
      e.marker.setLngLat([s.lon, s.lat]);
    }
    for (const [id, e] of entries.current) if (!seen.has(id)) { e.marker.remove(); entries.current.delete(id); }
    collide(); const raf = requestAnimationFrame(() => requestAnimationFrame(collide));
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spots, selectedId, layers.labels, ready]);

  // buoy markers (live buoy feed mode)
  useEffect(() => {
    const m = map.current; if (!m || !ready) return;
    buoyMarkers.current.forEach((b) => b.remove()); buoyMarkers.current = [];
    if (mode !== "buoys") return;
    for (const b of buoys) {
      const root = document.createElement("div"); root.className = "flex items-center gap-1.5";
      root.innerHTML = `<span style="width:10px;height:10px;border-radius:9999px;background:${b.ok ? "#E8EEF2" : "#9C9EA1"};border:2px solid #0E2029;box-shadow:0 0 0 2px ${b.ok ? "#64D5CC" : "transparent"}"></span><span style="padding:3px 6px;border-radius:4px;background:rgba(14,33,42,0.72);font-size:11px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:#fff;line-height:normal;font-family:'Barlow',system-ui,sans-serif">${b.label}</span>`;
      buoyMarkers.current.push(new Marker({ element: root, anchor: "left" }).setLngLat([b.lon, b.lat]).addTo(m));
    }
  }, [buoys, mode, ready]);

  useEffect(() => { const m = map.current; if (!m || !flyTo) return; m.flyTo({ center: [flyTo.lon, flyTo.lat], zoom: Math.max(m.getZoom(), 10), duration: 900 }); }, [flyTo]);

  return <div className="nesurf-map absolute inset-0" style={{ zIndex: 0, isolation: "isolate" }}><div ref={el} className="h-full w-full" /></div>;
}

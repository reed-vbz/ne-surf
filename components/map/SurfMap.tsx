"use client";
import { Map as MLMap, Marker, setWorkerUrl, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./map.css";
import { useEffect, useRef, useState } from "react";
import type { GridIndex, HrrrStep, Ww3Step } from "@/lib/cache";
import { BBOX } from "@/lib/grid";
import { BAND_HEX, bathyDataUrl, oceanTintDataUrl, windShadeDataUrl, windVectorField, zonesDataUrl, type Band } from "@/lib/overlays";
import { FlowCanvas, type Ring } from "./FlowCanvas";

export interface SpotMarker { id: string; name: string; state: string; lat: number; lon: number; band: Band; score: number; featured: boolean; callout?: { name: string; body: string }; ringRadius: number }
export interface BuoyMarker { id: string; lat: number; lon: number; label: string; ok: boolean }
export type Mode = "forecast" | "refraction" | "buoys";
export interface Layers { satellite: boolean; zones: boolean; streamlines: boolean; rings: boolean; labels: boolean; windBand: boolean }

interface Props {
  spots: SpotMarker[]; buoys: BuoyMarker[]; selectedId: string | null; onSelect: (id: string | null) => void;
  mode: Mode; layers: Layers; wind: { index: GridIndex; step: HrrrStep } | { index: GridIndex; step: Ww3Step } | null;
  flyTo: { lon: number; lat: number; key: number } | null;
}

const SATELLITE: StyleSpecification = {
  version: 8, glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
  sources: { esri: { type: "raster", tileSize: 256, maxzoom: 18, tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
    attribution: "Imagery © Esri, Maxar, Earthstar Geographics, GIS User Community" } },
  layers: [{ id: "esri", type: "raster", source: "esri", paint: { "raster-saturation": -0.2, "raster-brightness-max": 0.9 } }],
};
const PLAIN: StyleSpecification = { version: 8, glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf", sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#0E2029" } }] };
const COORDS: [[number, number], [number, number], [number, number], [number, number]] = [[BBOX.west, BBOX.north], [BBOX.east, BBOX.north], [BBOX.east, BBOX.south], [BBOX.west, BBOX.south]];
setWorkerUrl("/vendor/maplibre/maplibre-gl-worker.mjs");

function setRaster(m: MLMap, id: string, url: string | null, opacity: number) {
  if (m.getLayer(id)) m.removeLayer(id);
  if (m.getSource(id)) m.removeSource(id);
  if (!url) return;
  m.addSource(id, { type: "image", url, coordinates: COORDS });
  m.addLayer({ id, type: "raster", source: id, paint: { "raster-opacity": opacity, "raster-resampling": "linear", "raster-fade-duration": 300 } });
}

const pinSvg = (band: Band, featured: boolean, state: string) => featured
  ? `<svg width="22" height="28" viewBox="0 0 22 28"><path d="M11 27C11 27 21 16.5 21 10.5A10 10 0 0 0 1 10.5C1 16.5 11 27 11 27Z" fill="${BAND_HEX[band]}" stroke="#0E2029" stroke-width="1.5"/><text x="11" y="13.5" text-anchor="middle" font-family="Barlow, sans-serif" font-weight="800" font-size="8" fill="#0E2029">${state}</text></svg>`
  : `<svg width="16" height="20" viewBox="0 0 16 20"><path d="M8 19.3C8 19.3 15 11.8 15 7.5A7 7 0 0 0 1 7.5C1 11.8 8 19.3 8 19.3Z" fill="${BAND_HEX[band]}" stroke="#0E2029" stroke-width="1.3"/><circle cx="8" cy="7.5" r="2.4" fill="#0E2029"/></svg>`;

interface Entry { marker: Marker; el: HTMLDivElement; pin: HTMLDivElement; label: HTMLDivElement; callout: HTMLDivElement }

export default function SurfMap({ spots, buoys, selectedId, onSelect, mode, layers, wind, flyTo }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const flow = useRef<FlowCanvas | null>(null);
  const entries = useRef<Map<string, Entry>>(new Map());
  const buoyMarkers = useRef<Marker[]>([]);
  const onSelectRef = useRef(onSelect); useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);
  const [ready, setReady] = useState(false);
  const tint = useRef<string | null>(null);

  /** Callouts win, then labels by rank: drop whatever overlaps something already kept (pins always stay).
   *  Callouts near the right edge flip to the left of the pin. */
  const collide = () => {
    const m = map.current; if (!m) return;
    const W = m.getContainer().clientWidth;
    const kept: DOMRect[] = [];
    const hits = (r: DOMRect) => kept.some((k) => !(r.right < k.left || r.left > k.right || r.bottom < k.top || r.top > k.bottom));
    const sorted = [...entries.current.values()].sort((a, b) => Number(b.el.dataset.score) - Number(a.el.dataset.score));
    for (const e of sorted) {
      if (e.callout.classList.contains("hidden")) continue;
      e.callout.style.left = "12px"; e.callout.style.right = "auto";
      let r = e.callout.getBoundingClientRect();
      if (r.right > W - 8) { e.callout.style.left = "auto"; e.callout.style.right = "12px"; r = e.callout.getBoundingClientRect(); }
      kept.push(r);
    }
    for (const e of sorted) {
      e.label.style.visibility = "visible";
      const r = e.label.getBoundingClientRect();
      if (hits(r)) e.label.style.visibility = "hidden"; else kept.push(r);
    }
  };

  useEffect(() => {
    if (!el.current || map.current) return;
    const m = new MLMap({ container: el.current, style: SATELLITE, attributionControl: { compact: true },
      bounds: [[-72.2, 40.9], [-69.6, 43.6]], fitBoundsOptions: { padding: 12 }, maxBounds: [[BBOX.west - 1, BBOX.south - 1], [BBOX.east + 1, BBOX.north + 1]], minZoom: 5.5 });
    m.on("load", () => { flow.current = new FlowCanvas(m); setReady(true); });
    m.on("click", () => onSelectRef.current(null));
    m.on("move", () => collide());
    map.current = m;
    if (process.env.NODE_ENV !== "production") (window as unknown as { __nesurfMap?: MLMap }).__nesurfMap = m;
    return () => { flow.current?.destroy(); flow.current = null; entries.current.forEach((e) => e.marker.remove()); entries.current.clear(); m.remove(); map.current = null; setReady(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // basemap toggle (satellite vs plain chrome background)
  useEffect(() => {
    const m = map.current; if (!m || !ready) return;
    const want = layers.satellite ? "sat" : "plain"; const cur = (m as unknown as { __base?: string }).__base ?? "sat";
    if (want === cur) return; (m as unknown as { __base?: string }).__base = want;
    m.once("style.load", () => { setReady(false); setTimeout(() => setReady(true), 0); });
    m.setStyle(layers.satellite ? SATELLITE : PLAIN);
  }, [layers.satellite, ready]);

  // rasters: ocean tint, zones or bathymetry, coastal wind band
  useEffect(() => {
    const m = map.current; if (!m || !ready) return;
    const apply = () => {
      if (!m.isStyleLoaded()) { m.once("render", apply); return; }
      if (!tint.current) tint.current = oceanTintDataUrl();
      setRaster(m, "ocean-tint", tint.current, 0.55);
      const zoneUrl = mode === "refraction" ? bathyDataUrl() : layers.zones ? zonesDataUrl(spots.map((s) => ({ lat: s.lat, lon: s.lon, band: s.band }))) : null;
      setRaster(m, "zones", zoneUrl, 1);
      setRaster(m, "wind-band", layers.windBand && wind ? windShadeDataUrl(wind) : null, 0.75);
    };
    apply();
  }, [spots, mode, layers.zones, layers.windBand, wind, ready]);

  // streamlines
  useEffect(() => { if (!ready) return; flow.current?.setField(layers.streamlines && wind ? windVectorField(wind) : null); }, [wind, layers.streamlines, ready]);

  // rings: one per active (green) break, plus the selected break; others dim when one is selected
  useEffect(() => {
    if (!ready) return;
    const rings: Ring[] = mode === "buoys" || !layers.rings ? [] : spots.filter((s) => s.band === "good" || s.id === selectedId)
      .map((s) => ({ id: s.id, lon: s.lon, lat: s.lat, color: BAND_HEX[s.band], radius: s.ringRadius, dim: !!selectedId && selectedId !== s.id }));
    flow.current?.setRings(rings);
  }, [spots, selectedId, layers.rings, mode, ready]);

  // HTML markers: pin + plated label + callout
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
        const callout = document.createElement("div"); callout.className = "absolute whitespace-nowrap hidden";
        Object.assign(callout.style, { left: "12px", top: "12px", height: "24px", padding: "0px 8px", borderRadius: "4px", background: "#0e212a", boxShadow: "0px 3px 10px rgba(0,0,0,0.4)", display: "flex", alignItems: "center", gap: "4px", fontSize: "10px", fontWeight: "500", color: "#ffffff", lineHeight: "normal", fontFamily: "'Barlow', system-ui, sans-serif" });
        root.append(pin, label, callout);
        root.addEventListener("click", (ev) => { ev.stopPropagation(); onSelectRef.current(s.id); });
        const marker = new Marker({ element: root, anchor: "bottom" }).setLngLat([s.lon, s.lat]).addTo(m);
        e = { marker, el: root, pin, label, callout }; entries.current.set(s.id, e);
      }
      e.el.dataset.score = String(s.score);
      e.pin.innerHTML = pinSvg(s.band, s.featured, s.state);
      e.pin.style.marginTop = s.featured ? "0" : "0";
      e.label.textContent = s.name;
      e.label.style.display = layers.labels ? "" : "none";
      e.label.style.top = s.featured ? "-27px" : "-21px";
      const showCallout = s.id === selectedId || (!selectedId && !!s.callout);
      if (showCallout && s.callout) {
        e.callout.innerHTML = `<span style="font-weight:700;color:${BAND_HEX[s.band]};letter-spacing:0.02em">${s.callout.name}:</span><span>${s.callout.body}</span>`;
        e.callout.classList.remove("hidden"); e.callout.style.display = "flex";
      } else { e.callout.classList.add("hidden"); e.callout.style.display = "none"; }
      e.marker.getElement().style.zIndex = s.id === selectedId ? "30" : s.featured ? "20" : "10";
      e.marker.setLngLat([s.lon, s.lat]);
    }
    for (const [id, e] of entries.current) if (!seen.has(id)) { e.marker.remove(); entries.current.delete(id); }
    collide();
    const raf = requestAnimationFrame(() => requestAnimationFrame(collide));   // again once fonts/layout have settled
    return () => cancelAnimationFrame(raf);
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

  // fly to a spot (search / hotspot card)
  useEffect(() => { const m = map.current; if (!m || !flyTo) return; m.flyTo({ center: [flyTo.lon, flyTo.lat], zoom: Math.max(m.getZoom(), 9), duration: 900 }); }, [flyTo]);

  return <div className="nesurf-map absolute inset-0" style={{ zIndex: 0, isolation: "isolate" }}><div ref={el} className="h-full w-full" /></div>;
}

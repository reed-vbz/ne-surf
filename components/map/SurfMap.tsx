"use client";
import { Map as MLMap, NavigationControl, setWorkerUrl, type GeoJSONSource, type MapLayerMouseEvent, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import type { GridIndex, Ww3Step, HrrrStep } from "@/lib/cache";
import { BBOX, gridToDataUrl, windColor } from "@/lib/grid";
import { swellQuality, swellShadeDataUrl, windShadeDataUrl } from "@/lib/overlays";
import { SwellParticles } from "./SwellParticles";

export interface MarkerDatum { id: string; name: string; lat: number; lon: number; score: number; color: "grey" | "yellow" | "green"; face_ft: number; callout?: string }
export interface BuoyDatum { id: string; lat: number; lon: number; label: string; ok: boolean }
export interface Layers { swellShade: boolean; streamlines: boolean; windShade: boolean; windHeat: boolean; rings: boolean }

interface Props {
  markers: MarkerDatum[];
  buoys: BuoyDatum[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  ww3: { index: GridIndex; step: Ww3Step } | null;
  hrrr: { index: GridIndex; step: HrrrStep } | null;
  layers: Layers;
  basemap: "satellite" | "light";
}

const COLORS = { grey: "#9aa3ad", yellow: "#f5c400", green: "#2fbf71" };
const LIGHT_STYLE = "https://tiles.openfreemap.org/styles/positron"; // free, keyless, OpenMapTiles-based
// Esri World Imagery: free with attribution (https://www.esri.com/en-us/legal/terms/data-attributions)
const SATELLITE_STYLE: StyleSpecification = {
  version: 8, glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
  sources: { esri: { type: "raster", tileSize: 256, maxzoom: 18, tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
    attribution: "Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community" } },
  layers: [{ id: "esri", type: "raster", source: "esri", paint: { "raster-saturation": -0.35, "raster-brightness-max": 0.85 } }],
};
const COORDS: [[number, number], [number, number], [number, number], [number, number]] =
  [[BBOX.west, BBOX.north], [BBOX.east, BBOX.north], [BBOX.east, BBOX.south], [BBOX.west, BBOX.south]];

// MapLibre 6 resolves its worker with new URL(..., import.meta.url), which Turbopack does not serve;
// the postinstall script copies the worker (and its shared chunk) into public/vendor/maplibre.
setWorkerUrl("/vendor/maplibre/maplibre-gl-worker.mjs");

/** Replace an image source + raster layer (ImageSource.updateImage keeps a stale texture when dimensions change). */
function setRaster(m: MLMap, id: string, url: string | null, opacity: number, before: string) {
  if (m.getLayer(id)) m.removeLayer(id);
  if (m.getSource(id)) m.removeSource(id);
  if (!url) return;
  m.addSource(id, { type: "image", url, coordinates: COORDS });
  m.addLayer({ id, type: "raster", source: id, paint: { "raster-opacity": opacity, "raster-resampling": "linear", "raster-fade-duration": 0 } }, before);
}

function addOverlayLayers(m: MLMap) {
  m.addSource("buoys", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  m.addSource("spots", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  // anchor layer: rasters are inserted below it
  m.addLayer({ id: "overlay-anchor", type: "background", paint: { "background-opacity": 0 } });
  m.addLayer({ id: "buoy-dot", type: "circle", source: "buoys", paint: {
    "circle-radius": 5, "circle-color": ["case", ["get", "ok"], "#0f172a", "#94a3b8"], "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 } });
  m.addLayer({ id: "buoy-label", type: "symbol", source: "buoys", layout: {
    "text-field": ["get", "label"], "text-size": 10, "text-offset": [0, 1], "text-anchor": "top", "text-font": ["Noto Sans Regular"] },
    paint: { "text-color": "#fff", "text-halo-color": "#0f172a", "text-halo-width": 1 } });
  m.addLayer({ id: "spot-dot", type: "circle", source: "spots", paint: {
    "circle-radius": ["case", ["boolean", ["get", "selected"], false], 9, 7],
    "circle-color": ["get", "hex"], "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
  m.addLayer({ id: "spot-label", type: "symbol", source: "spots", layout: {
    "text-field": ["get", "label"], "text-size": 11, "text-offset": [0, 1.3], "text-anchor": "top", "text-font": ["Noto Sans Bold"], "text-allow-overlap": false },
    paint: { "text-color": "#fff", "text-halo-color": "#0f172a", "text-halo-width": 1.4 } });
  m.addLayer({ id: "spot-callout", type: "symbol", source: "spots", filter: ["has", "callout"], layout: {
    "text-field": ["get", "callout"], "text-size": 11, "text-offset": [0, -2.2], "text-anchor": "bottom", "text-font": ["Noto Sans Bold"],
    "text-max-width": 14, "text-allow-overlap": false, "text-optional": true, "text-padding": 6, "symbol-sort-key": ["-", 100, ["get", "score"]] },
    paint: { "text-color": "#e2fff0", "text-halo-color": "#064e3b", "text-halo-width": 2 } });
}

export default function SurfMap({ markers, buoys, selectedId, onSelect, ww3, hrrr, layers, basemap }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const particles = useRef<SwellParticles | null>(null);
  const onSelectRef = useRef(onSelect);
  useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);
  const [ready, setReady] = useState(false);

  // create the map once
  useEffect(() => {
    if (!el.current || map.current) return;
    const m = new MLMap({
      container: el.current, style: basemap === "satellite" ? SATELLITE_STYLE : LIGHT_STYLE, attributionControl: { compact: true },
      bounds: [[BBOX.west, BBOX.south], [BBOX.east, BBOX.north]], fitBoundsOptions: { padding: 24 },
      maxBounds: [[BBOX.west - 3, BBOX.south - 2], [BBOX.east + 3, BBOX.north + 2]],
    });
    m.addControl(new NavigationControl({ showCompass: false }), "top-right");
    m.on("load", () => {
      addOverlayLayers(m);
      m.on("click", "spot-dot", (e: MapLayerMouseEvent) => onSelectRef.current(String(e.features?.[0]?.properties?.id ?? "")));
      m.on("mouseenter", "spot-dot", () => (m.getCanvas().style.cursor = "pointer"));
      m.on("mouseleave", "spot-dot", () => (m.getCanvas().style.cursor = ""));
      particles.current = new SwellParticles(m);
      setReady(true);
    });
    map.current = m;
    if (process.env.NODE_ENV !== "production") (window as unknown as { __nesurfMap?: MLMap }).__nesurfMap = m; // debugging hook
    return () => { particles.current?.destroy(); particles.current = null; m.remove(); map.current = null; setReady(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // basemap switch: swap the style and re-add our layers when it has loaded
  useEffect(() => {
    const m = map.current; if (!m || !ready) return;
    const cur = (m as unknown as { __basemap?: string }).__basemap ?? "satellite";
    if (cur === basemap) return;
    (m as unknown as { __basemap?: string }).__basemap = basemap;
    m.once("style.load", () => { addOverlayLayers(m); setReady(false); setTimeout(() => setReady(true), 0); });
    m.setStyle(basemap === "satellite" ? SATELLITE_STYLE : LIGHT_STYLE);
  }, [basemap, ready]);

  // markers
  useEffect(() => {
    const m = map.current; if (!m || !ready) return;
    const apply = () => {
      if (!m.isStyleLoaded()) { m.once("render", apply); return; }
      const src = m.getSource("spots") as GeoJSONSource | undefined; if (!src) return;
      src.setData({ type: "FeatureCollection", features: markers.map((k) => ({
        type: "Feature", geometry: { type: "Point", coordinates: [k.lon, k.lat] },
        properties: { id: k.id, hex: COLORS[k.color], color: k.color, score: k.score, selected: k.id === selectedId, label: `${k.name} · ${k.score}`, ...(k.callout ? { callout: k.callout } : {}) },
      })) });
    };
    apply();
    // hotspot rings: strength by band (green pulses hardest, grey barely)
    particles.current?.setRings(layers.rings ? markers.map((k) => ({ lon: k.lon, lat: k.lat, color: COLORS[k.color], strength: k.color === "green" ? 1 : k.color === "yellow" ? 0.55 : 0.15 })) : []);
  }, [markers, selectedId, ready, layers.rings]);

  // buoys
  useEffect(() => {
    const m = map.current; if (!m || !ready) return;
    const apply = () => {
      if (!m.isStyleLoaded()) { m.once("render", apply); return; }
      const src = m.getSource("buoys") as GeoJSONSource | undefined; if (!src) return;
      src.setData({ type: "FeatureCollection", features: buoys.map((b) => ({
        type: "Feature", geometry: { type: "Point", coordinates: [b.lon, b.lat] }, properties: { id: b.id, label: b.label, ok: b.ok } })) });
    };
    apply();
  }, [buoys, ready]);

  // per-step rasters: swell-quality ocean shading, coastal wind shading, optional wind heat
  useEffect(() => {
    const m = map.current; if (!m || !ready) return;
    const apply = () => {
      if (!m.isStyleLoaded() || !m.getLayer("overlay-anchor")) { m.once("render", apply); return; }
      const quality = ww3 ? swellQuality(ww3.step) : null;
      setRaster(m, "swell-shade", layers.swellShade && ww3 && quality ? swellShadeDataUrl(ww3.index, ww3.step, quality) : null, 0.72, "overlay-anchor");
      const windSrc = hrrr ?? ww3;
      setRaster(m, "wind-shade", layers.windShade && windSrc ? windShadeDataUrl(windSrc) : null, 0.92, "overlay-anchor");
      let heat: string | null = null;
      if (layers.windHeat && hrrr) {
        const { u10, v10 } = hrrr.step.fields; const mask = (hrrr.index as { paint_mask?: number[] }).paint_mask;
        heat = gridToDataUrl(hrrr.index, (k) => (u10[k] == null || v10[k] == null || (mask && !mask[k]) ? null : Math.hypot(u10[k]!, v10[k]!) * 1.944), windColor, 2);
      } else if (layers.windHeat && ww3) {
        const ws = ww3.step.fields.wind_speed; heat = gridToDataUrl(ww3.index, (k) => (ws[k] == null ? null : ws[k]! * 1.944), windColor, 6);
      }
      setRaster(m, "wind-heat", heat, 0.5, "overlay-anchor");
      particles.current?.setField(layers.streamlines && ww3 && quality ? { index: ww3.index, hs: ww3.step.fields.hs, dp: ww3.step.fields.dp, quality } : null);
    };
    apply();
  }, [ww3, hrrr, layers.swellShade, layers.windShade, layers.windHeat, layers.streamlines, ready]);

  // wrapper carries the positioning: maplibre-gl.css forces position:relative on the map element itself
  return <div className="absolute inset-0"><div ref={el} className="h-full w-full" /></div>;
}

"use client";
import { Map as MLMap, NavigationControl, setWorkerUrl, type GeoJSONSource, type MapLayerMouseEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import type { GridIndex, Ww3Step, HrrrStep } from "@/lib/cache";
import { BBOX, gridToDataUrl, windColor } from "@/lib/grid";
import { SwellParticles } from "./SwellParticles";

export interface MarkerDatum { id: string; name: string; lat: number; lon: number; score: number; color: "red" | "yellow" | "green"; face_ft: number }
export interface BuoyDatum { id: string; lat: number; lon: number; label: string; ok: boolean }

interface Props {
  markers: MarkerDatum[];
  buoys: BuoyDatum[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  ww3: { index: GridIndex; step: Ww3Step } | null;
  hrrr: { index: GridIndex; step: HrrrStep } | null;
  showWind: boolean;
  showSwell: boolean;
}

const COLORS = { red: "#e5484d", yellow: "#f5c400", green: "#2fbf71" };
const STYLE = "https://tiles.openfreemap.org/styles/positron"; // free, keyless, OpenMapTiles-based
// MapLibre 6 resolves its worker with new URL(..., import.meta.url), which Turbopack does not serve;
// the postinstall script copies the worker (and its shared chunk) into public/vendor/maplibre.
setWorkerUrl("/vendor/maplibre/maplibre-gl-worker.mjs");

export default function SurfMap({ markers, buoys, selectedId, onSelect, ww3, hrrr, showWind, showSwell }: Props) {
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
      container: el.current, style: STYLE, attributionControl: { compact: true },
      bounds: [[BBOX.west, BBOX.south], [BBOX.east, BBOX.north]], fitBoundsOptions: { padding: 24 },
      maxBounds: [[BBOX.west - 3, BBOX.south - 2], [BBOX.east + 3, BBOX.north + 2]],
    });
    m.addControl(new NavigationControl({ showCompass: false }), "top-right");
    m.on("load", () => {
      m.addSource("buoys", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      m.addLayer({ id: "buoy-dot", type: "circle", source: "buoys", paint: {
        "circle-radius": 5, "circle-color": ["case", ["get", "ok"], "#0f172a", "#94a3b8"], "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 } });
      m.addLayer({ id: "buoy-label", type: "symbol", source: "buoys", layout: {
        "text-field": ["get", "label"], "text-size": 10, "text-offset": [0, 1], "text-anchor": "top", "text-font": ["Noto Sans Regular"] },
        paint: { "text-color": "#0f172a", "text-halo-color": "#fff", "text-halo-width": 1 } });
      m.addSource("spots", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      m.addLayer({ id: "spot-halo", type: "circle", source: "spots", paint: {
        "circle-radius": ["case", ["boolean", ["get", "selected"], false], 16, 11],
        "circle-color": ["get", "hex"], "circle-opacity": 0.25 } });
      m.addLayer({ id: "spot-dot", type: "circle", source: "spots", paint: {
        "circle-radius": ["case", ["boolean", ["get", "selected"], false], 9, 7],
        "circle-color": ["get", "hex"], "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
      m.addLayer({ id: "spot-label", type: "symbol", source: "spots", layout: {
        "text-field": ["get", "label"], "text-size": 11, "text-offset": [0, 1.3], "text-anchor": "top",
        "text-font": ["Noto Sans Regular"], "text-allow-overlap": false },
        paint: { "text-color": "#1f2933", "text-halo-color": "#fff", "text-halo-width": 1.2 } });
      m.on("click", "spot-dot", (e: MapLayerMouseEvent) => onSelectRef.current(String(e.features?.[0]?.properties?.id ?? "")));
      m.on("mouseenter", "spot-dot", () => (m.getCanvas().style.cursor = "pointer"));
      m.on("mouseleave", "spot-dot", () => (m.getCanvas().style.cursor = ""));
      particles.current = new SwellParticles(m);
      setReady(true);
    });
    map.current = m;
    if (process.env.NODE_ENV !== "production") (window as unknown as { __nesurfMap?: MLMap }).__nesurfMap = m; // debugging hook
    return () => { particles.current?.destroy(); particles.current = null; m.remove(); map.current = null; setReady(false); };
  }, []);

  // markers
  useEffect(() => {
    const m = map.current; if (!m) return;
    const apply = () => {
      if (!m.isStyleLoaded()) { m.once("idle", apply); return; }
      const src = m.getSource("spots") as GeoJSONSource | undefined; if (!src) return;
      src.setData({ type: "FeatureCollection", features: markers.map((k) => ({
        type: "Feature", geometry: { type: "Point", coordinates: [k.lon, k.lat] },
        properties: { id: k.id, hex: COLORS[k.color], selected: k.id === selectedId, label: `${k.name} · ${k.score}` },
      })) });
    };
    if (ready) apply();
  }, [markers, selectedId, ready]);

  // buoys
  useEffect(() => {
    const m = map.current; if (!m || !ready) return;
    const apply = () => {
      if (!m.isStyleLoaded()) { m.once("idle", apply); return; }
      const src = m.getSource("buoys") as GeoJSONSource | undefined; if (!src) return;
      src.setData({ type: "FeatureCollection", features: buoys.map((b) => ({
        type: "Feature", geometry: { type: "Point", coordinates: [b.lon, b.lat] }, properties: { id: b.id, label: b.label, ok: b.ok } })) });
    };
    apply();
  }, [buoys, ready]);

  // wind heat raster (HRRR when present, else the coarse GFS wind carried in the WW3 file)
  useEffect(() => {
    const m = map.current; if (!m) return;
    const apply = () => {
      if (!m.isStyleLoaded() || !m.getLayer("spot-halo")) { m.once("idle", apply); return; }
      let url: string | null = null;
      if (showWind && hrrr) {
        const { u10, v10 } = hrrr.step.fields;
        const mask = (hrrr.index as { paint_mask?: number[] }).paint_mask;
        url = gridToDataUrl(hrrr.index, (k) => (u10[k] == null || v10[k] == null || (mask && !mask[k]) ? null : Math.hypot(u10[k]!, v10[k]!) * 1.944), windColor, 2);
      } else if (showWind && ww3) {
        const ws = ww3.step.fields.wind_speed;
        url = gridToDataUrl(ww3.index, (k) => (ws[k] == null ? null : ws[k]! * 1.944), windColor, 6);
      }
      const coords: [[number, number], [number, number], [number, number], [number, number]] =
        [[BBOX.west, BBOX.north], [BBOX.east, BBOX.north], [BBOX.east, BBOX.south], [BBOX.west, BBOX.south]];
      // Always rebuild: ImageSource.updateImage keeps the old texture when the new image has different
      // dimensions (GFS 40x31 grid vs HRRR 131x101), which left a stale raster on screen.
      if (m.getLayer("wind")) m.removeLayer("wind");
      if (m.getSource("wind")) m.removeSource("wind");
      if (!url) return;
      m.addSource("wind", { type: "image", url, coordinates: coords });
      m.addLayer({ id: "wind", type: "raster", source: "wind",
        paint: { "raster-opacity": 0.55, "raster-resampling": "linear", "raster-fade-duration": 0 } }, "spot-halo");
    };
    if (ready) apply();
  }, [ww3, hrrr, showWind, ready]);

  // swell particles
  useEffect(() => {
    if (!ready) return;
    particles.current?.setField(showSwell && ww3 ? { index: ww3.index, hs: ww3.step.fields.hs, dp: ww3.step.fields.dp } : null);
  }, [ww3, showSwell, ready]);

  // wrapper carries the positioning: maplibre-gl.css forces position:relative on the map element itself
  return <div className="absolute inset-0"><div ref={el} className="h-full w-full" /></div>;
}

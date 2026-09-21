"use client";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import OverviewScreen, { type ScreenModel } from "@/components/screen/OverviewScreen";
import type { BuoyMarker, Layers, Mode, SpotMarker } from "@/components/map/SurfMap";
import { atTime, loadHrrrStep, loadWw3Step, type HrrrStep, type Ww3Step } from "@/lib/cache";
import { byDay, dayKeyOf, forecastFor, representativePoint, type ForecastPoint } from "@/lib/forecast";
import { BAND_HEX, BAND_WORD, bandFor } from "@/lib/overlays";
import { assessWind } from "@/lib/quality";
import { SPOTS } from "@/lib/spots";
import { useForecastData } from "@/lib/useForecastData";
import { REFERENCE_MODEL } from "@/lib/referenceFixture";

const SurfMap = dynamic(() => import("@/components/map/SurfMap"), { ssr: false });
const compass = (d: number) => ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(d / 22.5) % 16];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "June", "July", "Aug", "Sept", "Oct", "Nov", "Dec"]; // "Tue, Sept 22" as in ui-reference
const NY = "America/New_York";
const parts = (iso: string) => { const p = new Intl.DateTimeFormat("en-US", { timeZone: NY, weekday: "short", month: "numeric", day: "numeric" }).formatToParts(new Date(iso)); const g = (t: string) => p.find((x) => x.type === t)?.value ?? ""; return { wd: g("weekday"), mo: Number(g("month")), day: Number(g("day")) }; };
const FEATURED = new Set(["higgins-me", "ruggles-ri", "nauset-beach-ma", "matunuck-ri", "long-sands-me", "coast-guard-beach-ma"]);
const shortName = (n: string) => n.split(" (")[0].replace(/ Beach$/i, "").toUpperCase();

function calloutFor(p: ForecastPoint) {
  const d = p.result.dominant; if (!d) return null;
  const lo = Math.max(1, Math.round(p.result.face_ft)), hi = Math.round(p.result.face_ft * 1.3);
  return `${lo}-${hi}ft @ ${d.tp.toFixed(0)}s (${compass(d.dp)})${p.cond.wind ? ` | ${compass(p.cond.wind.dir_from_deg)} Wind` : ""}`;
}

function PageInner() {
  const data = useForecastData();
  const router = useRouter();
  const refMode = useSearchParams().get("ref") === "1";   // pixel-diff hook: reference chrome content over the live map
  const [dayIdx, setDayIdx] = useState(0);
  const [mode, setMode] = useState<Mode>("forecast");
  const [layers, setLayers] = useState<Layers>({ satellite: true, zones: true, streamlines: true, rings: true, labels: true, windBand: false });
  const [layersOpen, setLayersOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [flyTo, setFlyTo] = useState<{ lon: number; lat: number; key: number } | null>(null);
  const [ww3Step, setWw3Step] = useState<Ww3Step | null>(null);
  const [hrrrStep, setHrrrStep] = useState<HrrrStep | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [todayKey] = useState(() => dayKeyOf(Date.now()));
  const flyKey = useRef(0);

  const forecasts = useMemo(() => SPOTS.map((spot) => ({ spot, points: forecastFor(spot, data) })), [data]);
  const days = useMemo(() => byDay(forecasts[0]?.points ?? []).slice(0, 7).map((d) => { const x = parts(d.best.valid_time); return { key: d.day, name: x.wd, label: `${x.wd}, ${MONTHS[x.mo - 1]} ${x.day}` }; }), [forecasts]);
  const day = days[dayIdx]?.key;

  const daily = useMemo(() => forecasts.map(({ spot, points }) => ({ spot, best: byDay(points).find((x) => x.day === day)?.best ?? null, rep: day ? representativePoint(points, day, todayKey) : null })).filter((x) => x.best), [forecasts, day, todayKey]);
  const ranked = useMemo(() => [...daily].sort((a, b) => b.best!.result.score - a.best!.result.score), [daily]);
  const top2 = new Set(ranked.slice(0, 2).map((r) => r.spot.id));

  const repTime = daily[0]?.rep?.valid_time ?? null;
  useEffect(() => {
    if (!data.ww3 || !repTime) return;
    let live = true;
    const w = atTime(data.ww3.index.steps, repTime), h = data.hrrr ? atTime(data.hrrr.index.steps, repTime, 45) : null;
    Promise.all([w ? loadWw3Step(w.file) : null, h ? loadHrrrStep(h.file) : null]).then(([ws, hs]) => { if (!live) return; setWw3Step(ws); setHrrrStep(hs); setLoadedFor(repTime); });
    return () => { live = false; };
  }, [data.ww3, data.hrrr, repTime]);
  const stepLoading = !!repTime && loadedFor !== repTime;
  const wind = data.hrrr && hrrrStep ? { index: data.hrrr.index, step: hrrrStep } : data.ww3 && ww3Step ? { index: data.ww3.index, step: ww3Step } : null;

  const spots: SpotMarker[] = daily.map(({ spot, best }) => {
    const b = best!; const band = bandFor(b.result.score); const body = calloutFor(b);
    return { id: spot.id, name: spot.name, state: spot.state, lat: spot.location.lat, lon: spot.location.lon, band, score: b.result.score, featured: FEATURED.has(spot.id),
      callout: body && (top2.has(spot.id) || selected === spot.id) ? { name: shortName(spot.name), body } : undefined, ringRadius: 9 + Math.min(30, b.result.face_m * 8) };
  });
  const buoys: BuoyMarker[] = (data.ww3?.spots.buoys ?? []).map((b) => { const o = data.ndbc?.buoys[b.id]; const ok = !!o && o.status === "ok" && o.wvht_m != null;
    return { id: b.id, lat: b.position.lat, lon: b.position.lon, ok, label: ok ? `${b.id} · ${(o!.wvht_m! * 3.28).toFixed(1)}ft @ ${o!.dpd_s ?? "–"}s` : `${b.id} · offline` }; });

  const hot = ranked[0] ?? null;
  const hotBand = hot ? bandFor(hot.best!.result.score) : "poor";
  const hotWind = hot?.best?.cond.wind ? assessWind(hot.spot, hot.best.cond.wind) : null;
  const windWord = !hotWind ? "" : hotWind.label === "offshore" || hotWind.label === "glassy" ? "Optimal" : hotWind.label === "onshore" || hotWind.label === "cross-on" ? "Onshore" : "Cross-shore";
  const go = (id: string) => { const s = SPOTS.find((x) => x.id === id); if (!s) return; setSelected(id); setQuery(""); setFlyTo({ lon: s.location.lon, lat: s.location.lat, key: ++flyKey.current }); };
  const matches = query.trim() ? SPOTS.filter((s) => s.name.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 6) : [];

  const model: ScreenModel = {
    dateLabel: days[dayIdx]?.label ?? "",
    days: (days.length ? days : Array.from({ length: 7 }, (_, i) => ({ key: String(i), name: "", label: "" }))).map((d, i) => ({ name: d.name, filled: i <= dayIdx, active: i === dayIdx })),
    selectedIndex: dayIdx,
    layerCard: mode === "refraction" ? { title: "Refraction Map", body: "CRM bathymetry, shallow → deep" } : mode === "buoys" ? { title: "Live Buoy Feed", body: "NDBC observations, updated live" } : { title: "Swell Interaction", body: "Deep-water refraction, color-coded" },
    callouts: [],   // callouts are anchored to pins by the map layer (build-spec §05 layer 5)
    hotspot: hot && hot.best
      ? { rating: BAND_WORD[hotBand].charAt(0) + BAND_WORD[hotBand].slice(1).toLowerCase(), ratingColor: BAND_HEX[hotBand], pinColor: BAND_HEX[hotBand],
          line1: `${shortName(hot.spot.name).charAt(0) + shortName(hot.spot.name).slice(1).toLowerCase()}: ${Math.max(1, Math.round(hot.best.result.face_ft))}-${Math.round(hot.best.result.face_ft * 1.3)}ft${hot.best.result.dominant ? ` @ ${hot.best.result.dominant.tp.toFixed(0)}s` : ""}`,
          line2: hot.best.cond.wind ? `${compass(hot.best.cond.wind.dir_from_deg)} wind · ${windWord}` : "" }
      : { rating: "—", ratingColor: "#9c9ea1", pinColor: "#9c9ea1", line1: data.error ?? "Loading forecast", line2: "" },
    mode, activeMode: null,   // ui-reference.html shows no highlighted chip; build-spec §04 says accent fill — flagged, awaiting decision
    searchValue: query,
  };

  return (
    <main style={{ position: "fixed", inset: 0 }}>
      <OverviewScreen m={refMode ? REFERENCE_MODEL : model}
        h={{ onPrev: () => setDayIdx((i) => Math.max(0, i - 1)), onNext: () => setDayIdx((i) => Math.min(days.length - 1, i + 1)), onPickDay: setDayIdx,
             onMode: setMode, onSearch: setQuery, onLayers: () => setLayersOpen((o) => !o), onMenu: () => router.push("/about"), onHotspot: () => hot && go(hot.spot.id) }}
        map={<SurfMap spots={spots} buoys={buoys} selectedId={selected} onSelect={setSelected} mode={mode} layers={layers} wind={wind} flyTo={flyTo} />}>
        {/* progress line under the toolbar while data or a day's grids load (build-spec §06 Empty / loading) */}
        {(data.loading || stepLoading) && <div style={{ position: "absolute", left: 0, top: 128, height: 2, width: "100%", background: "#4798b7", zIndex: 7, transformOrigin: "left", animation: "nesurf-progress 1.2s ease-in-out infinite" }} />}
        {/* search type-ahead (§06 Search) */}
        {matches.length > 0 && (
          <ul style={{ position: "absolute", right: 8, top: 120, width: 220, borderRadius: 8, background: "#0e212a", boxShadow: "0px 4px 14px rgba(0,0,0,0.35)", listStyle: "none", margin: 0, padding: 4, zIndex: 8 }}>
            {matches.map((s) => <li key={s.id}><button onClick={() => go(s.id)} style={{ display: "block", width: "100%", minHeight: 44, textAlign: "left", background: "transparent", border: 0, color: "#e8eef2", fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", padding: "0 8px", cursor: "pointer" }}>{s.name} <span style={{ color: "#9fb1bc" }}>{s.state}</span></button></li>)}
          </ul>)}
        {/* layers bottom sheet (§04 Layers button) */}
        {layersOpen && (
          <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, background: "#0e2029", borderRadius: "12px 12px 0 0", boxShadow: "0px -4px 14px rgba(0,0,0,0.35)", padding: "12px 16px 16px", zIndex: 9 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: "#e8eef2" }}>Layers</span>
              <button onClick={() => setLayersOpen(false)} style={{ minHeight: 44, minWidth: 44, background: "transparent", border: 0, color: "#b8c7d1", fontSize: 10, fontWeight: 600, letterSpacing: "0.03em", textTransform: "uppercase", cursor: "pointer" }}>Done</button>
            </div>
            {([["satellite", "Satellite"], ["zones", "Swell zones"], ["streamlines", "Wind streamlines"], ["rings", "Rings"], ["labels", "Labels"], ["windBand", "Coastal wind band"]] as Array<[keyof Layers, string]>).map(([k, label]) => (
              <label key={k} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", minHeight: 44, borderTop: "1px solid rgba(255,255,255,0.10)", fontSize: 11, fontWeight: 600, letterSpacing: "0.03em", textTransform: "uppercase", color: "#e8eef2" }}>
                <span>{label}</span><input type="checkbox" checked={layers[k]} onChange={() => setLayers((l) => ({ ...l, [k]: !l[k] }))} style={{ width: 20, height: 20, accentColor: "#4798b7" }} />
              </label>))}
          </div>)}
      </OverviewScreen>
    </main>
  );
}

import { Suspense } from "react";
export default function Page() { return <Suspense fallback={null}><PageInner /></Suspense>; }

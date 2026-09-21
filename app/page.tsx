"use client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import DayTimeline, { type Day } from "@/components/timeline/DayTimeline";
import type { BuoyMarker, Layers, Mode, SpotMarker } from "@/components/map/SurfMap";
import { loadHrrrStep, loadWw3Step, type HrrrStep, type Ww3Step, atTime } from "@/lib/cache";
import { byDay, dayKeyOf, forecastFor, representativePoint, type ForecastPoint } from "@/lib/forecast";
import { BAND_HEX, BAND_WORD, TOKENS, bandFor } from "@/lib/overlays";
import { assessWind } from "@/lib/quality";
import { SPOTS } from "@/lib/spots";
import { useForecastData } from "@/lib/useForecastData";

const SurfMap = dynamic(() => import("@/components/map/SurfMap"), { ssr: false });
const compass = (d: number) => ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(d / 22.5) % 16];
const fmtDay = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/New_York" });
const fmtShort = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "America/New_York" });
const FEATURED = new Set(["higgins-me", "ruggles-ri", "nauset-beach-ma", "matunuck-ri", "long-sands-me", "coast-guard-beach-ma"]);
const MODES: Array<[Mode, string, string]> = [["forecast", "Forecast slider", "M3 6h10M3 12h10M3 18h10M17 6v12"], ["refraction", "Refraction map", "M3 4h18v16H3zM3 10h18M9 4v16"], ["buoys", "Live buoy feed", "M12 3v18M6 21h12M5 9l7-6 7 6"]];

function calloutFor(p: ForecastPoint) {
  const d = p.result.dominant; if (!d) return null;
  const lo = Math.max(1, Math.round(p.result.face_ft)), hi = Math.round(p.result.face_ft * 1.3);
  return `${lo}-${hi}ft @ ${d.tp.toFixed(0)}s (${compass(d.dp)})${p.cond.wind ? ` | ${compass(p.cond.wind.dir_from_deg)} Wind` : ""}`;
}

export default function Page() {
  const data = useForecastData();
  const [dayIdx, setDayIdx] = useState(0);
  const [mode, setMode] = useState<Mode>("forecast");
  const [layers, setLayers] = useState<Layers>({ satellite: true, zones: true, streamlines: true, rings: true, labels: true, windBand: true });
  const [layersOpen, setLayersOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [flyTo, setFlyTo] = useState<{ lon: number; lat: number; key: number } | null>(null);
  const [ww3Step, setWw3Step] = useState<Ww3Step | null>(null);
  const [hrrrStep, setHrrrStep] = useState<HrrrStep | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const flyKey = useRef(0);

  const forecasts = useMemo(() => SPOTS.map((spot) => ({ spot, points: forecastFor(spot, data) })), [data]);
  const days: Day[] = useMemo(() => {
    const pts = forecasts[0]?.points ?? [];
    return byDay(pts).slice(0, 7).map((d) => ({ key: d.day, label: fmtDay.format(new Date(d.best.valid_time)).toUpperCase(), short: fmtShort.format(new Date(d.best.valid_time)) }));
  }, [forecasts]);
  const day = days[dayIdx]?.key;
  const [todayKey] = useState(() => dayKeyOf(Date.now()));

  // per-spot best point of the selected day (what the zones, callouts and hotspot use)
  const daily = useMemo(() => forecasts.map(({ spot, points }) => {
    const d = byDay(points).find((x) => x.day === day);
    return { spot, best: d?.best ?? null, rep: day ? representativePoint(points, day, todayKey) : null };
  }).filter((x) => x.best), [forecasts, day, todayKey]);
  const ranked = useMemo(() => [...daily].sort((a, b) => b.best!.result.score - a.best!.result.score), [daily]);
  const top2 = new Set(ranked.slice(0, 2).map((r) => r.spot.id));

  // gridded layers for the day's representative hour
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
      callout: body && (top2.has(spot.id) || selected === spot.id) ? { name: spot.name.split(" (")[0].toUpperCase(), body } : undefined,
      ringRadius: 10 + Math.min(30, b.result.face_m * 8) };
  });
  const buoys: BuoyMarker[] = (data.ww3?.spots.buoys ?? []).map((b) => { const o = data.ndbc?.buoys[b.id]; const ok = !!o && o.status === "ok" && o.wvht_m != null;
    return { id: b.id, lat: b.position.lat, lon: b.position.lon, ok, label: ok ? `${b.id} · ${(o!.wvht_m! * 3.28).toFixed(1)}ft @ ${o!.dpd_s ?? "–"}s` : `${b.id} · offline` }; });

  const hot = ranked[0] ?? null;
  const hotWind = hot?.best?.cond.wind ? assessWind(hot.spot, hot.best.cond.wind) : null;
  const windWord = !hotWind ? "" : hotWind.label === "offshore" || hotWind.label === "glassy" ? "Optimal" : hotWind.label === "onshore" || hotWind.label === "cross-on" ? "Onshore" : "Cross-shore";
  const matches = query.trim() ? SPOTS.filter((s) => s.name.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 6) : [];
  const go = (id: string) => { const s = SPOTS.find((x) => x.id === id); if (!s) return; setSelected(id); setQuery(""); setFlyTo({ lon: s.location.lon, lat: s.location.lat, key: ++flyKey.current }); };
  const toggle = (k: keyof Layers) => setLayers((l) => ({ ...l, [k]: !l[k] }));

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-chrome text-t1">
      <SurfMap spots={spots} buoys={buoys} selectedId={selected} onSelect={setSelected} mode={mode} layers={layers} wind={wind} flyTo={flyTo} />

      {/* chrome: header + toolbar (fixed, map scrolls under) */}
      <div className="absolute inset-x-0 top-0 z-20" style={{ paddingTop: "env(safe-area-inset-top)" }}>
        <header className="flex h-11 items-center gap-3 bg-chrome px-4">
          <span className="grid h-7 w-7 place-items-center rounded-[6px] bg-accent"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#0E2029" strokeWidth="2.5"><path d="M3 17l6-6 4 4 8-8M15 7h6v6" /></svg></span>
          <h1 className="t-title text-t1">NE Surf Overview <span className="font-medium text-t3">(free map)</span></h1>
          <Link href="/about" aria-label="Menu" className="ml-auto grid h-11 w-11 place-items-center text-t1"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 7h16M4 12h16M4 17h16" /></svg></Link>
        </header>
        <div className="flex h-11 items-center gap-[6px] bg-toolbar px-2">
          {MODES.map(([m, label, icon]) => (
            <button key={m} onClick={() => setMode(m)} aria-label={label} aria-pressed={mode === m} className="t-chip flex h-[30px] items-center gap-1.5 rounded-[6px] border px-[9px]"
              style={mode === m ? { background: "var(--accent)", color: "#0E2029", borderColor: "var(--accent)" } : { background: "rgba(255,255,255,.10)", borderColor: "rgba(255,255,255,.16)", color: "#E8EEF2" }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d={icon} /></svg><span className="hidden sm:inline">{label}</span>
            </button>))}
          <div className="relative ml-auto min-w-[88px] flex-1 sm:max-w-[220px]">
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label="Search breaks"
              className="h-[30px] w-full rounded-[6px] bg-input pl-7 pr-2 text-[11px] font-medium text-t1 placeholder:text-t3 focus:outline-none" />
            <svg className="pointer-events-none absolute left-2 top-2" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#9FB1BC" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
            {matches.length > 0 && (
              <ul className="panel absolute left-0 right-0 top-9 z-30 overflow-hidden">
                {matches.map((s) => <li key={s.id}><button onClick={() => go(s.id)} className="block w-full px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[.04em] hover:bg-white/10">{s.name} <span className="text-t3">{s.state}</span></button></li>)}
              </ul>)}
          </div>
        </div>
        {(data.loading || stepLoading) && <div className="progress-line" />}
        <div className="mx-[6px] mt-2">{days.length > 0 && <DayTimeline days={days} index={dayIdx} onChange={setDayIdx} />}</div>
        <div className="relative mx-2 mt-2 flex items-start justify-between">
          <div className="panel fade-in max-w-[168px] px-[10px] py-2">
            <div className="t-panel text-t1">{mode === "refraction" ? "Refraction map" : mode === "buoys" ? "Live buoy feed" : "Swell interaction"}</div>
            <div className="t-body">{mode === "refraction" ? "CRM bathymetry, shallow → deep" : mode === "buoys" ? "NDBC observations, live" : "Deep-water refraction, color-coded"}</div>
          </div>
          <button onClick={() => setLayersOpen((o) => !o)} aria-label="Layers" className="panel grid h-10 w-10 place-items-center" style={{ border: "1px solid rgba(255,255,255,.14)" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#E8EEF2" strokeWidth="2"><path d="M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5M3 17l9 5 9-5" /></svg>
          </button>
        </div>
        {data.error && <div className="mx-2 mt-2 rounded-lg bg-red-500/20 p-2 text-[11px] text-red-100">{data.error}</div>}
      </div>

      {/* bottom: legends left, hotspot right */}
      <div className="pointer-events-none absolute inset-x-3 bottom-3 z-20 flex items-end justify-between gap-2" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        <div className="flex w-[156px] flex-col gap-2">
          <div className="panel px-[10px] py-2">
            <div className="t-panel text-t1" style={{ fontSize: 10 }}>Swell interaction</div>
            <div className="mt-1.5 h-2 rounded-[4px]" style={{ background: "var(--grad-swell)" }} />
            <div className="mt-1 flex justify-between text-[10px] font-medium text-white"><span>Low</span><span>Clean</span><span>High</span></div>
          </div>
          <div className="panel px-[10px] py-2">
            <div className="t-panel text-t1" style={{ fontSize: 10 }}>Wind overlay</div>
            <div className="mt-1.5 h-2 rounded-[4px]" style={{ background: "var(--grad-wind)" }} />
            <div className="mt-1 flex justify-between text-[10px] font-medium text-white"><span>Offshore</span><span>Cross-shore</span></div>
          </div>
        </div>
        {hot && hot.best && (
          <button onClick={() => go(hot.spot.id)} className="panel pointer-events-auto w-[152px] px-[10px] py-2 text-left">
            <div className="t-panel text-t1" style={{ fontSize: 10 }}>Surf quality hotspot</div>
            <div className="t-micro mt-0.5" style={{ color: TOKENS.good }}>AI-ranked breaks</div>
            <div className="mt-1.5 flex items-start gap-1.5">
              <svg width="14" height="18" viewBox="0 0 16 20"><path d="M8 19.3C8 19.3 15 11.8 15 7.5A7 7 0 0 0 1 7.5C1 11.8 8 19.3 8 19.3Z" fill={BAND_HEX[bandFor(hot.best.result.score)]} /><circle cx="8" cy="7.5" r="2.4" fill="#0E2029" /></svg>
              <div>
                <div className="text-[11px] font-800 uppercase tracking-[.04em]" style={{ color: BAND_HEX[bandFor(hot.best.result.score)], fontWeight: 800 }}>{BAND_WORD[bandFor(hot.best.result.score)]}</div>
                <div className="text-[10px] font-medium text-t1">{hot.spot.name.split(" (")[0]}: {Math.max(1, Math.round(hot.best.result.face_ft))}-{Math.round(hot.best.result.face_ft * 1.3)}ft{hot.best.result.dominant ? ` @ ${hot.best.result.dominant.tp.toFixed(0)}s` : ""}</div>
                {hot.best.cond.wind && <div className="text-[10px] font-medium text-t2">{compass(hot.best.cond.wind.dir_from_deg)} wind · {windWord}</div>}
              </div>
            </div>
            <div className="mt-2 flex gap-1">{(["good", "moderate", "poor"] as const).map((b) => <span key={b} className="h-2 flex-1 rounded-[4px]" style={{ background: BAND_HEX[b] }} />)}</div>
            <div className="t-micro mt-1 flex justify-between"><span style={{ color: TOKENS.good }}>Green</span><span style={{ color: TOKENS.moderate }}>Moderate</span><span style={{ color: TOKENS.poor }}>Poor</span></div>
          </button>)}
      </div>

      {/* layers bottom sheet */}
      {layersOpen && (
        <div className="absolute inset-x-0 bottom-0 z-30 rounded-t-2xl bg-chrome p-4 shadow-[0_-4px_14px_rgba(0,0,0,.35)]" style={{ paddingBottom: "calc(16px + env(safe-area-inset-bottom))" }}>
          <div className="mb-2 flex items-center justify-between"><span className="t-panel">Layers</span><button onClick={() => setLayersOpen(false)} className="t-chip h-11 px-2 text-t2">Done</button></div>
          {([["satellite", "Satellite"], ["zones", "Swell zones"], ["streamlines", "Wind streamlines"], ["windBand", "Coastal wind band"], ["rings", "Rings"], ["labels", "Labels"]] as Array<[keyof Layers, string]>).map(([k, label]) => (
            <label key={k} className="flex h-11 items-center justify-between border-t border-white/10 text-[12px] font-semibold uppercase tracking-[.04em]">
              <span>{label}</span>
              <input type="checkbox" checked={layers[k]} onChange={() => toggle(k)} className="h-5 w-5 accent-[#4798B7]" />
            </label>))}
        </div>)}
      {selected && (
        <Link href={`/spots/${selected}`} className="panel t-chip absolute right-3 z-20 flex h-8 items-center px-3 text-t1" style={{ bottom: "calc(150px + env(safe-area-inset-bottom))" }}>7-day forecast →</Link>)}
    </main>
  );
}

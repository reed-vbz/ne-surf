"use client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import Timeline from "@/components/timeline/Timeline";
import SpotPanel from "@/components/spots/SpotPanel";
import type { BuoyDatum, Layers, MarkerDatum } from "@/components/map/SurfMap";
import { atTime, loadHrrrStep, loadWw3Step, type HrrrStep, type Ww3Step } from "@/lib/cache";
import { bestWindow, forecastFor } from "@/lib/forecast";
import { BAND_LABEL } from "@/lib/quality";
import { SPOTS } from "@/lib/spots";
import { hoursAgo, useForecastData } from "@/lib/useForecastData";

const SurfMap = dynamic(() => import("@/components/map/SurfMap"), { ssr: false });
const DOT = { grey: "bg-slate-400", yellow: "bg-[#ffd23f]", green: "bg-[#3ddc84]" };
const compass = (d: number) => ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(d / 22.5) % 16];
const fmtShort = new Intl.DateTimeFormat("en-US", { weekday: "short", hour: "numeric", timeZone: "America/New_York" });

export default function Page() {
  const data = useForecastData();
  const [stepIdx, setStepIdx] = useState(0);
  const [ww3Step, setWw3Step] = useState<Ww3Step | null>(null);
  const [hrrrStep, setHrrrStep] = useState<HrrrStep | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [layers, setLayers] = useState<Layers>({ swellShade: true, streamlines: true, windShade: true, windHeat: false, rings: true });
  const [basemap, setBasemap] = useState<"satellite" | "light">("satellite");
  const toggle = (k: keyof Layers) => setLayers((l) => ({ ...l, [k]: !l[k] }));
  const [listOpen, setListOpen] = useState(false);

  const { ww3, hrrr } = data;
  const step = ww3?.index.steps[stepIdx] ?? null;

  // per-step gridded layers
  useEffect(() => {
    if (!ww3 || !step) return;
    let live = true;
    loadWw3Step(step.file).then((s) => live && setWw3Step(s));
    const h = hrrr ? atTime(hrrr.index.steps, step.valid_time, 45) : null;
    (h ? loadHrrrStep(h.file) : Promise.resolve(null)).then((s) => live && setHrrrStep(s));
    return () => { live = false; };
  }, [ww3, hrrr, step]);

  // full-horizon forecast for every spot (cheap: 21 spots × 57 steps)
  const forecasts = useMemo(() => SPOTS.map((spot) => ({ spot, points: forecastFor(spot, data) })), [data]);
  const results = useMemo(() => forecasts.map(({ spot, points }) => ({ spot, now: points[stepIdx] ?? null, best: bestWindow(points) })), [forecasts, stepIdx]);

  const top = [...results].filter((r) => r.now).sort((a, b) => b.now!.result.score - a.now!.result.score).slice(0, 2).filter((r) => r.now!.result.score >= 30).map((r) => r.spot.id);
  const markers: MarkerDatum[] = results.filter((r) => r.now).map(({ spot, now }) => {
    const d = now!.result.dominant, w = now!.cond.wind;
    const callout = top.includes(spot.id) && d
      ? `${spot.name.toUpperCase()}: ${now!.result.face_ft.toFixed(0)}–${(now!.result.face_ft * 1.25).toFixed(0)} ft @ ${d.tp.toFixed(0)} s (${compass(d.dp)})${w ? ` | ${compass(w.dir_from_deg)} wind` : ""}`
      : undefined;
    return { id: spot.id, name: spot.name, lat: spot.location.lat, lon: spot.location.lon, score: now!.result.score, color: now!.result.color, face_ft: now!.result.face_ft, callout };
  });
  const buoys: BuoyDatum[] = (ww3?.spots.buoys ?? []).map((b) => {
    const o = data.ndbc?.buoys[b.id];
    const ok = !!o && o.status === "ok" && o.wvht_m != null;
    return { id: b.id, lat: b.position.lat, lon: b.position.lon, ok, label: ok ? `${b.id} ${(o!.wvht_m! * 3.28).toFixed(1)} ft ${o!.dpd_s ?? "–"} s` : `${b.id} offline` };
  });
  const sel = results.find((r) => r.spot.id === selected && r.now) ?? null;
  const ranked = [...results].filter((r) => r.now).sort((a, b) => b.now!.result.score - a.now!.result.score);
  const age = hoursAgo(ww3?.index.generated_at);

  const list = (
    <div className="flex flex-col">
      {ranked.map(({ spot, now, best }) => (
        <button key={spot.id} onClick={() => { setSelected(spot.id); setListOpen(false); }}
          className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-white/10 ${selected === spot.id ? "bg-white/10" : ""}`}>
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${DOT[now!.result.color]}`} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-slate-100">{spot.name}</span>
            {best && best.result.score > now!.result.score + 10 && (
              <span className="block truncate text-[10px] text-slate-500">best {fmtShort.format(new Date(best.valid_time))} · {best.result.score}</span>)}
          </span>
          <span className="text-slate-400">{BAND_LABEL[now!.result.band]}</span>
          <span className="w-6 text-right font-semibold tabular-nums text-white">{now!.result.score}</span>
        </button>))}
    </div>
  );

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-[#071120]">
      <SurfMap markers={markers} buoys={buoys} selectedId={selected} onSelect={setSelected}
        ww3={ww3 && ww3Step ? { index: ww3.index, step: ww3Step } : null}
        hrrr={hrrr && hrrrStep ? { index: hrrr.index, step: hrrrStep } : null}
        layers={layers} basemap={basemap} />

      <header className="absolute inset-x-0 top-0 z-10 border-b border-white/10 bg-[#0b1526]/92 text-slate-100 shadow-xl backdrop-blur">
        <div className="flex items-center gap-3 px-4 py-2">
          <span className="grid h-6 w-6 place-items-center rounded bg-cyan-400 text-[11px] font-black text-[#0b1526]">↗</span>
          <h1 className="text-sm font-bold uppercase tracking-[0.14em]">NE Surf Overview <span className="font-normal text-slate-400">(free map)</span></h1>
          <span className="hidden text-[11px] text-slate-400 md:inline">
            {ww3 ? `GFS-Wave ${ww3.index.cycle.slice(5, 13)}Z` : data.loading ? "loading…" : "no data"}{hrrr ? ` · HRRR ${hrrr.index.cycle.slice(5, 13)}Z` : ""}
            {age !== null && <span className={age > 12 ? "text-amber-400" : ""}> · fetched {age < 1 ? "<1" : age.toFixed(0)} h ago{age > 12 ? " (stale)" : ""}</span>}
          </span>
          <Link href="/about" className="ml-auto text-[11px] uppercase tracking-wider text-slate-400 hover:text-white">how it works</Link>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-white/5 px-4 py-1.5 text-[11px]">
          {([["swellShade", "Swell field"], ["streamlines", "Streamlines"], ["windShade", "Wind overlay"], ["rings", "Hotspots"]] as Array<[keyof Layers, string]>).map(([k, label]) => (
            <button key={k} onClick={() => toggle(k)}
              className={`rounded-full border px-2.5 py-0.5 uppercase tracking-wider ${layers[k] ? "border-cyan-400/60 bg-cyan-400/15 text-cyan-200" : "border-white/15 text-slate-400"}`}>{label}</button>))}
          <button onClick={() => setBasemap((b) => (b === "satellite" ? "light" : "satellite"))} className="rounded-full border border-white/15 px-2.5 py-0.5 uppercase tracking-wider text-slate-300">{basemap === "satellite" ? "Light map" : "Satellite"}</button>
          <button onClick={() => setListOpen((o) => !o)} className="ml-auto rounded-full bg-cyan-400 px-3 py-0.5 font-semibold uppercase tracking-wider text-[#0b1526] md:hidden">Spots</button>
        </div>
        {data.error && <div className="mx-4 mb-2 rounded-lg bg-red-500/20 p-2 text-xs text-red-200">{data.error}</div>}
      </header>

      {/* ranked list: side card on desktop, sheet on mobile */}
      <div className="absolute right-4 top-24 z-10 hidden max-h-[42vh] w-64 overflow-y-auto rounded-xl border border-white/10 bg-[#0b1526]/90 p-2 text-slate-100 shadow-2xl backdrop-blur md:block">
        <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">Ranked now</div>{list}</div>
      {listOpen && (
        <div className="absolute inset-x-2 bottom-28 top-28 z-20 overflow-y-auto rounded-xl border border-white/10 bg-[#0b1526]/95 p-2 text-slate-100 shadow-2xl backdrop-blur md:hidden">
          <div className="flex items-center justify-between px-2 pb-1 text-[10px] uppercase tracking-[0.18em] text-slate-400"><span>Ranked now</span><button onClick={() => setListOpen(false)}>close</button></div>
          {list}
        </div>
      )}

      {sel && sel.now && (
        <div className="absolute inset-x-2 bottom-28 top-auto z-10 max-h-[55vh] md:inset-x-auto md:bottom-[16.5rem] md:left-4 md:top-24 md:max-h-none md:w-80">
          <SpotPanel spot={sel.spot} result={sel.now.result} cond={sel.now.cond} onClose={() => setSelected(null)}
            buoys={sel.spot.buoys.map((id) => [id, data.ndbc?.buoys[id]])} bathy={data.bathy.spots[sel.spot.id] ?? null} />
        </div>
      )}

      <div className="pointer-events-none absolute bottom-24 left-4 z-10 hidden w-60 flex-col gap-2 md:flex">
        <div className="rounded-lg border border-white/10 bg-[#0b1526]/90 px-3 py-2 text-[10px] text-slate-300 shadow-xl backdrop-blur">
          <div className="font-semibold uppercase tracking-[0.16em] text-white">Swell interaction</div>
          <div className="text-slate-500">deep-water swell field · streamlines follow the swell</div>
          <div className="mt-1.5 h-2 rounded" style={{ background: "linear-gradient(90deg,#071a3a,#0c3d7a,#1178b8,#2fc4e8,#b6f3ff)" }} />
          <div className="flex justify-between uppercase tracking-wider"><span>low</span><span>clean</span><span>high</span></div>
        </div>
        <div className="rounded-lg border border-white/10 bg-[#0b1526]/90 px-3 py-2 text-[10px] text-slate-300 shadow-xl backdrop-blur">
          <div className="font-semibold uppercase tracking-[0.16em] text-white">Wind overlay</div>
          <div className="text-slate-500">HRRR wind on the coast band</div>
          <div className="mt-1.5 h-2 rounded" style={{ background: "linear-gradient(90deg,#3ddc84,#b8c2cc,#ff9a4d)" }} />
          <div className="flex justify-between uppercase tracking-wider"><span>offshore</span><span>cross-shore</span><span>onshore</span></div>
        </div>
      </div>
      {ranked[0] && (
        <div className="pointer-events-none absolute bottom-24 right-3 z-10 hidden w-60 rounded-lg border border-white/10 bg-[#0b1526]/90 px-3 py-2 text-[11px] text-slate-300 shadow-xl backdrop-blur md:block">
          <div className="font-semibold uppercase tracking-[0.16em] text-white">Surf quality hotspot</div>
          <div className="text-[10px] text-slate-500">best scoring break at this hour</div>
          <div className="mt-1 flex items-center gap-2">
            <span className={`h-2.5 w-2.5 rounded-full ${DOT[ranked[0].now!.result.color]}`} />
            <span className="font-semibold text-white">{BAND_LABEL[ranked[0].now!.result.band]}</span>
          </div>
          <div>{ranked[0].spot.name}: ~{ranked[0].now!.result.face_ft.toFixed(0)}–{(ranked[0].now!.result.face_ft * 1.25).toFixed(0)} ft
            {ranked[0].now!.result.dominant ? ` @ ${ranked[0].now!.result.dominant.tp.toFixed(0)} s` : ""}</div>
          <div className="mt-1 flex gap-2"><span className="h-1.5 flex-1 rounded bg-emerald-500" /><span className="h-1.5 flex-1 rounded bg-yellow-400" /><span className="h-1.5 flex-1 rounded bg-slate-400" /></div>
          <div className="flex justify-between text-[9px] uppercase"><span>green</span><span>moderate</span><span>poor</span></div>
        </div>
      )}

      {ww3 && (
        <div className="absolute bottom-3 left-3 right-3 z-10 md:bottom-4 md:left-1/2 md:w-[640px] md:-translate-x-1/2">
          <Timeline steps={ww3.index.steps} index={stepIdx} onChange={setStepIdx} playing={playing} onTogglePlay={() => setPlaying((p) => !p)} />
        </div>
      )}
    </main>
  );
}

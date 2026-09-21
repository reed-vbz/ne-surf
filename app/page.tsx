"use client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import Timeline from "@/components/timeline/Timeline";
import SpotPanel from "@/components/spots/SpotPanel";
import type { BuoyDatum, MarkerDatum } from "@/components/map/SurfMap";
import { atTime, loadHrrrStep, loadWw3Step, type HrrrStep, type Ww3Step } from "@/lib/cache";
import { bestWindow, forecastFor } from "@/lib/forecast";
import { BAND_LABEL } from "@/lib/quality";
import { SPOTS } from "@/lib/spots";
import { hoursAgo, useForecastData } from "@/lib/useForecastData";

const SurfMap = dynamic(() => import("@/components/map/SurfMap"), { ssr: false });
const DOT = { red: "bg-red-500", yellow: "bg-yellow-400", green: "bg-emerald-500" };
const fmtShort = new Intl.DateTimeFormat("en-US", { weekday: "short", hour: "numeric", timeZone: "America/New_York" });

export default function Page() {
  const data = useForecastData();
  const [stepIdx, setStepIdx] = useState(0);
  const [ww3Step, setWw3Step] = useState<Ww3Step | null>(null);
  const [hrrrStep, setHrrrStep] = useState<HrrrStep | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [showWind, setShowWind] = useState(true);
  const [showSwell, setShowSwell] = useState(true);
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

  const markers: MarkerDatum[] = results.filter((r) => r.now).map(({ spot, now }) => ({
    id: spot.id, name: spot.name, lat: spot.location.lat, lon: spot.location.lon, score: now!.result.score, color: now!.result.color, face_ft: now!.result.face_ft,
  }));
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
          className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-slate-100 ${selected === spot.id ? "bg-slate-100" : ""}`}>
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${DOT[now!.result.color]}`} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-slate-800">{spot.name}</span>
            {best && best.result.score > now!.result.score + 10 && (
              <span className="block truncate text-[10px] text-slate-400">best {fmtShort.format(new Date(best.valid_time))} · {best.result.score}</span>)}
          </span>
          <span className="text-slate-500">{BAND_LABEL[now!.result.band]}</span>
          <span className="w-6 text-right font-semibold tabular-nums text-slate-900">{now!.result.score}</span>
        </button>))}
    </div>
  );

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-slate-100">
      <SurfMap markers={markers} buoys={buoys} selectedId={selected} onSelect={setSelected}
        ww3={ww3 && ww3Step ? { index: ww3.index, step: ww3Step } : null}
        hrrr={hrrr && hrrrStep ? { index: hrrr.index, step: hrrrStep } : null}
        showWind={showWind} showSwell={showSwell} />

      <header className="pointer-events-none absolute left-3 top-3 z-10 flex max-w-[calc(100vw-1.5rem)] flex-col gap-2 md:left-4 md:top-4">
        <div className="pointer-events-auto rounded-xl bg-white/90 px-3 py-2 shadow-lg backdrop-blur md:px-4">
          <div className="flex items-baseline gap-3">
            <h1 className="text-base font-bold text-slate-900">NE Surf</h1>
            <Link href="/about" className="text-[11px] text-slate-500 hover:underline">how it works</Link>
          </div>
          <p className="text-[11px] text-slate-500">
            {ww3 ? `GFS-Wave ${ww3.index.cycle.slice(0, 13)}Z` : data.loading ? "loading…" : "no data"}{hrrr ? ` · HRRR ${hrrr.index.cycle.slice(0, 13)}Z` : ww3 ? " · wind: GFS (coarse)" : ""}
            {age !== null && <span className={age > 12 ? "text-amber-700" : ""}> · fetched {age < 1 ? "<1" : age.toFixed(0)} h ago{age > 12 ? " (stale)" : ""}</span>}
          </p>
          <div className="mt-1 flex gap-3 text-xs">
            <label className="flex items-center gap-1"><input type="checkbox" checked={showSwell} onChange={(e) => setShowSwell(e.target.checked)} /> swell</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={showWind} onChange={(e) => setShowWind(e.target.checked)} /> wind</label>
            <button onClick={() => setListOpen((o) => !o)} className="ml-auto rounded bg-slate-900 px-2 py-0.5 text-white md:hidden">spots</button>
          </div>
        </div>
        {data.error && <div className="pointer-events-auto max-w-sm rounded-xl bg-red-50 p-3 text-xs text-red-800 shadow">{data.error}</div>}
      </header>

      {/* ranked list: side card on desktop, sheet on mobile */}
      <div className="absolute right-4 top-4 z-10 hidden max-h-[45vh] w-64 overflow-y-auto rounded-xl bg-white/90 p-2 shadow-lg backdrop-blur md:block">{list}</div>
      {listOpen && (
        <div className="absolute inset-x-2 bottom-24 top-24 z-20 overflow-y-auto rounded-xl bg-white/95 p-2 shadow-xl backdrop-blur md:hidden">
          <div className="flex items-center justify-between px-2 pb-1 text-xs text-slate-500"><span>Ranked now</span><button onClick={() => setListOpen(false)}>close</button></div>
          {list}
        </div>
      )}

      {sel && sel.now && (
        <div className="absolute inset-x-2 bottom-24 top-auto z-10 max-h-[58vh] md:inset-x-auto md:left-4 md:top-28 md:max-h-none md:w-80">
          <SpotPanel spot={sel.spot} result={sel.now.result} cond={sel.now.cond} onClose={() => setSelected(null)}
            buoys={sel.spot.buoys.map((id) => [id, data.ndbc?.buoys[id]])} bathy={data.bathy.spots[sel.spot.id] ?? null} />
        </div>
      )}

      <div className="pointer-events-none absolute bottom-24 right-3 z-10 hidden rounded-lg bg-white/85 px-2 py-1.5 text-[10px] text-slate-600 shadow md:block">
        <div className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-500" /> good ≥60 <span className="ml-2 h-2 w-2 rounded-full bg-yellow-400" /> fair 30–59 <span className="ml-2 h-2 w-2 rounded-full bg-red-500" /> poor</div>
        <div className="mt-1 flex items-center gap-1">wind <span className="h-2 w-24 rounded" style={{ background: "linear-gradient(90deg,#78c8ff,#50c878,#fad23c,#fa7828,#c81e78)" }} /> 0–30 kt</div>
        <div className="mt-1 flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-slate-900" /> buoy (live Hs, period)</div>
      </div>

      {ww3 && (
        <div className="absolute bottom-3 left-3 right-3 z-10 md:bottom-4 md:left-1/2 md:w-[640px] md:-translate-x-1/2">
          <Timeline steps={ww3.index.steps} index={stepIdx} onChange={setStepIdx} playing={playing} onTogglePlay={() => setPlaying((p) => !p)} />
        </div>
      )}
    </main>
  );
}

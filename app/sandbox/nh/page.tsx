"use client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { NhHover, NhLayers, NhSpot } from "@/components/sandbox/NhMap";
import { atTime, loadHrrrStep, loadWw3Step, type GridIndex, type HrrrStep, type Ww3Step } from "@/lib/cache";
import { LEGEND, SWELL_STOPS, TIER, WIND_ALIGN, cssGradient, tierFor } from "@/lib/colors";
import { byDay, dayKeyOf, forecastFor, representativePoint } from "@/lib/forecast";
import { NH_BBOX, loadDepth, loadOcean, loadRibbon, loadSpotsGeo, type DepthGrid, type RibbonFeature } from "@/lib/nhData";
import { bilinearField, windVectorField } from "@/lib/overlays";
import { SPOTS } from "@/lib/spots";
import type { FlowField } from "@/lib/streamlines";
import { useForecastData } from "@/lib/useForecastData";

const NhMap = dynamic(() => import("@/components/sandbox/NhMap"), { ssr: false });
const compass = (d: number) => ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(d / 22.5) % 16];
const fmt = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/New_York" });
const chip = (on: boolean) => ({ height: 30, padding: "0 9px", borderRadius: 6, border: `1px solid ${on ? "#4798b7" : "rgba(255,255,255,.16)"}`, background: on ? "#4798b7" : "rgba(255,255,255,.10)", color: on ? "#0e2029" : "#e8eef2", font: "600 10px 'Barlow Condensed','Barlow',sans-serif", letterSpacing: ".03em", textTransform: "uppercase" as const, cursor: "pointer" });

/** Swell as a flow field: unit travel vector (WW3 DIRPW is "from") and height as the speed channel. */
function swellFlow(ww3: { index: GridIndex; step: Ww3Step }): FlowField {
  const n = ww3.step.fields.hs.length; const u: Array<number | null> = new Array(n), v: Array<number | null> = new Array(n);
  for (let k = 0; k < n; k++) { const d = ww3.step.fields.dp[k]; if (d == null) { u[k] = null; v[k] = null; continue; } const r = ((d + 180) * Math.PI) / 180; u[k] = Math.sin(r); v[k] = Math.cos(r); }
  const uf = bilinearField(ww3.index, u), vf = bilinearField(ww3.index, v), hf = bilinearField(ww3.index, ww3.step.fields.hs);
  return { at: (lat, lon) => { const a = uf(lat, lon), b = vf(lat, lon); if (a === null || b === null) return null; const s = Math.hypot(a, b) || 1; return { u: a / s, v: b / s, speed: hf(lat, lon) ?? 0.5 }; } };
}

export default function NhSandbox() {
  const data = useForecastData();
  const [dayIdx, setDayIdx] = useState(0);
  const [layers, setLayers] = useState<NhLayers>({ bathy: true, wind: true, swell: true, crests: true, ribbon: true, landFill: false, pulses: true });
  const [depth, setDepth] = useState<DepthGrid | null>(null);
  const [ribbon, setRibbon] = useState<RibbonFeature[]>([]);
  const [ocean, setOcean] = useState<unknown | null>(null);
  const [ids, setIds] = useState<string[]>([]);
  const [ww3Step, setWw3Step] = useState<Ww3Step | null>(null);
  const [hrrrStep, setHrrrStep] = useState<HrrrStep | null>(null);
  const [hover, setHover] = useState<NhHover | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [todayKey] = useState(() => dayKeyOf(Date.now()));

  useEffect(() => { loadDepth().then(setDepth); loadRibbon().then((r) => setRibbon(r.features)); loadOcean().then(setOcean); loadSpotsGeo().then((g) => setIds(g.features.map((f) => f.properties.id))); }, []);

  const forecasts = useMemo(() => SPOTS.filter((s) => ids.includes(s.id)).map((spot) => ({ spot, points: forecastFor(spot, data) })), [data, ids]);
  const days = useMemo(() => byDay(forecasts[0]?.points ?? []).slice(0, 7).map((d) => ({ key: d.day, label: fmt.format(new Date(d.best.valid_time)) })), [forecasts]);
  const day = days[dayIdx]?.key;
  const daily = useMemo(() => forecasts.map(({ spot, points }) => ({ spot, best: byDay(points).find((x) => x.day === day)?.best ?? null, rep: day ? representativePoint(points, day, todayKey) : null })).filter((x) => x.best), [forecasts, day, todayKey]);
  const repTime = daily[0]?.rep?.valid_time ?? null;
  useEffect(() => {
    if (!data.ww3 || !repTime) return; let live = true;
    const w = atTime(data.ww3.index.steps, repTime), h = data.hrrr ? atTime(data.hrrr.index.steps, repTime, 45) : null;
    Promise.all([w ? loadWw3Step(w.file) : null, h ? loadHrrrStep(h.file) : null]).then(([ws, hs]) => { if (live) { setWw3Step(ws); setHrrrStep(hs); } });
    return () => { live = false; };
  }, [data.ww3, data.hrrr, repTime]);

  const wind = useMemo<FlowField | null>(() => data.hrrr && hrrrStep ? windVectorField({ index: data.hrrr.index, step: hrrrStep }) : data.ww3 && ww3Step ? windVectorField({ index: data.ww3.index, step: ww3Step }) : null, [data.hrrr, data.ww3, hrrrStep, ww3Step]);
  const swell = useMemo<FlowField | null>(() => (data.ww3 && ww3Step ? swellFlow({ index: data.ww3.index, step: ww3Step }) : null), [data.ww3, ww3Step]);

  const spots: NhSpot[] = daily.map(({ spot, best }) => { const b = best!; const d = b.result.dominant;
    return { id: spot.id, name: spot.name, state: spot.state, lat: spot.location.lat, lon: spot.location.lon, tier: tierFor(b.result.score), score: b.result.score, face_ft: b.result.face_ft,
      tp: d?.tp ?? null, dp: d?.dp ?? null, hs_m: b.result.usable_hs_m, windKts: b.cond.wind?.speed_kts ?? null, windFrom: b.cond.wind?.dir_from_deg ?? null }; });
  const toggle = (k: keyof NhLayers) => setLayers((l) => ({ ...l, [k]: !l[k] }));

  return (
    <main style={{ position: "fixed", inset: 0, background: "#0e2029", color: "#e8eef2", fontFamily: "'Barlow', system-ui, sans-serif" }}>
      <NhMap spots={spots} wind={wind} swell={swell} layers={layers} depth={depth} ribbon={ribbon} ocean={ocean} onHover={setHover} selectedId={selected} onSelect={setSelected} />

      <header style={{ position: "absolute", left: 0, right: 0, top: 0, zIndex: 5, background: "rgba(14,32,41,.92)", borderBottom: "1px solid rgba(255,255,255,.08)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, height: 44, padding: "0 16px" }}>
          <Link href="/" style={{ color: "#9fb1bc", fontSize: 12, textDecoration: "none" }}>← Overview</Link>
          <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: ".04em", textTransform: "uppercase", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>NH Sandbox <span style={{ color: "#9fb1bc", fontWeight: 500 }}>· 5-layer stack</span></div>
          <div style={{ marginLeft: "auto", fontSize: 11, color: "#9fb1bc", whiteSpace: "nowrap" }} className="hidden sm:block">{data.ww3 ? `GFS-Wave ${data.ww3.index.cycle.slice(5, 13)}Z` : "loading…"}{data.hrrr ? ` · HRRR ${data.hrrr.index.cycle.slice(5, 13)}Z` : ""}</div>
        </div>
        <div style={{ display: "flex", flexWrap: "nowrap", overflowX: "auto", alignItems: "center", gap: 6, padding: "6px 8px", background: "#2c3a42", scrollbarWidth: "none" }}>
          <button onClick={() => setDayIdx((i) => Math.max(0, i - 1))} style={chip(false)}>‹</button>
          <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".06em", textTransform: "uppercase", minWidth: 96, textAlign: "center" }}>{days[dayIdx]?.label ?? "—"}</span>
          <button onClick={() => setDayIdx((i) => Math.min(days.length - 1, i + 1))} style={chip(false)}>›</button>
          <span style={{ width: 8, flexShrink: 0 }} />
          {([["bathy", "L0 Bathymetry"], ["wind", "L1 Wind flow"], ["swell", "L1 Swell flow"], ["crests", "L1 Refraction"], ["ribbon", "L2 Ribbon"], ["landFill", "L3 Chart land"], ["pulses", "L4 Pulses"]] as Array<[keyof NhLayers, string]>).map(([k, label]) => (
            <button key={k} onClick={() => toggle(k)} aria-pressed={layers[k]} style={{ ...chip(layers[k]), whiteSpace: "nowrap", flexShrink: 0 }}>{label}</button>))}
        </div>
      </header>

      {/* legends generated from the same colour tables the canvases use (Step 4 sync) */}
      <div style={{ position: "absolute", left: 12, bottom: 12, zIndex: 5, display: "flex", flexDirection: "column", gap: 6, width: 150 }}>
        {[{ t: "Bathymetry (L0)", g: "linear-gradient(90deg,#00E5FF 0%,#0099CC 30%,#0B192C 100%)", l: ["0 m", "20 m", "150 m+"] },
          { t: LEGEND.swell.title + " (L1)", g: cssGradient(SWELL_STOPS), l: LEGEND.swell.labels as unknown as string[] },
          { t: LEGEND.wind.title + " (L2)", g: cssGradient(LEGEND.wind.stops), l: LEGEND.wind.labels as unknown as string[] }].map((x) => (
          <div key={x.t} style={{ borderRadius: 8, background: "rgba(14,32,41,.92)", boxShadow: "0 4px 14px rgba(0,0,0,.35)", padding: "8px 10px" }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase" }}>{x.t}</div>
            <div style={{ height: 8, borderRadius: 4, background: x.g, margin: "6px 0" }} />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, fontWeight: 500 }}>{x.l.map((s) => <span key={s}>{s}</span>)}</div>
          </div>))}
      </div>

      {/* React-driven hover tooltip (L4) */}
      {hover && (
        <div style={{ position: "absolute", left: Math.min(hover.x + 14, (typeof window !== "undefined" ? window.innerWidth : 390) - 236), top: hover.y + 14, zIndex: 6, width: 220, borderRadius: 8, background: "rgba(14,32,41,.95)", boxShadow: "0 4px 14px rgba(0,0,0,.4)", padding: "8px 10px", pointerEvents: "none" }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase", color: TIER[hover.spot.tier] }}>{hover.spot.name}</div>
          <div style={{ fontSize: 10, marginTop: 2 }}>Waves <b>{Math.max(1, Math.round(hover.spot.face_ft))}–{Math.round(hover.spot.face_ft * 1.3)} ft</b>{hover.spot.tp !== null ? <> @ <b>{hover.spot.tp.toFixed(0)} s</b> from {compass(hover.spot.dp!)}</> : null}</div>
          <div style={{ fontSize: 10 }}>Wind {hover.spot.windKts !== null ? <><b>{Math.round(hover.spot.windKts)} kt</b> from {compass(hover.spot.windFrom!)}</> : "n/a"}{hover.ribbonAngle !== null ? <> · {Math.round(hover.ribbonAngle)}° off the beach normal · <span style={{ color: WIND_ALIGN[hover.ribbonTier as keyof typeof WIND_ALIGN] }}>{hover.ribbonTier}</span></> : null}</div>
          <div style={{ fontSize: 10, color: "#b8c7d1" }}>Score {hover.spot.score} · {hover.spot.tier === "green" ? "Green" : hover.spot.tier === "moderate" ? "Moderate" : "Poor"}</div>
        </div>)}
      <div className="hidden md:block" style={{ position: "absolute", right: 12, bottom: 12, zIndex: 5, fontSize: 10, color: "#9fb1bc", background: "rgba(14,32,41,.8)", padding: "4px 8px", borderRadius: 6 }}>MapLibre GL · deck.gl interleaved · self-hosted MVT (NOAA CRM 3″) · bbox {NH_BBOX.south}–{NH_BBOX.north}N</div>
    </main>
  );
}

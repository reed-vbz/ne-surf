"use client";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import OverviewScreen, { type ScreenModel } from "@/components/screen/OverviewScreen";
import ChartPanel from "@/components/screen/ChartPanel";
import ForecastDrawer, { type DayRow } from "@/components/screen/ForecastDrawer";
import SpectraGraph from "@/components/screen/SpectraGraph";
import PolarRadar from "@/components/screen/PolarRadar";
import type { WindLabel } from "@/components/screen/WaveAvatar";
import type { MapBuoy, MapHover, MapSpot } from "@/components/map/MarineMap";
import { atTime, buoyFresh, validStep, loadHrrrStep, loadWw3Step, type GridIndex, type HrrrStep, type Ww3Step } from "@/lib/cache";
import { byDay, dayKeyOf, forecastFor, representativePoint, type ForecastPoint } from "@/lib/forecast";
import { hourlySeries, tideDay, type HourPoint } from "@/lib/hourly";
import { loadWavefieldImage, loadWavefieldIndex, type Wavefield, type WavefieldIndex } from "@/lib/wavefield";
import { TIER, tierFor, WIND_ALIGN } from "@/lib/colors";
import { bilinearField, windVectorField } from "@/lib/overlays";
import { faceLabel, forecastTime } from "@/lib/display";
import { BAND_LABEL } from "@/lib/quality/score";
import { assessWind } from "@/lib/quality";
import { REGION_BBOX, inRegion, loadDepth, loadRibbon, type DepthGrid, type RibbonFeature } from "@/lib/region";
import { SPOTS } from "@/lib/spots";
import type { FlowField } from "@/lib/streamlines";
import { useForecastData } from "@/lib/useForecastData";
import { REFERENCE_MODEL } from "@/lib/referenceFixture";

const MarineMap = dynamic(() => import("@/components/map/MarineMap"), { ssr: false });
const compass = (d: number) => ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(d / 22.5) % 16];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "June", "July", "Aug", "Sept", "Oct", "Nov", "Dec"]; // "Tue, Sept 22" as in ui-reference
const NY = "America/New_York";
const parts = (iso: string) => { const p = new Intl.DateTimeFormat("en-US", { timeZone: NY, weekday: "short", month: "numeric", day: "numeric" }).formatToParts(new Date(iso)); const g = (t: string) => p.find((x) => x.type === t)?.value ?? ""; return { wd: g("weekday"), mo: Number(g("month")), day: Number(g("day")) }; };
const shortName = (n: string) => n.split(" (")[0].replace(/ Beach$/i, "").toUpperCase();
/** Layer 4 spot set: Reed's consolidated regional dataset (2026-09-22), by id in data/spots.json */
const REGION_SPOT_IDS = ["salisbury-ma", "seabrook-nh", "hampton-beach-nh", "the-wall-nh", "plaice-cove-nh", "jenness-nh", "rye-rocks-nh", "wallis-sands-nh", "long-sands-me", "ogunquit-me", "wells-me", "goochs-me", "fortunes-rocks-me", "higgins-me"];
const REGION_SPOTS = SPOTS.filter((s) => REGION_SPOT_IDS.includes(s.id) && inRegion(s.location.lat, s.location.lon));

function calloutFor(p: ForecastPoint) {
  const d = p.result.dominant; if (!d) return null;
  return `${faceLabel(p.result.face_ft)} @ ${d.tp.toFixed(0)}s (${compass(d.dp)})${p.cond.wind ? ` | ${compass(p.cond.wind.dir_from_deg)} Wind` : ""}`;
}
/** A WW3 partition as a flow field: unit travel vector (directions are "from") and height as the speed channel; falls back field by field. */
function partitionFlow(ww3: { index: GridIndex; step: Ww3Step }, dirKeys: string[], hsKeys: string[]): FlowField {
  const F = ww3.step.fields;
  const n = F.hs.length; const u: Array<number | null> = new Array(n), v: Array<number | null> = new Array(n), h: Array<number | null> = new Array(n);
  for (let k = 0; k < n; k++) {
    const pair = dirKeys.map((key, i) => ({ d: F[key]?.[k], h: F[hsKeys[i]]?.[k] })).find((p) => p.d != null && p.h != null && Number.isFinite(p.d + p.h) && p.h > 0);
    if (!pair) { u[k] = null; v[k] = null; h[k] = null; continue; }
    const r = ((pair.d! + 180) * Math.PI) / 180; u[k] = Math.sin(r); v[k] = Math.cos(r); h[k] = pair.h!;
  }
  const uf = bilinearField(ww3.index, u), vf = bilinearField(ww3.index, v), hf = bilinearField(ww3.index, h);
  return { at: (lat, lon) => { const a = uf(lat, lon), b = vf(lat, lon); if (a === null || b === null) return null; const s = Math.hypot(a, b) || 1; return { u: a / s, v: b / s, speed: hf(lat, lon) ?? 0 }; } };
}
const mq = () => window.matchMedia("(min-width: 900px)");
const subscribeDesktop = (cb: () => void) => { const m = mq(); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); };

const readTheme = () => { try { return localStorage.getItem("ne-surf-theme") === "contrast" ? "contrast" : "standard"; } catch { return "standard"; } };
const subscribeTheme = (cb: () => void) => { window.addEventListener("storage", cb); window.addEventListener("ne-surf-theme", cb); return () => { window.removeEventListener("storage", cb); window.removeEventListener("ne-surf-theme", cb); }; };
function PageInner() {
  const data = useForecastData();
  const router = useRouter();
  const refMode = useSearchParams().get("ref") === "1";   // pixel-diff hook: reference chrome content over the live map
  const isDesktop = useSyncExternalStore(subscribeDesktop, () => mq().matches, () => false);
  const theme = useSyncExternalStore(subscribeTheme, readTheme, () => "standard");
  const [dayIdx, setDayIdx] = useState(0);
  const [drawerPref, setDrawerPref] = useState<boolean | null>(null);
  const drawerOpen = !refMode && (drawerPref ?? isDesktop);
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<MapHover | null>(null);
  const [activeTime, setActiveTime] = useState<number | null>(null);
  const [flyTo, setFlyTo] = useState<{ lon: number; lat: number; key: number } | null>(null);
  const [ww3StepData, setWw3Step] = useState<Ww3Step | null>(null);
  const [hrrrStepData, setHrrrStep] = useState<HrrrStep | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [depth, setDepth] = useState<DepthGrid | null>(null);
  const [wfIndex, setWfIndex] = useState<WavefieldIndex | null>(null);
  const [wavefieldData, setWavefield] = useState<Wavefield | null>(null);
  const [wavefieldFor, setWavefieldFor] = useState<string | null>(null);
  const [ribbon, setRibbon] = useState<RibbonFeature[]>([]);
  const [openedAt] = useState(() => Date.now());
  const todayKey = dayKeyOf(data.checkedAt || openedAt);
  const flyKey = useRef(0);

  useEffect(() => { loadDepth().then(setDepth).catch(() => setDepth(null)); loadRibbon().then((r) => setRibbon(r.features)).catch(() => setRibbon([]));  }, []);

  useEffect(() => {
    let live = true;
    loadWavefieldIndex(data.base).then((index) => { if (live) setWfIndex(index && index.cycle === data.ww3?.index.cycle && index.solver_version === 2 ? index : null); });
    return () => { live = false; };
  }, [data.base, data.ww3?.index.cycle]);

  const forecasts = useMemo(() => REGION_SPOTS.map((spot) => ({ spot, points: forecastFor(spot, data) })), [data]);
  const days = useMemo(() => byDay(forecasts[0]?.points ?? []).filter((d) => d.day >= todayKey).slice(0, 7).map((d) => { const x = parts(d.best.valid_time); return { key: d.day, name: x.wd, label: `${x.wd}, ${MONTHS[x.mo - 1]} ${x.day}` }; }), [forecasts, todayKey]);
  const day = days[dayIdx]?.key;

  const daily = useMemo(() => forecasts.map(({ spot, points }) => ({ spot, points, best: byDay(points).find((x) => x.day === day)?.best ?? null, rep: day ? representativePoint(points, day, todayKey) : null })).filter((x) => x.best), [forecasts, day, todayKey]);
  const ranked = useMemo(() => [...daily].sort((a, b) => b.best!.result.score - a.best!.result.score), [daily]);
  const top2 = new Set(ranked.slice(0, 2).map((r) => r.spot.id));
  const hot = ranked[0] ?? null;
  const focus = daily.find((d) => d.spot.id === selected) ?? hot;   // the drawer follows the selected break, else the hotspot

  // Map fields follow the hovered hour when the drawer is being read, else the day's representative step
  const hours = useMemo(() => (focus && day ? hourlySeries(focus.points, day) : []), [focus, day]);
  const hoverIso = activeTime !== null ? hours.find((h) => h.t === activeTime)?.iso ?? null : null;
  const mapTime = hoverIso ?? daily[0]?.rep?.valid_time ?? null;
  const gridKey = `${data.base}|${data.ww3?.index.cycle}|${data.hrrr?.index.cycle}|${mapTime}`;
  const fieldKey = `${data.base}|${data.ww3?.index.cycle}|${wfIndex?.cycle}|${mapTime}`;
  const ww3Step = loadedFor === gridKey ? ww3StepData : null;
  const hrrrStep = loadedFor === gridKey ? hrrrStepData : null;
  const wavefield = wavefieldFor === fieldKey ? wavefieldData : null;
  useEffect(() => {
    if (!data.ww3 || !mapTime) return;
    let live = true;
    const w = atTime(data.ww3.index.steps, mapTime), h = data.hrrr ? atTime(data.hrrr.index.steps, mapTime, 45) : null;
    const timer = setTimeout(() => Promise.all([w ? loadWw3Step(w.file, data.base) : null, h ? loadHrrrStep(h.file, data.base) : null]).then(([ws, hs]) => { if (!live) return; setWw3Step(w && validStep(data.ww3!.index, ws, w.valid_time) ? ws : null); setHrrrStep(h && data.hrrr && validStep(data.hrrr.index, hs, h.valid_time) ? hs : null); setLoadedFor(gridKey); }), hoverIso ? 120 : 0);
    return () => { live = false; clearTimeout(timer); };
  }, [data.base, data.ww3, data.hrrr, mapTime, hoverIso, gridKey]);
  // Layer 1 wave field (backend eikonal / PINN texture) for the map's active time
  useEffect(() => {
    if (!wfIndex || !mapTime || wfIndex.cycle !== data.ww3?.index.cycle) return; let live = true;
    const st = atTime(wfIndex.steps, mapTime, 90); if (!st) return;
    Promise.all([loadWavefieldImage(st.file, data.base, wfIndex.cycle), wfIndex.encoding.geometry ? loadWavefieldImage(wfIndex.encoding.geometry.file, data.base, wfIndex.cycle) : Promise.resolve(null)]).then(([image, geometry]) => { if (live) { setWavefield(image ? { image, geometry, bounds: wfIndex.bounds, omega: st.omega, tScale: wfIndex.encoding.t_scale_s, hMax: wfIndex.encoding.h_max_m, step: st } : null); setWavefieldFor(fieldKey); } });
    return () => { live = false; };
  }, [wfIndex, mapTime, data.base, data.ww3?.index.cycle, fieldKey]);
  const stepLoading = !!mapTime && loadedFor !== gridKey;
  const wind = useMemo<FlowField | null>(() => data.hrrr && hrrrStep ? windVectorField({ index: data.hrrr.index, step: hrrrStep }) : data.ww3 && ww3Step ? windVectorField({ index: data.ww3.index, step: ww3Step }) : null, [data.hrrr, data.ww3, hrrrStep, ww3Step]);
  // L1: groundswell = the primary WW3 swell partition (whole-spectrum peak where no partition), wind waves = the WW3 wind-sea partition (HRRR wind where absent)
  const swell = useMemo<FlowField | null>(() => (data.ww3 && ww3Step ? partitionFlow({ index: data.ww3.index, step: ww3Step }, ["swell1_dp", "dp"], ["swell1_hs", "hs"]) : null), [data.ww3, ww3Step]);
  const windWaves = useMemo<FlowField | null>(() => (data.ww3 && ww3Step && ww3Step.fields.wind_dp ? partitionFlow({ index: data.ww3.index, step: ww3Step }, ["wind_dp"], ["wind_hs"]) : null), [data.ww3, ww3Step]);

  const spots: MapSpot[] = useMemo(() => daily.flatMap(({ spot, points }) => { const b = mapTime ? atTime(points, mapTime, 1) : null; if (!b) return []; const d = b.result.dominant; const body = calloutFor(b);
    return { id: spot.id, name: spot.name, state: spot.state, lat: spot.location.lat, lon: spot.location.lon, tier: tierFor(b.result.score), score: b.result.score, face_ft: b.result.face_ft,
      tp: d?.tp ?? null, dp: d?.dp ?? null, hs_m: b.result.usable_hs_m, windKts: b.cond.wind?.speed_kts ?? null, windFrom: b.cond.wind?.dir_from_deg ?? null,
      callout: body && (top2.has(spot.id) || selected === spot.id) ? body : undefined }; }), [daily, selected, mapTime]);   // eslint-disable-line react-hooks/exhaustive-deps
  const buoys: MapBuoy[] = useMemo(() => (data.ww3?.spots.buoys ?? []).filter((b) => inRegion(b.position.lat, b.position.lon) || (b.position.lat > REGION_BBOX.south - 0.3 && b.position.lat < REGION_BBOX.north + 0.3 && b.position.lon > REGION_BBOX.west - 0.3 && b.position.lon < REGION_BBOX.east + 0.3)).map((b) => { const o = data.ndbc?.buoys[b.id]; const ok = buoyFresh(o);
    return { id: b.id, lat: b.position.lat, lon: b.position.lon, ok, label: ok ? `Buoy ${b.id} · ${(o!.wvht_m! * 3.28).toFixed(1)} ft @ ${o!.dpd_s ?? "–"} s${o!.wspd_ms != null ? ` · wind ${Math.round(o!.wspd_ms * 1.944)} kt` : ""}` : `Buoy ${b.id} · stale or unavailable` }; }), [data.ww3, data.ndbc]);

  const hotTier = hot ? tierFor(hot.best!.result.score) : "poor";

  const hotWind = hot?.best?.cond.wind ? assessWind(hot.spot, hot.best.cond.wind) : null;
  const windWord = !hotWind ? "" : hotWind.label === "offshore" || hotWind.label === "glassy" ? "Optimal" : hotWind.label === "onshore" || hotWind.label === "cross-on" ? "Onshore" : "Cross-shore";
  const go = (id: string) => { const s = REGION_SPOTS.find((x) => x.id === id); if (!s) { router.push(`/spots/${id}`); return; } setSelected(id); setFlyTo({ lon: s.location.lon, lat: s.location.lat, key: ++flyKey.current }); };

  const hourWord = (t: number) => { const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: NY, hour: "numeric", hour12: false }).format(new Date(t))) % 24; return h === 0 ? "midnight" : h === 12 ? "noon" : h < 12 ? `${h} AM` : `${h - 12} PM`; };
  const radarPoint = focus && mapTime ? atTime(focus.points, mapTime, 1) : null;
  const nearestBuoy = useMemo(() => { if (!focus || !data.ww3) return null; const cands = (data.ww3.spots.buoys ?? []).filter((b) => focus.spot.buoys.includes(b.id));
    const b = (cands.length ? cands : data.ww3.spots.buoys ?? []).map((b) => ({ b, d: Math.hypot(b.position.lat - focus.spot.location.lat, (b.position.lon - focus.spot.location.lon) * 0.73) })).sort((a, c) => a.d - c.d)[0]?.b;
    return b ? { id: b.id, obs: data.ndbc?.buoys[b.id] ?? null } : null; }, [focus, data.ww3, data.ndbc]);
  const windAt = (h: HourPoint): WindLabel => (focus && h.windKts != null && h.windFrom != null ? assessWind(focus.spot, { speed_kts: h.windKts, dir_from_deg: h.windFrom }).label : "unknown");

  const dayRows: DayRow[] = focus ? byDay(focus.points).filter((d) => d.day >= todayKey).slice(0, 7).map((d, i) => { const x = parts(d.best.valid_time); const b = d.best; const w = b.cond.wind ? assessWind(focus.spot, b.cond.wind) : null;
    return { key: d.day, label: `${x.wd} ${x.day}`, tier: tierFor(b.result.score), range: faceLabel(b.result.face_ft), period: b.result.dominant ? `@ ${b.result.dominant.tp.toFixed(0)} s ${compass(b.result.dominant.dp)}` : "",
      wind: b.cond.wind ? `${compass(b.cond.wind.dir_from_deg)} ${Math.round(b.cond.wind.speed_kts)} kt${w ? ` · ${w.label}` : ""}` : "wind n/a", active: i === dayIdx }; }) : [];
  const tide = useMemo(() => tideDay(focus ? data.tides[focus.spot.tide.station_id] ?? null : null, day ?? ""), [focus, data.tides, day]);

  // the header's 7-day row: the region's best break per day
  const dayBest = days.map((d) => forecasts.map(({ points }) => byDay(points).find((x) => x.day === d.key)?.best ?? null).reduce<ForecastPoint | null>((b, p) => (p && (!b || p.result.score > b.result.score) ? p : b), null));
  const model: ScreenModel = {
    dateLabel: days[dayIdx]?.label ?? "",
    days: (days.length ? days : Array.from({ length: 7 }, (_, i) => ({ key: String(i), name: "", label: "" }))).map((d, i) => { const b = dayBest[i];
      return { name: d.name, filled: i <= dayIdx, active: i === dayIdx, range: b ? faceLabel(b.result.face_ft) : "—",
        meta: b ? `${b.result.dominant ? `${b.result.dominant.tp.toFixed(0)} s` : ""}${b.cond.wind ? ` · ${compass(b.cond.wind.dir_from_deg)}` : ""}` : "", tierColor: b ? TIER[tierFor(b.result.score)] : "#2c3f49" }; }),
    selectedIndex: dayIdx,
    knobFraction: activeTime !== null ? (hours.findIndex((h) => h.t === activeTime) / Math.max(1, hours.length - 1)) : undefined,
    callouts: [],   // callouts are anchored to pins by the map layer
    hotspot: hot && hot.best
      ? { rating: BAND_LABEL[hot.best.result.band], ratingColor: TIER[hotTier], pinColor: TIER[hotTier],
          line1: `${shortName(hot.spot.name).charAt(0) + shortName(hot.spot.name).slice(1).toLowerCase()}: ${faceLabel(hot.best.result.face_ft)}${hot.best.result.dominant ? ` @ ${hot.best.result.dominant.tp.toFixed(0)}s` : ""}`,
          line2: `Best window · ${forecastTime(hot.best.valid_time)} · ` + (hot.best.cond.wind ? `${compass(hot.best.cond.wind.dir_from_deg)} wind · ${windWord}` : "wind unavailable") }
      : { rating: "—", ratingColor: "#9c9ea1", pinColor: "#9c9ea1", line1: data.error ?? (data.loading ? "Loading forecast" : "No forecast available"), line2: "" },
  };

  return (
    <main data-theme={theme} style={{ position: "fixed", inset: 0 }}>
      <OverviewScreen m={refMode ? REFERENCE_MODEL : model}
        h={{ onPrev: () => { setDayIdx((i) => Math.max(0, i - 1)); setActiveTime(null); }, onNext: () => { setDayIdx((i) => Math.min(days.length - 1, i + 1)); setActiveTime(null); }, onPickDay: (i) => { setDayIdx(i); setActiveTime(null); },
             onForecast: () => setDrawerPref(!drawerOpen), onMenu: () => router.push("/about"), onHotspot: () => hot && go(hot.spot.id) }}
        map={<MarineMap spots={spots} buoys={buoys} wind={wind} windSea={windWaves} swell={swell} wavefield={wavefield} depth={depth} ribbon={ribbon} onHover={setHover} selectedId={selected} onSelect={setSelected} flyTo={flyTo} />}
        dockExtras={!refMode && focus ? <>
          <ChartPanel title="Swell radar"><PolarRadar trains={radarPoint?.cond.trains ?? []} facingDeg={focus.spot.facing_deg} window={focus.spot.swell.window} title="Swell radar" sub={`${shortName(focus.spot.name)}${mapTime ? ` · ${hourWord(Date.parse(mapTime))}` : ""}`} /></ChartPanel>
          <ChartPanel title="Swell spectra"><SpectraGraph now={data.checkedAt || openedAt} buoy={nearestBuoy} trains={radarPoint?.cond.trains ?? []} spotName={shortName(focus.spot.name)} hourLabel={mapTime ? hourWord(Date.parse(mapTime)) : ""} /></ChartPanel>
        </> : null}>
        {!refMode && <details className="nesurf-data-status" style={{ position: "absolute", top: 132, left: 10, zIndex: 7, maxWidth: "min(360px, calc(100vw - 20px))", padding: "6px 10px", borderRadius: 8, background: "rgba(9,23,35,.94)", color: data.stale ? "#f3c79e" : "#cfe0ea", fontSize: 12 }}>
          <summary>{data.error ?? (data.stale ? "Stale forecast · " : "") + (mapTime ? forecastTime(mapTime) : data.loading ? "Loading forecast" : "No forecast available")}</summary>
          <button onClick={() => { const next = theme === "contrast" ? "standard" : "contrast"; try { localStorage.setItem("ne-surf-theme", next); window.dispatchEvent(new Event("ne-surf-theme")); } catch {} }} style={{ padding: "8px", border: "1px solid #6b9db5", borderRadius: 6, margin: "8px 0" }}>Display: {theme}</button>
          <div>Run: {data.ww3 ? forecastTime(data.ww3.index.cycle) : "unavailable"}</div>
          <div>Wind: {hrrrStep ? "HRRR" : ww3Step ? "GFS" : "unavailable"}{(hrrrStep ?? ww3Step) ? ` · ${forecastTime((hrrrStep ?? ww3Step)!.valid_time)}` : ""}</div>
          <div>Primary swell field: {wavefield ? forecastTime(wavefield.step.valid_time) : "unavailable; offshore direction trails only"}</div>
          <div>Dashed boundary: detailed bathymetry coverage. Nearshore heights are empirical estimates.</div>
          <div>Daily row and hotspot show best windows. Pins, radar and drawer follow selected time.</div>
          <div>Publication: {data.revision.slice(0, 12)}</div>
        </details>}
        {/* progress line under the search bar while data or an hour's grids load */}
        {(data.loading || stepLoading) && <div style={{ position: "absolute", left: 0, top: 128, height: 2, width: "100%", background: "#4798b7", zIndex: 7, transformOrigin: "left", animation: "nesurf-progress 1.2s ease-in-out infinite" }} />}
        {/* L4 hover tooltip (React) */}
        {hover && !refMode && (
          <div style={{ position: "absolute", left: Math.min(hover.x + 14, (typeof window !== "undefined" ? window.innerWidth : 390) - 236), top: Math.min(hover.y + 14, (typeof window !== "undefined" ? window.innerHeight : 844) - 140), zIndex: 9, width: 220, borderRadius: 8, background: "rgba(14,32,41,.95)", boxShadow: "0 4px 14px rgba(0,0,0,.4)", padding: "8px 10px", pointerEvents: "none", fontFamily: "'Barlow', system-ui, sans-serif" }}>
            {hover.kind === "buoy" ? <div style={{ fontSize: 12, color: "#e8eef2" }}><b style={{ color: hover.buoy.ok ? "#41c776" : "#9c9ea1" }}>{hover.buoy.ok ? "RECENT" : "UNAVAILABLE"}</b> · {hover.buoy.label}</div> : <>
              <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase", color: TIER[hover.spot.tier] }}>{hover.spot.name}</div>
              <div style={{ fontSize: 12, marginTop: 2, color: "#e8eef2" }}>Waves <b>{faceLabel(hover.spot.face_ft)}</b>{hover.spot.tp !== null ? <> @ <b>{hover.spot.tp.toFixed(0)} s</b> from {compass(hover.spot.dp!)}</> : null}</div>
              <div style={{ fontSize: 12, color: "#e8eef2" }}>Wind {hover.spot.windKts !== null ? <><b>{Math.round(hover.spot.windKts)} kt</b> from {compass(hover.spot.windFrom!)}</> : "n/a"}{hover.ribbonAngle !== null ? <> · {Math.round(hover.ribbonAngle)}° off the beach · <span style={{ color: WIND_ALIGN[hover.ribbonTier as keyof typeof WIND_ALIGN] }}>{hover.ribbonTier}</span></> : null}</div>
              <div style={{ fontSize: 12, color: "#b8c7d1" }}>Score {hover.spot.score} · {hover.spot.tier === "green" ? "Green" : hover.spot.tier === "moderate" ? "Moderate" : "Poor"}</div></>}
          </div>)}
        {!refMode && <ForecastDrawer open={drawerOpen} onClose={() => setDrawerPref(false)} spotName={focus?.spot.name ?? "—"} tier={radarPoint ? tierFor(radarPoint.result.score) : "poor"} dayLabel={days[dayIdx]?.label ?? ""}
          hours={hours} tide={tide} activeTime={activeTime} onPickTime={setActiveTime} days={dayRows} onPickDay={(i) => { setDayIdx(i); setActiveTime(null); }} windAt={windAt} defaultTime={mapTime ? Date.parse(mapTime) : null} />}
      </OverviewScreen>
    </main>
  );
}

export default function Page() { return <Suspense fallback={null}><PageInner /></Suspense>; }

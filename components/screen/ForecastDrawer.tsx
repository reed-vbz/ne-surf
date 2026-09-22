"use client";
/**
 * Glassmorphism forecast drawer (Layer 4). Bottom sheet on phones, docked right on desktop.
 *   Tab 1  24-hour timeline: SVG sparklines for wave height, swell period, wind (speed + direction arrows) and the tide curve.
 *          Hovering an hour reports it up (the page moves the timeline knob and swaps the map's vector fields to that hour).
 *   Tab 2  7-day overview: quality icon, wave range, dominant wind per day.
 */
import { useState, type PointerEvent } from "react";
import { TIER, type Tier } from "@/lib/colors";
import type { HourPoint } from "@/lib/hourly";

export interface DayRow { key: string; label: string; tier: Tier; range: string; period: string; wind: string; active: boolean }
interface Props {
  open: boolean; onClose: () => void; spotName: string; tier: Tier; dayLabel: string;
  hours: HourPoint[]; tide: { series: Array<{ t: number; v: number }>; hilo: Array<{ t: number; v: number; type: "H" | "L" }> };
  activeHour: number | null; onHoverHour: (h: number | null) => void; days: DayRow[]; onPickDay: (i: number) => void;
}
const compass = (d: number) => ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(d / 22.5) % 16];
const TIER_WORD: Record<Tier, string> = { green: "Green", moderate: "Moderate", poor: "Poor" };
const W = 320, PADL = 4, PADR = 34, X0 = PADL, X1 = W - PADR;
const xAt = (h: number) => X0 + (h / 23) * (X1 - X0);
const path = (pts: Array<[number, number]>) => pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
const label: React.CSSProperties = { fontSize: 9, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: "#9fb1bc" };

function Row({ title, value, children, h = 54 }: { title: string; value: string; children: React.ReactNode; h?: number }) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}><span style={label}>{title}</span><span style={{ fontSize: 11, fontWeight: 700, color: "#e8eef2" }}>{value}</span></div>
      <svg viewBox={`0 0 ${W} ${h}`} width="100%" height={h} style={{ display: "block", overflow: "visible" }}>{children}</svg>
    </div>
  );
}

export default function ForecastDrawer({ open, onClose, spotName, tier, dayLabel, hours, tide, activeHour, onHoverHour, days, onPickDay }: Props) {
  const [tab, setTab] = useState<"hourly" | "daily">("hourly");
  const onMove = (e: PointerEvent<HTMLDivElement>) => { const r = e.currentTarget.getBoundingClientRect(); const f = (e.clientX - r.left - (PADL / W) * r.width) / (((X1 - X0) / W) * r.width); onHoverHour(Math.max(0, Math.min(23, Math.round(f * 23)))); };
  const cur = activeHour !== null ? hours.find((p) => p.hour === activeHour) ?? null : hours[Math.min(hours.length - 1, 12)] ?? null;
  const maxFace = Math.max(3, ...hours.map((p) => p.faceFt)) * 1.15, maxTp = Math.max(10, ...hours.map((p) => p.tp ?? 0)) * 1.1, maxWind = Math.max(15, ...hours.map((p) => p.windKts ?? 0)) * 1.1;
  const tv = tide.series.map((s) => s.v); const tMin = Math.min(0, ...tv), tMax = Math.max(1, ...tv);
  const t0 = hours[0]?.t ?? 0, t1 = hours[hours.length - 1]?.t ?? 1;
  const xT = (t: number) => X0 + ((t - t0) / Math.max(1, t1 - t0)) * (X1 - X0);
  const cursor = (h: number) => activeHour !== null ? <line x1={xAt(activeHour)} x2={xAt(activeHour)} y1={0} y2={h} stroke="#ffffff" strokeOpacity={0.5} strokeDasharray="2 3" /> : null;
  const hourTicks = [0, 6, 12, 18, 23];
  const tick = (h: number) => (h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : h === 23 ? "11p" : `${h - 12}p`);

  return (
    <>
      <style>{`.nesurf-drawer{position:absolute;left:8px;right:8px;bottom:8px;top:38%;z-index:8;display:flex;flex-direction:column;overflow:hidden;transform:translateY(${open ? 0 : "calc(100% + 16px)"});transition:transform 260ms cubic-bezier(.2,.8,.2,1)}
        @media (min-width:900px){.nesurf-drawer{left:auto;top:216px;right:12px;bottom:200px;width:380px;transform:translateX(${open ? 0 : "calc(100% + 24px)"})}}
        .nesurf-drawer-body{overflow-y:auto;scrollbar-width:thin;flex:1;min-height:0}`}</style>
      <section aria-label="Surf forecast" aria-hidden={!open} className="nesurf-drawer backdrop-blur-xl bg-slate-900/65 border border-white/10 rounded-2xl p-4 text-white shadow-2xl"
        style={{ boxShadow: "0 24px 60px rgba(0,0,0,.55), 0 0 0 1px rgba(0,229,255,.06), 0 0 48px rgba(0,229,255,.08)", fontFamily: "'Barlow', system-ui, sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase", color: TIER[tier], whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{spotName}</div>
            <div style={{ fontSize: 10, color: "#9fb1bc", letterSpacing: ".06em", textTransform: "uppercase" }}>{dayLabel}{cur ? ` · ${tick(cur.hour)} · ${Math.max(1, Math.round(cur.faceFt))}–${Math.round(cur.faceFt * 1.3)} ft` : ""}</div>
          </div>
          <div role="tablist" style={{ display: "flex", background: "rgba(255,255,255,.08)", borderRadius: 8, padding: 2 }}>
            {(["hourly", "daily"] as const).map((k) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} style={{ minHeight: 30, padding: "0 10px", borderRadius: 6, border: 0, cursor: "pointer", background: tab === k ? "#4798b7" : "transparent", color: tab === k ? "#0e2029" : "#e8eef2", font: "600 10px 'Barlow Condensed','Barlow',sans-serif", letterSpacing: ".06em", textTransform: "uppercase" }}>{k === "hourly" ? "24-Hour" : "7-Day"}</button>)}
          </div>
          <button aria-label="Close forecast" onClick={onClose} style={{ width: 44, height: 44, marginRight: -12, background: "transparent", border: 0, color: "#e8eef2", cursor: "pointer", fontSize: 18 }}>×</button>
        </div>

        {tab === "hourly" ? (
          <div className="nesurf-drawer-body" onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => onHoverHour(null)} style={{ display: "flex", flexDirection: "column", gap: 10, touchAction: "pan-y" }}>
            {hours.length === 0 ? <div style={{ fontSize: 11, color: "#9fb1bc" }}>No hourly data for this day yet.</div> : <>
              <Row title="Wave height" value={cur ? `${cur.faceFt.toFixed(1)} ft` : "—"}>
                <path d={`${path(hours.map((p) => [xAt(p.hour), 54 - (p.faceFt / maxFace) * 50]))} L${xAt(hours[hours.length - 1].hour)},54 L${xAt(hours[0].hour)},54 Z`} fill="#00E5FF" fillOpacity={0.18} />
                <path d={path(hours.map((p) => [xAt(p.hour), 54 - (p.faceFt / maxFace) * 50]))} fill="none" stroke="#00E5FF" strokeWidth={1.8} strokeLinejoin="round" />
                {hours.map((p) => <circle key={p.hour} cx={xAt(p.hour)} cy={54 - (p.faceFt / maxFace) * 50} r={p.hour === activeHour ? 3.5 : 0} fill="#fff" />)}
                <text x={W - 2} y={10} fontSize={9} fill="#9fb1bc" textAnchor="end">{maxFace.toFixed(0)} ft</text>
                {cursor(54)}
              </Row>
              <Row title="Swell period" value={cur?.tp != null ? `${cur.tp.toFixed(0)} s${cur.dp != null ? ` · ${compass(cur.dp)}` : ""}` : "—"} h={40}>
                <path d={path(hours.filter((p) => p.tp != null).map((p) => [xAt(p.hour), 40 - ((p.tp ?? 0) / maxTp) * 36]))} fill="none" stroke="#8A2BE2" strokeWidth={1.8} strokeLinejoin="round" />
                {hours.filter((p) => p.tp != null && p.hour % 4 === 2 && p.dp != null).map((p) => <g key={p.hour} transform={`translate(${xAt(p.hour)},${40 - ((p.tp ?? 0) / maxTp) * 36}) rotate(${(p.dp ?? 0) + 180})`}><path d="M0,-5 L3,2 L0,0.5 L-3,2 Z" fill="#c9a2ff" /></g>)}
                <text x={W - 2} y={10} fontSize={9} fill="#9fb1bc" textAnchor="end">{maxTp.toFixed(0)} s</text>
                {cursor(40)}
              </Row>
              <Row title="Wind" value={cur?.windKts != null ? `${Math.round(cur.windKts)} kt${cur.windFrom != null ? ` from ${compass(cur.windFrom)}` : ""}` : "—"} h={44}>
                <path d={path(hours.filter((p) => p.windKts != null).map((p) => [xAt(p.hour), 30 - ((p.windKts ?? 0) / maxWind) * 26]))} fill="none" stroke="#64d5cc" strokeWidth={1.6} strokeLinejoin="round" />
                {hours.filter((p) => p.windFrom != null && p.hour % 2 === 0).map((p) => <g key={p.hour} transform={`translate(${xAt(p.hour)},39) rotate(${(p.windFrom ?? 0) + 180})`}><path d="M0,-4.5 L3,2 L0,0.5 L-3,2 Z" fill={p.hour === activeHour ? "#fff" : "#64d5cc"} /></g>)}
                <text x={W - 2} y={10} fontSize={9} fill="#9fb1bc" textAnchor="end">{maxWind.toFixed(0)} kt</text>
                {cursor(44)}
              </Row>
              <Row title="Tide" value={tide.hilo.length ? tide.hilo.map((x) => `${x.type}${x.v.toFixed(1)}`).join(" ") + " m" : "—"} h={44}>
                {tide.series.length > 1 && <>
                  <path d={`${path(tide.series.map((s) => [xT(s.t), 40 - ((s.v - tMin) / (tMax - tMin)) * 34]))} L${xT(tide.series[tide.series.length - 1].t)},44 L${xT(tide.series[0].t)},44 Z`} fill="#4798b7" fillOpacity={0.25} />
                  <path d={path(tide.series.map((s) => [xT(s.t), 40 - ((s.v - tMin) / (tMax - tMin)) * 34]))} fill="none" stroke="#7fc4e6" strokeWidth={1.6} />
                  {tide.hilo.map((x) => <text key={x.t} x={xT(x.t)} y={x.type === "H" ? 8 : 43} fontSize={8} fill="#cfe0ea" textAnchor="middle">{x.type === "H" ? "▲" : "▼"} {x.v.toFixed(1)}</text>)}
                </>}
                {cursor(44)}
              </Row>
              <svg viewBox={`0 0 ${W} 12`} width="100%" height={12} style={{ display: "block" }}>{hourTicks.map((h) => <text key={h} x={xAt(h)} y={10} fontSize={8} fill="#9fb1bc" textAnchor="middle">{tick(h)}</text>)}</svg>
            </>}
          </div>
        ) : (
          <div className="nesurf-drawer-body" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {days.map((d, i) => (
              <button key={d.key} onClick={() => onPickDay(i)} style={{ display: "grid", gridTemplateColumns: "58px 18px 1fr auto", alignItems: "center", gap: 8, minHeight: 44, padding: "0 8px", borderRadius: 10, border: 0, cursor: "pointer", textAlign: "left", background: d.active ? "rgba(71,152,183,.22)" : "rgba(255,255,255,.04)", color: "#e8eef2" }}>
                <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase" }}>{d.label}</span>
                <span aria-label={TIER_WORD[d.tier]} style={{ width: 12, height: 12, borderRadius: 6, background: TIER[d.tier], boxShadow: `0 0 10px ${TIER[d.tier]}88` }} />
                <span style={{ fontSize: 11, fontWeight: 600 }}>{d.range} <span style={{ color: "#9fb1bc" }}>{d.period}</span></span>
                <span style={{ fontSize: 10, color: "#b8c7d1", whiteSpace: "nowrap" }}>{d.wind}</span>
              </button>))}
          </div>
        )}
      </section>
    </>
  );
}

"use client";
/**
 * Polar swell radar (widget dock card; the page wraps it in dockCard). A 360° compass; every swell partition at the active hour is plotted at its
 * direction-from, at a radius that grows with period (windsea near the centre, long-period groundswell toward the
 * rim), as a glowing bloom sized by height and coloured by energy. Windsea partitions scatter into dots (directional
 * spread), groundswell stays a tight cluster. The break's swell window is drawn as an arc on the rim, its facing as a
 * notch. Data follows the timeline / hovered hour.
 */
import { arc } from "d3-shape";
import { rgbToHex, swellColor, swellEnergy } from "@/lib/colors";
import type { SwellTrain } from "@/lib/quality/types";

interface Props { trains: SwellTrain[]; facingDeg: number; window: { from_deg: number; to_deg: number }; title: string; sub: string }
const R = 78, C = 100;
const rad = (deg: number) => ((deg - 90) * Math.PI) / 180;
const rOf = (tp: number) => R * Math.max(0.22, Math.min(1, (tp - 3) / 14));
const pt = (deg: number, r: number): [number, number] => [C + r * Math.cos(rad(deg)), C + r * Math.sin(rad(deg))];
const hash = (n: number) => { const x = Math.sin(n * 9301 + 49297) * 233280; return x - Math.floor(x); };
const windowArc = arc<{ from: number; to: number }>().innerRadius(R + 3).outerRadius(R + 8).startAngle((d) => (d.from * Math.PI) / 180).endAngle((d) => ((d.to - d.from + 360) % 360 + d.from) * Math.PI / 180);

export default function PolarRadar({ trains, facingDeg, window: win, title, sub }: Props) {
  const blooms = trains.map((t, i) => {
    const hsFt = t.hs * 3.28084, e = swellEnergy(hsFt, t.tp), col = rgbToHex(swellColor(hsFt, t.tp));
    const r = rOf(t.tp), radius = 6 + 16 * Math.min(1, hsFt / 6);
    if (t.kind === "windsea") {   // scattered dots across a ±28° spread
      const n = 7 + Math.round(6 * Math.min(1, hsFt / 4));
      return { key: i, col, e, dots: Array.from({ length: n }, (_, k) => { const [x, y] = pt(t.dp + (hash(i * 31 + k) - 0.5) * 56, r * (0.75 + 0.45 * hash(i * 17 + k))); return { x, y, rr: 1.6 + 2.2 * hash(i * 7 + k) }; }) };
    }
    const [x, y] = pt(t.dp, r); return { key: i, col, e, bloom: { x, y, radius } };
  });
  const [fx, fy] = pt(facingDeg, R + 5);
  return (
    <div aria-label="Swell radar" style={{ display: "flex", flexDirection: "column", gap: 2, height: "100%", fontFamily: "'Barlow', system-ui, sans-serif", color: "#e8eef2" }}>
      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase" }}>{title}</div>
      <div style={{ fontSize: 8, color: "#9fb1bc", letterSpacing: ".06em", textTransform: "uppercase" }}>{sub}</div>
      <svg viewBox="0 0 200 200" style={{ display: "block", flex: 1, minHeight: 0, width: "100%" }}>
        <defs>
          <filter id="radar-blur" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="4" /></filter>
          <radialGradient id="radar-bg" cx="50%" cy="50%" r="50%"><stop offset="0%" stopColor="#0b192c" stopOpacity="0.9" /><stop offset="100%" stopColor="#0b192c" stopOpacity="0.2" /></radialGradient>
          {blooms.map((b) => (
            <radialGradient key={b.key} id={`bloom-${b.key}`} cx="50%" cy="50%" r="50%"><stop offset="0%" stopColor="#ffffff" stopOpacity={0.95} /><stop offset="35%" stopColor={b.col} stopOpacity={0.9} /><stop offset="100%" stopColor={b.col} stopOpacity={0} /></radialGradient>))}
        </defs>
        <circle cx={C} cy={C} r={R} fill="url(#radar-bg)" stroke="rgba(255,255,255,.14)" />
        {[6, 10, 14].map((tp) => <g key={tp}><circle cx={C} cy={C} r={rOf(tp)} fill="none" stroke="rgba(255,255,255,.10)" strokeDasharray="2 3" /><text x={C + 2} y={C - rOf(tp) - 2} fontSize={7} fill="#9fb1bc">{tp} s</text></g>)}
        {Array.from({ length: 36 }, (_, i) => i * 10).map((d) => { const [x1, y1] = pt(d, R), [x2, y2] = pt(d, R - (d % 90 === 0 ? 8 : d % 30 === 0 ? 5 : 2.5)); return <line key={d} x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(255,255,255,.35)" strokeWidth={d % 90 === 0 ? 1.2 : 0.7} />; })}
        {[["N", 0], ["E", 90], ["S", 180], ["W", 270]].map(([l, d]) => { const [x, y] = pt(d as number, R + 14); return <text key={l} x={x} y={y + 3} fontSize={9} fontWeight={700} fill="#e8eef2" textAnchor="middle">{l}</text>; })}
        <path d={windowArc({ from: win.from_deg, to: win.to_deg }) ?? ""} transform={`translate(${C},${C})`} fill="#00E5FF" fillOpacity={0.35} />
        <circle cx={fx} cy={fy} r={3.2} fill="#ffffff" stroke="#0e2029" strokeWidth={1} />
        {blooms.map((b) => b.bloom ? (
          <g key={b.key}>
            <circle cx={b.bloom.x} cy={b.bloom.y} r={b.bloom.radius * 1.6} fill={b.col} fillOpacity={0.35 + 0.4 * b.e} filter="url(#radar-blur)" />
            <circle cx={b.bloom.x} cy={b.bloom.y} r={b.bloom.radius} fill={`url(#bloom-${b.key})`} />
          </g>) : (
          <g key={b.key} filter="url(#radar-blur)">{b.dots.map((d, k) => <circle key={k} cx={d.x} cy={d.y} r={d.rr} fill={b.col} fillOpacity={0.85} />)}</g>))}
        {trains.length === 0 && <text x={C} y={C + 3} fontSize={8} fill="#9fb1bc" textAnchor="middle">no swell partitions</text>}
      </svg>
    </div>
  );
}

"use client";
import type { TideStation } from "@/lib/cache";
import type { ForecastPoint } from "@/lib/forecast";

const COL = { red: "#e5484d", yellow: "#f5c400", green: "#2fbf71" };
const fmtDay = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "numeric", day: "numeric", timeZone: "America/New_York" });
const dayOf = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

/** 7-day strip: score bars, face height, wind, tide. Pure SVG, scales with its container. */
export default function ForecastChart({ points, tide, selected, onSelect }:
  { points: ForecastPoint[]; tide: TideStation | null; selected?: number; onSelect?: (i: number) => void }) {
  if (!points.length) return null;
  const W = 900, PAD = 36, rows = { score: [0, 70], face: [84, 150], wind: [164, 214], tide: [228, 278] } as const;
  const H = 292;
  const t0 = Date.parse(points[0].valid_time), t1 = Date.parse(points[points.length - 1].valid_time);
  const x = (iso: string) => PAD + ((Date.parse(iso) - t0) / (t1 - t0)) * (W - 2 * PAD);
  const slot = (W - 2 * PAD) / Math.max(1, points.length - 1);

  const maxFace = Math.max(3, ...points.map((p) => p.result.face_ft));
  const maxWind = Math.max(15, ...points.map((p) => p.cond.wind?.speed_kts ?? 0));
  const tideSeries = (tide?.series ?? []).filter((s) => { const t = Date.parse(s.t); return t >= t0 - 3.6e6 && t <= t1 + 3.6e6; });
  const tMin = Math.min(...tideSeries.map((s) => s.v), 0), tMax = Math.max(...tideSeries.map((s) => s.v), 1);

  const y = (row: readonly [number, number], v: number, max: number, min = 0) => row[1] - ((v - min) / (max - min)) * (row[1] - row[0]);
  const line = (vals: Array<[number, number] | null>) => vals.filter((v): v is [number, number] => !!v).map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join(" ");

  // day boundaries
  const days: Array<{ k: string; x0: number; label: string }> = [];
  for (const p of points) {
    const k = dayOf.format(new Date(p.valid_time));
    if (!days.length || days[days.length - 1].k !== k) days.push({ k, x0: x(p.valid_time), label: fmtDay.format(new Date(p.valid_time)) });
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full select-none" role="img" aria-label="Seven day forecast">
      {days.map((d, i) => (
        <g key={d.k}>
          <line x1={d.x0} x2={d.x0} y1={0} y2={H} stroke="#e2e8f0" />
          <text x={d.x0 + 4} y={H - 4} fontSize={11} fill="#475569">{d.label}</text>
          {i % 2 === 1 && <rect x={d.x0} y={0} width={(days[i + 1]?.x0 ?? W - PAD) - d.x0} height={H - 16} fill="#f8fafc" />}
        </g>
      ))}
      <text x={2} y={rows.score[0] + 10} fontSize={10} fill="#64748b">score</text>
      {points.map((p, i) => (
        <rect key={p.valid_time} x={x(p.valid_time) - slot * 0.4} width={slot * 0.8}
          y={y(rows.score, p.result.score, 100)} height={rows.score[1] - y(rows.score, p.result.score, 100)}
          fill={COL[p.result.color]} opacity={selected === i ? 1 : 0.75} stroke={selected === i ? "#0f172a" : "none"}
          onClick={() => onSelect?.(i)} style={{ cursor: onSelect ? "pointer" : "default" }} />
      ))}
      <text x={2} y={rows.face[0] + 10} fontSize={10} fill="#64748b">face ft</text>
      <path d={line(points.map((p) => [x(p.valid_time), y(rows.face, p.result.face_ft, maxFace)]))} fill="none" stroke="#1d4ed8" strokeWidth={2} />
      <text x={W - PAD + 4} y={y(rows.face, maxFace, maxFace) + 4} fontSize={10} fill="#64748b">{maxFace.toFixed(0)}</text>
      <text x={2} y={rows.wind[0] + 10} fontSize={10} fill="#64748b">wind kt</text>
      <path d={line(points.map((p) => (p.cond.wind ? [x(p.valid_time), y(rows.wind, p.cond.wind.speed_kts, maxWind)] : null)))} fill="none" stroke="#7c3aed" strokeWidth={1.5} />
      {points.map((p, i) => p.cond.wind && i % 2 === 0 ? (
        <g key={p.valid_time} transform={`translate(${x(p.valid_time)},${rows.wind[1] - 6}) rotate(${p.cond.wind.dir_from_deg + 180})`}>
          <path d="M0,-5 L3,2 L0,0 L-3,2 Z" fill="#7c3aed" />
        </g>) : null)}
      <text x={2} y={rows.tide[0] + 10} fontSize={10} fill="#64748b">tide m</text>
      {tideSeries.length > 1 && (
        <path d={line(tideSeries.map((s) => [x(s.t), y(rows.tide, s.v, tMax, tMin)]))} fill="none" stroke="#0891b2" strokeWidth={1.5} />
      )}
      {selected !== undefined && points[selected] && (
        <line x1={x(points[selected].valid_time)} x2={x(points[selected].valid_time)} y1={0} y2={H - 16} stroke="#0f172a" strokeDasharray="3 3" />
      )}
    </svg>
  );
}

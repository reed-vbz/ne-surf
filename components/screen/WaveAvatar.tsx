"use client";
/**
 * Wave profile avatar: a side-on breaking wave drawn to scale against a 1.75 m human silhouette. Height follows the
 * forecast face height; the lip's curl (hollow barrel vs crumbling mush) follows swell period and the wind's
 * alignment with the beach — offshore winds hold the face up and pitch the lip, onshore winds crumble it.
 */
import { useId } from "react";

export type WindLabel = "offshore" | "glassy" | "cross" | "cross-off" | "cross-on" | "onshore" | "unknown";
interface Props { faceFt: number; tpS: number | null; wind: WindLabel; width?: number }
const HUMAN_M = 1.75;

/** 0 = mushy crumbler, 1 = square barrel */
export function hollowness(tpS: number | null, wind: WindLabel): number {
  const period = tpS == null ? 0.35 : Math.max(0, Math.min(1, (tpS - 5) / 9));
  const w = { offshore: 0.32, glassy: 0.22, "cross-off": 0.12, cross: 0, "cross-on": -0.15, onshore: -0.32, unknown: 0 }[wind];
  return Math.max(0, Math.min(1, 0.2 + 0.55 * period + w));
}
export const shapeWord = (h: number) => (h >= 0.72 ? "Hollow" : h >= 0.45 ? "Clean" : h >= 0.28 ? "Soft" : "Mushy");

export default function WaveAvatar({ faceFt, tpS, wind, width = 300 }: Props) {
  const id = useId();
  const H = Math.max(0.3, faceFt * 0.3048), hol = hollowness(tpS, wind);
  const W = 300, VH = 120, base = 104, scale = 84 / Math.max(2.4, H + 0.6);   // px per metre; the frame fits the taller of wave / human
  const h = H * scale, hp = HUMAN_M * scale;
  const px = 150, lipX = px + 26 * hol + 8, lipY = base - h * (0.62 - 0.32 * hol);   // lip throws further and pitches lower when hollow
  const face = `M 12 ${base} C 60 ${base} ${px - 70} ${base - h * 0.15} ${px - 34} ${base - h * 0.72} C ${px - 18} ${base - h * 0.98} ${px + 2} ${base - h - 2} ${px + 14} ${base - h}` +
    ` C ${px + 24 + 18 * hol} ${base - h} ${lipX + 6 * hol} ${lipY - 8 * hol} ${lipX} ${lipY}` +
    ` C ${lipX - 10 * hol} ${lipY + 10 * (1 - hol)} ${px + 4} ${base - h * (0.4 + 0.3 * hol)} ${px + 20 + 30 * hol} ${base}` + ` L 12 ${base} Z`;
  const foam = hol < 0.45 ? Array.from({ length: 6 }, (_, i) => ({ cx: px + 6 + i * 9, cy: base - h * 0.7 + (i % 2) * 6, r: 5 + (i % 3) * 2 })) : [];
  const hx = W - 44;
  return (
    <svg viewBox={`0 0 ${W} ${VH}`} width={width} style={{ display: "block", maxWidth: "100%" }} role="img" aria-label={`${faceFt.toFixed(1)} foot ${shapeWord(hol).toLowerCase()} wave next to a person`}>
      <defs>
        <linearGradient id={`${id}-face`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#dff9ff" stopOpacity={0.95} /><stop offset="35%" stopColor="#00E5FF" stopOpacity={0.85} /><stop offset="100%" stopColor="#0B4A7A" stopOpacity={0.95} /></linearGradient>
        <linearGradient id={`${id}-sea`} x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stopColor="#0B192C" /><stop offset="100%" stopColor="#0a3d63" /></linearGradient>
        <filter id={`${id}-glow`} x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="3" /></filter>
      </defs>
      <rect x={0} y={base} width={W} height={VH - base} fill={`url(#${id}-sea)`} />
      <path d={face} fill="#00E5FF" fillOpacity={0.35} filter={`url(#${id}-glow)`} />
      <path d={face} fill={`url(#${id}-face)`} stroke="#bff6ff" strokeWidth={1} strokeLinejoin="round" />
      {foam.map((f, i) => <circle key={i} cx={f.cx} cy={f.cy} r={f.r} fill="#ffffff" fillOpacity={0.85} />)}
      {/* height gauge */}
      <line x1={px + 44} x2={px + 44} y1={base} y2={base - h} stroke="rgba(255,255,255,.5)" strokeDasharray="2 2" />
      <text x={px + 48} y={base - h + 4} fontSize={10} fontWeight={700} fill="#ffffff">{faceFt.toFixed(1)} ft</text>
      {/* human silhouette, 1.75 m */}
      <g transform={`translate(${hx},${base}) scale(${hp / 100})`} fill="#e8eef2">
        <circle cx={0} cy={-90} r={9} />
        <path d="M-9 -78 L9 -78 L11 -40 L6 -40 L6 0 L1 0 L0 -32 L-1 0 L-6 0 L-6 -40 L-11 -40 Z" />
      </g>
      <text x={hx} y={VH - 2} fontSize={8} fill="#9fb1bc" textAnchor="middle">1.75 m</text>
      <text x={12} y={base - 6} fontSize={10} fontWeight={700} letterSpacing=".06em" fill="#ffffff">{shapeWord(hol).toUpperCase()}</text>
    </svg>
  );
}

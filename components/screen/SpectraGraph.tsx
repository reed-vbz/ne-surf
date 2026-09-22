"use client";
/**
 * Buoy swell spectra graph (widget dock card; the page wraps it in dockCard): wave energy across wave period. Observed NDBC spectral density from the nearest
 * buoy when it reports one, otherwise the WW3 partitions at the break synthesised onto the same axis (labelled MODEL).
 * Bars are coloured by period (chop white → groundswell cyan/blue, matching the map's particle layers); a smoothed area
 * (d3-shape, monotone) rides over the bars.
 */
import { area, curveMonotoneX } from "d3-shape";
import type { NdbcBuoy } from "@/lib/cache";
import type { SwellTrain } from "@/lib/quality/types";
import { hsFromSpectrum, modelledSpectrum, observedSpectrum, PERIODS, type SpectrumBin } from "@/lib/spectra";

interface Props { buoy: { id: string; obs: NdbcBuoy | null } | null; trains: SwellTrain[]; spotName: string; hourLabel: string }
const W = 200, H = 120, PL = 8, PR = 6, PT = 10, PB = 18;
const barColor = (T: number) => (T < 7 ? "#ffffff" : T < 9 ? "#7FF6FF" : T < 12 ? "#00E5FF" : T < 15 ? "#2F8CFF" : "#3B4CFF");

export default function SpectraGraph({ buoy, trains, spotName, hourLabel }: Props) {
  const sp = buoy?.obs?.spectrum;
  const observed = !!(sp && sp.freqs_hz.length && buoy?.obs?.status === "ok");
  const bins: SpectrumBin[] = observed ? observedSpectrum(sp!.freqs_hz, sp!.density_m2_hz) : modelledSpectrum(trains);
  const max = Math.max(1e-4, ...bins.map((b) => b.energy));
  const x = (T: number) => PL + ((T - PERIODS[0]) / (PERIODS[PERIODS.length - 1] - PERIODS[0])) * (W - PL - PR);
  const y = (e: number) => H - PB - (e / max) * (H - PT - PB);
  const bw = (W - PL - PR) / PERIODS.length;
  const curve = area<SpectrumBin>().x((d) => x(d.period)).y0(H - PB).y1((d) => y(d.energy)).curve(curveMonotoneX)(bins) ?? "";
  const peak = bins.reduce((b, d) => (d.energy > b.energy ? d : b), bins[0]);
  const hs = hsFromSpectrum(bins) * 3.28084;
  const when = observed ? new Date(sp!.time).toLocaleTimeString("en-US", { hour: "numeric", timeZone: "America/New_York" }) : hourLabel;
  return (
    <div aria-label="Swell spectra" style={{ display: "flex", flexDirection: "column", gap: 2, height: "100%", fontFamily: "'Barlow', system-ui, sans-serif", color: "#e8eef2" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase" }}>Swell spectra</span>
        <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: ".08em", padding: "1px 5px", borderRadius: 999, background: observed ? "rgba(65,199,118,.18)" : "rgba(255,255,255,.08)", color: observed ? "#41c776" : "#b8c7d1" }}>{observed ? `BUOY ${buoy!.id}` : "MODEL"}</span>
      </div>
      <div style={{ fontSize: 8, color: "#9fb1bc", letterSpacing: ".06em", textTransform: "uppercase", marginBottom: 2 }}>{observed ? `${buoy!.id} · ${when}` : `${spotName} · ${when}`}</div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: "block", flex: 1, minHeight: 0, width: "100%" }}>
        <defs><linearGradient id="spectra-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#00E5FF" stopOpacity={0.45} /><stop offset="100%" stopColor="#00E5FF" stopOpacity={0.02} /></linearGradient></defs>
        {bins.map((b) => <rect key={b.period} x={x(b.period) - bw * 0.36} y={y(b.energy)} width={bw * 0.72} height={Math.max(0, H - PB - y(b.energy))} rx={1.5} fill={barColor(b.period)} fillOpacity={0.75} />)}
        <path d={curve} fill="url(#spectra-area)" stroke="#dff7ff" strokeWidth={1.2} strokeOpacity={0.9} />
        {[4, 8, 12, 16, 20].map((T) => <text key={T} x={x(T)} y={H - 6} fontSize={8} fill="#9fb1bc" textAnchor="middle">{T}s</text>)}
        <line x1={PL} x2={W - PR} y1={H - PB} y2={H - PB} stroke="rgba(255,255,255,.18)" />
        {peak.energy > 0 && <text x={Math.min(W - PR - 26, Math.max(PL + 26, x(peak.period)))} y={Math.max(9, y(peak.energy) - 3)} fontSize={8} fontWeight={700} fill="#ffffff" textAnchor="middle">peak {peak.period} s</text>}
        {trains.filter((t) => t.hs > 0).map((t, i) => { const tx = x(Math.max(3, Math.min(21, t.tp))); return <path key={i} d={`M${tx},${PT} L${tx - 3},${PT - 6} L${tx + 3},${PT - 6} Z`} fill={t.kind === "windsea" ? "#ffffff" : "#00E5FF"} fillOpacity={0.9} />; })}
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 8, color: "#b8c7d1" }}>
        <span>Hs {hs.toFixed(1)} ft</span>
        <span><span style={{ color: "#ffffff" }}>▲</span> chop <span style={{ color: "#00E5FF" }}>▲</span> swell</span>
      </div>
    </div>
  );
}

"use client";
/**
 * Buoy swell spectra graph (widget dock card; the page wraps it in dockCard): wave energy across wave period. Observed NDBC spectral density from the nearest
 * buoy when it reports one, otherwise the WW3 partitions at the break synthesised onto the same axis (labelled MODEL).
 * Bars are coloured by period (chop white → groundswell cyan/blue, matching the map's particle layers); a smoothed area
 * (d3-shape, monotone) rides over the bars.
 */
import { useEffect, useRef, useState } from "react";
import { area, curveMonotoneX } from "d3-shape";
import { fresh, type NdbcBuoy } from "@/lib/cache";
import type { SwellTrain } from "@/lib/quality/types";
import { forecastTime } from "@/lib/display";
import { hsFromSpectrum, spectrumVariance, validSpectrum, modelledSpectrum, observedSpectrum, PERIODS, type SpectrumBin } from "@/lib/spectra";

interface Props { buoy: { id: string; obs: NdbcBuoy | null } | null; trains: SwellTrain[]; spotName: string; hourLabel: string; now: number }
const PL = 32, PR = 10, PT = 18, PB = 20;
const barColor = (T: number) => (T < 7 ? "#ffffff" : T < 9 ? "#7FF6FF" : T < 12 ? "#00E5FF" : T < 15 ? "#2F8CFF" : "#3B4CFF");

export default function SpectraGraph({ buoy, trains, spotName, hourLabel, now }: Props) {
  const svg = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ width: 200, height: 120 });
  useEffect(() => {
    if (!svg.current) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.max(120, Math.round(entry.contentRect.width)), height = Math.max(60, Math.round(entry.contentRect.height));
      setSize((s) => s.width === width && s.height === height ? s : { width, height });
    });
    observer.observe(svg.current); return () => observer.disconnect();
  }, []);
  const W = size.width, H = size.height;
  const sp = buoy?.obs?.spectrum;
  const observed = !!(sp && validSpectrum(sp.freqs_hz, sp.density_m2_hz) && fresh(sp.time, 3, now));
  const bins: SpectrumBin[] = observed ? observedSpectrum(sp!.freqs_hz, sp!.density_m2_hz) : modelledSpectrum(trains);
  const max = Math.max(1e-4, ...bins.map((b) => b.energy));
  const x = (T: number) => PL + ((T - PERIODS[0]) / (PERIODS[PERIODS.length - 1] - PERIODS[0])) * (W - PL - PR);
  const y = (e: number) => H - PB - (e / max) * (H - PT - PB);
  const bw = (W - PL - PR) / PERIODS.length;
  const curve = area<SpectrumBin>().x((d) => x(d.period)).y0(H - PB).y1((d) => y(d.energy)).curve(curveMonotoneX)(bins) ?? "";
  const peak = bins.reduce((b, d) => (d.energy > b.energy ? d : b), bins[0]);
  const bandHs = hsFromSpectrum(bins) * 3.28084;
  const hs = observed ? 4 * Math.sqrt(spectrumVariance(sp!.freqs_hz, sp!.density_m2_hz)!) * 3.28084 : Math.hypot(...trains.map((t) => t.hs)) * 3.28084;
  const when = observed ? `${forecastTime(sp!.time)} · ${Math.max(0, Math.round((now - Date.parse(sp!.time)) / 60000))}m ago` : hourLabel;
  return (
    <div aria-label="Swell spectra" style={{ display: "flex", flexDirection: "column", gap: 2, height: "100%", fontFamily: "'Barlow', system-ui, sans-serif", color: "#e8eef2" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase" }}>Swell spectra</span>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".08em", padding: "1px 5px", borderRadius: 999, background: observed ? "rgba(65,199,118,.18)" : "rgba(255,255,255,.08)", color: observed ? "#41c776" : "#b8c7d1" }}>{observed ? `BUOY ${buoy!.id}` : "MODEL EST."}</span>
      </div>
      <div style={{ fontSize: 11, color: "#9fb1bc", letterSpacing: ".06em", textTransform: "uppercase", marginBottom: 2 }}>{observed ? `Latest observed · ${when}` : `${spotName} · ${when}`}</div>
      <svg ref={svg} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: "block", flex: 1, minHeight: 0, width: "100%" }}>
        <defs><linearGradient id="spectra-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#00E5FF" stopOpacity={0.45} /><stop offset="100%" stopColor="#00E5FF" stopOpacity={0.02} /></linearGradient></defs>
        {bins.map((b) => <rect key={b.period} x={x(b.period) - bw * 0.36} y={y(b.energy)} width={bw * 0.72} height={Math.max(0, H - PB - y(b.energy))} rx={1.5} fill={barColor(b.period)} fillOpacity={0.75} />)}
        <path d={curve} fill="url(#spectra-area)" stroke="#dff7ff" strokeWidth={1.2} strokeOpacity={0.9} />
        {[4, 8, 12, 16, 20].map((T) => <text key={T} x={x(T)} y={H - 6} fontSize={10} fill="#9fb1bc" textAnchor="middle">{T}s</text>)}
        <text x={PL - 3} y={PT + 4} fontSize={10} fill="#b8c7d1" textAnchor="end">{max.toFixed(max < 0.1 ? 3 : 2)}</text>
        <text x={PL - 3} y={H - PB} fontSize={10} fill="#b8c7d1" textAnchor="end">0</text>
        <line x1={PL} x2={W - PR} y1={H - PB} y2={H - PB} stroke="rgba(255,255,255,.18)" />
        {peak.energy > 0 && <text x={Math.min(W - PR - 26, Math.max(PL + 26, x(peak.period)))} y={Math.max(9, y(peak.energy) - 3)} fontSize={10} fontWeight={700} fill="#ffffff" textAnchor="middle">peak {peak.period} s</text>}
        {!observed && trains.filter((t) => t.hs > 0).map((t, i) => { const tx = x(Math.max(3, Math.min(21, t.tp))); return <path key={i} d={`M${tx},${PT} L${tx - 3},${PT - 6} L${tx + 3},${PT - 6} Z`} fill={t.kind === "windsea" ? "#ffffff" : "#00E5FF"} fillOpacity={0.9} />; })}
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#b8c7d1" }}>
        <span title={`Displayed 2.5–21.5 s band Hs ${bandHs.toFixed(2)} ft; bars show m² per 1 s period bin`}>Total Hs {hs.toFixed(1)} ft</span>
        <span>Variance · m²/bin</span>
      </div>
    </div>
  );
}

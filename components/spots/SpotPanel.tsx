"use client";
import Link from "next/link";
import { buoyFresh, type BathySpot, type NdbcBuoy } from "@/lib/cache";
import { faceLabel } from "@/lib/display";
import { BAND_LABEL, type ScoreBreakdown, type Spot, type Conditions } from "@/lib/quality";

const COLORS = { grey: "bg-slate-500", yellow: "bg-[#ffd23f] text-[#0b1526]", green: "bg-[#3ddc84] text-[#0b1526]" };
const compass = (d: number) => ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(d / 22.5) % 16];
const ft = (m: number) => (m * 3.28084).toFixed(1);

function Bar({ label, v }: { label: string; v: number }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-14 text-slate-500">{label}</span>
      <div className="h-2 flex-1 rounded bg-white/10"><div className="h-2 rounded bg-cyan-400" style={{ width: `${Math.round(v * 100)}%` }} /></div>
      <span className="w-8 text-right tabular-nums text-slate-300">{Math.round(v * 100)}</span>
    </div>
  );
}

function Profile({ b }: { b: BathySpot }) {
  const pts = (b.profile ?? []).filter((p): p is [number, number] => p[1] != null);
  if (pts.length < 3) return null;
  const W = 260, H = 60, maxD = Math.max(...pts.map((p) => p[1]), 1), maxX = pts[pts.length - 1][0];
  const path = pts.map(([x, d], i) => `${i ? "L" : "M"}${(x / maxX) * W},${(d / maxD) * H}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-1 h-16 w-full">
      <path d={`${path} L${W},${H} L0,${H} Z`} fill="rgba(34,211,238,.25)" />
      <path d={path} stroke="#22d3ee" strokeWidth={1.5} fill="none" />
      <text x={2} y={10} fontSize={9} fill="#94a3b8">0 m</text>
      <text x={W - 2} y={H - 2} fontSize={9} fill="#94a3b8" textAnchor="end">{maxD.toFixed(0)} m deep at {maxX / 1000} km</text>
    </svg>
  );
}

export default function SpotPanel({ spot, result, cond, buoys, bathy, onClose, hideClose = false }:
  { spot: Spot; result: ScoreBreakdown; cond: Conditions; buoys: Array<[string, NdbcBuoy | undefined]>; bathy: BathySpot | null; onClose: () => void; hideClose?: boolean }) {
  return (
    <aside className="flex h-full flex-col gap-4 overflow-y-auto rounded-xl border border-white/10 bg-[#0b1526]/92 p-4 text-slate-200 shadow-2xl backdrop-blur">
      <header className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold uppercase leading-tight tracking-wide text-white">{spot.name}</h2>
          <p className="text-xs text-slate-400">{spot.area ?? spot.state} · {spot.break_type} · faces {compass(spot.facing_deg)}</p>
        </div>
        {!hideClose && <button onClick={onClose} className="rounded-md px-2 py-1 text-slate-400 hover:bg-white/10" aria-label="Close">✕</button>}
      </header>

      <div className="flex items-center gap-3">
        <div className={`grid h-16 w-16 place-items-center rounded-2xl text-2xl font-bold text-white ${COLORS[result.color]}`}>{result.score}</div>
        <div>
          <div className="font-semibold text-white">{BAND_LABEL[result.band]}</div>
          <div className="text-sm text-slate-300">{faceLabel(result.available === false ? null : result.face_ft)} estimated faces</div>
          <div className="text-[11px] text-slate-500">
            deep water {result.usable_hs_m.toFixed(1)} m usable · {result.nearshore.breaker}{result.nearshore.xi !== null ? ` (ξ ${result.nearshore.xi.toFixed(2)})` : ""}
          </div>
        </div>
      </div>

      {!hideClose && <Link href={`/spots/${spot.id}`} className="text-xs font-semibold uppercase tracking-wider text-cyan-300 hover:underline">7-day forecast →</Link>}

      {result.reasons.length > 0 && (
        <ul className="space-y-1 text-sm text-slate-300">{result.reasons.map((r) => <li key={r}>• {r}</li>)}</ul>
      )}

      <section className="space-y-1.5">
        <Bar label="angle" v={result.components.swell_angle} />
        <Bar label="size" v={result.components.swell_size} />
        <Bar label="period" v={result.components.swell_period} />
        <Bar label="wind" v={result.components.wind} />
        <Bar label="tide" v={result.components.tide} />
      </section>

      <section className="text-xs text-slate-300">
        <h3 className="mb-1 font-semibold uppercase tracking-wider text-slate-100">Swell trains (deep water)</h3>
        {cond.trains.length === 0 ? <p className="text-slate-500">none</p> : (
          <table className="w-full"><tbody>
            {cond.trains.map((t, i) => (
              <tr key={i} className={t === result.dominant ? "font-semibold" : ""}>
                <td>{t.kind === "windsea" ? "wind sea" : `swell ${i + 1}`}</td>
                <td className="tabular-nums">{ft(t.hs)} ft</td><td className="tabular-nums">{t.tp.toFixed(0)} s</td>
                <td className="tabular-nums">{compass(t.dp)} {Math.round(t.dp)}°</td>
              </tr>))}
          </tbody></table>)}
      </section>

      <section className="grid grid-cols-2 gap-2 text-xs text-slate-300">
        <div><div className="font-semibold uppercase tracking-wider text-slate-100">Wind</div>
          {cond.wind ? `${cond.wind.speed_kts.toFixed(0)} kt from ${compass(cond.wind.dir_from_deg)}` : "n/a"}
          <div className="text-slate-500">offshore = {compass(spot.wind.offshore_deg)}</div></div>
        <div><div className="font-semibold uppercase tracking-wider text-slate-100">Tide</div>
          {cond.tide ? `${cond.tide.state} · ${cond.tide.phase} · ${cond.tide.height_m.toFixed(2)} m` : "n/a"}
          <div className="text-slate-500">likes {spot.tide.preferred.join("/")}{spot.tide.avoid?.length ? `, avoid ${spot.tide.avoid.join("/")}` : ""}</div></div>
      </section>

      {bathy && (
        <section className="text-xs text-slate-300">
          <h3 className="font-semibold uppercase tracking-wider text-slate-100">Bottom (NOAA CRM)</h3>
          <div>slope {bathy.slope_tan !== null ? `1:${Math.round(1 / bathy.slope_tan)}` : "n/a"} · {bathy.quality}{bathy.has_bar ? " · sandbar" : ""}
            {bathy.marker_note && bathy.marker_note !== "marker at shoreline" ? ` · ${bathy.marker_note}` : ""}</div>
          <Profile b={bathy} />
        </section>
      )}
      {cond.calibration && (
        <p className="text-[11px] text-slate-500">
          Model Hs ×{cond.calibration.applied.toFixed(2)} from buoy {cond.calibration.buoy} ({cond.calibration.n_pairs} pairs{cond.calibration.low_confidence ? ", low confidence" : ""})
        </p>
      )}
      <section className="text-xs text-slate-300">
        <h3 className="mb-1 font-semibold uppercase tracking-wider text-slate-100">Associated buoys · latest observed</h3>
        {buoys.map(([id, b]) => (
          <div key={id} className="flex justify-between">
            <span>{id}</span>
            <span className="tabular-nums text-slate-300">
              {!b ? "no data" : !buoyFresh(b) ? "stale or unavailable" : `${ft(b.wvht_m ?? 0)} ft @ ${b.dpd_s ?? "–"} s ${b.mwd_deg != null ? compass(b.mwd_deg) : ""}`}
            </span>
          </div>))}
      </section>

      {spot.confidence === "approximate" && (
        <p className="rounded-md bg-amber-400/10 p-2 text-[11px] text-amber-200">
          Location, facing, exposure and shadows were chart-checked ({spot.verification?.date ?? "see docs"}); size, wind and tide
          preferences are still hand-entered. Edit <code>data/spots.json</code> to improve it.
        </p>
      )}
    </aside>
  );
}

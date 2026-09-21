"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import ForecastChart from "@/components/spots/ForecastChart";
import SpotPanel from "@/components/spots/SpotPanel";
import { bestWindow, byDay, forecastFor } from "@/lib/forecast";
import { BAND_LABEL } from "@/lib/quality";
import { spotById } from "@/lib/spots";
import { useForecastData } from "@/lib/useForecastData";

const fmtTime = new Intl.DateTimeFormat("en-US", { weekday: "short", hour: "numeric", timeZone: "America/New_York" });
const fmtDay = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "America/New_York" });
const compass = (d: number) => ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(d / 22.5) % 16];
const DOT = { grey: "bg-slate-400", yellow: "bg-yellow-400", green: "bg-emerald-500" };

export default function SpotView({ id }: { id: string }) {
  const spot = spotById(id);
  const data = useForecastData();
  const [sel, setSel] = useState(0);
  const points = useMemo(() => (spot ? forecastFor(spot, data) : []), [spot, data]);

  if (!spot) return <main className="p-8"><h1 className="text-xl font-semibold">Unknown spot</h1><Link className="underline" href="/">Back to the map</Link></main>;
  const best = bestWindow(points);
  const days = byDay(points);
  const cur = points[sel];

  return (
    <main className="mx-auto max-w-5xl p-4 md:p-8">
      <nav className="mb-4 text-sm text-slate-500"><Link href="/" className="hover:underline">← Map</Link></nav>
      <header className="mb-4">
        <h1 className="text-2xl font-bold text-slate-900">{spot.name}</h1>
        <p className="text-sm text-slate-500">{spot.area ?? spot.state} · {spot.break_type} · faces {compass(spot.facing_deg)} · {spot.skill ?? ""}</p>
        {data.error && <p className="mt-2 rounded bg-red-50 p-2 text-sm text-red-800">{data.error}</p>}
        {best && (
          <p className="mt-2 text-sm text-slate-700">
            Best of the week: <span className="font-semibold">{fmtTime.format(new Date(best.valid_time))}</span> · {BAND_LABEL[best.result.band]} ({best.result.score}) · ~{best.result.face_ft.toFixed(0)} ft
          </p>
        )}
      </header>

      <section className="rounded-xl bg-white p-3 shadow">
        <ForecastChart points={points} tide={data.tides[spot.tide.station_id] ?? null} selected={sel} onSelect={setSel} />
        {cur && <p className="mt-1 text-xs text-slate-500">Selected: {fmtTime.format(new Date(cur.valid_time))} · click a bar to inspect it below</p>}
      </section>

      <div className="mt-4 grid gap-4 md:grid-cols-[1fr_20rem]">
        <section className="space-y-3">
          {days.map(({ day, points: pts, best: b }) => (
            <details key={day} className="rounded-xl bg-white p-3 shadow" open={pts.includes(cur)}>
              <summary className="flex cursor-pointer items-center gap-2 text-sm">
                <span className={`h-2.5 w-2.5 rounded-full ${DOT[b.result.color]}`} />
                <span className="font-semibold text-slate-900">{fmtDay.format(new Date(b.valid_time))}</span>
                <span className="text-slate-500">best {fmtTime.format(new Date(b.valid_time)).split(" ").slice(1).join(" ")} · {BAND_LABEL[b.result.band]} · ~{b.result.face_ft.toFixed(0)} ft</span>
              </summary>
              <table className="mt-2 w-full text-xs">
                <thead className="text-slate-500"><tr><th className="text-left">time</th><th>score</th><th>face</th><th>swell</th><th>wind</th><th>tide</th></tr></thead>
                <tbody>
                  {pts.map((p) => {
                    const i = points.indexOf(p); const d = p.result.dominant;
                    return (
                      <tr key={p.valid_time} onClick={() => setSel(i)} className={`cursor-pointer text-center hover:bg-slate-50 ${i === sel ? "bg-slate-100" : ""}`}>
                        <td className="text-left">{fmtTime.format(new Date(p.valid_time)).split(" ").slice(1).join(" ")}</td>
                        <td><span className={`inline-block rounded px-1.5 text-white ${DOT[p.result.color]}`}>{p.result.score}</span></td>
                        <td>{p.result.face_ft.toFixed(0)}–{(p.result.face_ft * 1.25).toFixed(0)} ft</td>
                        <td>{d ? `${(d.hs * 3.28).toFixed(1)} ft @ ${d.tp.toFixed(0)} s ${compass(d.dp)}` : "—"}</td>
                        <td>{p.cond.wind ? `${p.cond.wind.speed_kts.toFixed(0)} kt ${compass(p.cond.wind.dir_from_deg)}` : "—"}</td>
                        <td>{p.cond.tide ? `${p.cond.tide.state} ${p.cond.tide.phase === "rising" ? "↑" : "↓"}` : "—"}</td>
                      </tr>);
                  })}
                </tbody>
              </table>
            </details>
          ))}
        </section>
        <div className="md:sticky md:top-4 md:self-start">
          {cur && <SpotPanel spot={spot} result={cur.result} cond={cur.cond} bathy={data.bathy.spots[spot.id] ?? null}
            buoys={spot.buoys.map((b) => [b, data.ndbc?.buoys[b]])} onClose={() => {}} hideClose />}
        </div>
      </div>
    </main>
  );
}

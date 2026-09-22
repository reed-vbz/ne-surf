"use client";
import { useEffect, useState } from "react";
import bathyJson from "@/data/bathymetry.json";
import {
  CACHE_BASE, resolveDataSource, validGrid, fresh,
  loadCalibration, loadHrrrIndex, loadHrrrSpots, loadNdbc, loadTideStation, loadTidesIndex, loadWw3Index, loadWw3Spots,
  type Bathymetry, type HrrrIndex, type HrrrSpots, type NdbcLatest, type TideStation, type Ww3Index, type Ww3Spots,
} from "./cache";
import type { ForecastData } from "./forecast";
export const BATHY = bathyJson as unknown as Bathymetry;
export interface LoadedData extends ForecastData {
  ww3: { index: Ww3Index; spots: Ww3Spots } | null;
  hrrr: { index: HrrrIndex; spots: HrrrSpots } | null;
  ndbc: NdbcLatest | null; error: string | null; loading: boolean;
  base: string; revision: string; stale: boolean; checkedAt: number;
}
export function useForecastData(): LoadedData {
  const [state, setState] = useState<LoadedData>({ ww3: null, hrrr: null, tides: {}, cal: null, bathy: BATHY, ndbc: null, error: null, loading: true, base: CACHE_BASE, revision: "unversioned", stale: true, checkedAt: 0 });
  useEffect(() => {
    let live = true, busy = false;
    const refresh = async () => {
      if (busy) return; busy = true;
      try {
        const source = await resolveDataSource();
        const [wi, ws, hi, hs, cal, ndbc, ti] = await Promise.all([
          loadWw3Index(source.base), loadWw3Spots(source.base), loadHrrrIndex(source.base), loadHrrrSpots(source.base),
          loadCalibration(source.base), loadNdbc(source.base), loadTidesIndex(source.base),
        ]);
        if (!live) return;
        if (!validGrid(wi) || !ws || ws.cycle !== wi.cycle || !Array.isArray(ws.spots)) {
          setState((s) => ({ ...s, loading: false, stale: true, checkedAt: Date.now(), error: "Forecast unavailable. Retrying shortly." })); return;
        }
        const entries = await Promise.all((ti?.stations ?? []).map(async (st) => [st.id, await loadTideStation(st.id, source.base)] as const));
        const tides = Object.fromEntries(entries.filter(([, v]) => v && Array.isArray(v.hilo) && Array.isArray(v.series))) as Record<string, TideStation>;
        if (!live) return;
        setState({ ww3: { index: wi, spots: ws }, hrrr: validGrid(hi) && hs?.cycle === hi.cycle && Array.isArray(hs.spots) ? { index: hi, spots: hs } : null,
          tides, cal: cal?.cycle === wi.cycle ? cal : null, ndbc, bathy: BATHY, error: null, loading: false,
          ...source, stale: !fresh(wi.generated_at, 12), checkedAt: Date.now() });
      } catch { if (live) setState((s) => ({ ...s, error: "Forecast refresh failed. Retrying shortly.", loading: false, stale: true })); } finally { busy = false; }
    };
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 60_000);
    const visible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => { live = false; clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, []);
  return state;
}
export function hoursAgo(iso: string | undefined): number | null {
  if (!iso) return null;
  const age = (Date.now() - Date.parse(iso)) / 3_600_000;
  return Number.isFinite(age) ? age : null;
}

"use client";
import { useEffect, useState } from "react";
import bathyJson from "@/data/bathymetry.json";
import {
  loadCalibration, loadHrrrIndex, loadHrrrSpots, loadNdbc, loadTideStation, loadTidesIndex, loadWw3Index, loadWw3Spots,
  type Bathymetry, type Calibration, type HrrrIndex, type HrrrSpots, type NdbcLatest, type TideStation, type Ww3Index, type Ww3Spots,
} from "./cache";
import type { ForecastData } from "./forecast";

export const BATHY = bathyJson as unknown as Bathymetry;

export interface LoadedData extends ForecastData {
  ww3: { index: Ww3Index; spots: Ww3Spots } | null;
  hrrr: { index: HrrrIndex; spots: HrrrSpots } | null;
  ndbc: NdbcLatest | null;
  error: string | null;
  loading: boolean;
}

/** Loads every cache layer once per page. Optional layers resolve to null/empty and never block the map. */
export function useForecastData(): LoadedData {
  const [state, setState] = useState<LoadedData>({ ww3: null, hrrr: null, tides: {}, cal: null, bathy: BATHY, ndbc: null, error: null, loading: true });
  useEffect(() => {
    let live = true;
    (async () => {
      const [wi, ws] = await Promise.all([loadWw3Index(), loadWw3Spots()]);
      if (!live) return;
      if (!wi || !ws) { setState((s) => ({ ...s, loading: false, error: "No WW3 cache found. Run: npm run ingest" })); return; }
      setState((s) => ({ ...s, ww3: { index: wi, spots: ws }, loading: false }));
      const [hi, hs, cal, ndbc, ti] = await Promise.all([loadHrrrIndex(), loadHrrrSpots(), loadCalibration(), loadNdbc(), loadTidesIndex()]);
      if (!live) return;
      let tides: Record<string, TideStation> = {};
      if (ti) {
        const entries = await Promise.all(ti.stations.map(async (st) => [st.id, await loadTideStation(st.id)] as const));
        tides = Object.fromEntries(entries.filter(([, v]) => v) as Array<[string, TideStation]>);
      }
      if (!live) return;
      setState((s) => ({ ...s, hrrr: hi && hs ? { index: hi, spots: hs } : null, cal, ndbc, tides }));
    })();
    return () => { live = false; };
  }, []);
  return state;
}

export function hoursAgo(iso: string | undefined): number | null {
  if (!iso) return null;
  return (Date.now() - Date.parse(iso)) / 3_600_000;
}

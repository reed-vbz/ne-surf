# ne-surf — New England surf forecast (open source)

Free, open-source regional surf forecast for RI · MA · NH · ME.
Bounding box: **40.0°N–45.0°N, 72.5°W–66.0°W**.

## Folder layout

```
ne-surf/
├── README.md · LICENSE (MIT)
├── ops/                           # ingest.sh + launchd plist for a local 4×/day schedule
├── .github/workflows/ingest.yml   # cron: run the Python workers 4×/day, commit the JSON cache
│
├── app/                           # Next.js 16 App Router (client-rendered map page)
│   ├── layout.tsx
│   ├── page.tsx                   # the map + ranked list + spot panel + timeline
│   ├── spots/[id]/page.tsx        # 7-day chart + day tables for one spot
│   └── about/page.tsx             # methodology + sources
├── components/
│   ├── map/SurfMap.tsx            # MapLibre GL (OpenFreeMap tiles, no token): markers, wind raster, swell particles
│   ├── map/SwellParticles.tsx     # canvas particle advection along WW3 DIRPW
│   ├── spots/SpotPanel.tsx        # score breakdown, trains, wind, tide, bottom profile, live buoys
│   ├── spots/ForecastChart.tsx    # 7-day SVG strip: score, face, wind, tide
│   └── timeline/Timeline.tsx      # 0–168 h slider with play
├── lib/
│   ├── quality/                   # Surf Quality Score engine (TypeScript, pure functions, unit-tested)
│   │   ├── swellMatch.ts          # angle match + island shadowing
│   │   ├── windAlign.ts           # offshore / cross / onshore vector math
│   │   ├── tideWindow.ts          # tide state vs spot preference
│   │   └── score.ts               # weighted 0–100 + colour band
│   ├── spots.ts                   # zod-validated loader for data/spots.json
│   ├── cache.ts                   # typed readers for public/cache/* (all optional layers null-safe)
│   ├── conditions.ts              # cache records → Conditions (trains, wind, tide state/phase, calibration)
│   ├── forecast.ts                # whole-horizon series per spot, best window, by-day grouping
│   ├── useForecastData.ts         # one hook that loads every cache layer
│   └── grid.ts                    # flat-grid sampling, wind colour ramp, raster → data URL
│
├── data/
│   ├── spots.schema.json          # JSON Schema (draft 2020-12) for a surf spot  ← step 1
│   └── spots.json                 # the New England spot catalogue               ← step 1
│
├── public/cache/                  # SMALL JSON written by the workers, served statically by Next
│   ├── ww3/index.json             #   run metadata + list of steps
│   ├── ww3/steps/f000.json …      #   one gridded step per file (lazy-loaded by the slider)
│   ├── ww3/spots.json             #   per-spot deep-water time series (what the score engine reads)
│   ├── hrrr/{index,spots}.json + steps/fHH.json   # 10 m wind, 0–48 h hourly
│   ├── ndbc/latest.json           #   latest buoy obs + 24 h history, swell/wind-sea split
│   ├── tides/{index,<station>}.json #   8-day hi/lo + hourly curve + latest observed level
│   └── calibration/latest.json    #   per-buoy obs/model Hs ratio (rolling 14-day history.jsonl)
│
└── workers/                       # Python data pipeline (runs in GitHub Actions or any cron box)
    ├── pyproject.toml
    ├── .venv/                     # uv-managed, git-ignored
    └── nesurf/
        ├── __init__.py
        ├── common.py              # bbox, paths, HTTP session, GRIB decode, JSON writers  ← step 1
        ├── fetch_ww3.py           # GFS-Wave (WaveWatch III) deep-water swell            ← step 1
        ├── fetch_hrrr.py          # step 2
        ├── fetch_ndbc.py          # step 2
        └── fetch_tides.py         # step 2
```

Design rule: **Python writes small static JSON; Next.js only reads it.** No database, no
server-side model parsing at request time, so the whole thing hosts free on Vercel/Netlify
and the workers run free on GitHub Actions.

## Run it

No GitHub needed: `ops/ingest.sh` runs the whole pipeline locally and `ops/com.nesurf.ingest.plist` schedules it 4×/day with launchd (install notes inside the file).

```sh
npm install            # also copies the MapLibre worker into public/vendor/maplibre (postinstall)
npm run ingest         # ww3 + hrrr + ndbc + tides + calibrate → public/cache  (needs workers/.venv)
npm run bathy          # NOAA CRM transects → data/bathymetry.json (only when spots change)
npm run verify:spots   # chart-check spots.json (add -- --apply to rewrite it)
npm run dev            # http://localhost:3000
npm test               # score-engine unit tests (vitest)
```

## Workers — quick start

```sh
cd workers
uv venv .venv && uv pip install -p .venv/bin/python -e . 
.venv/bin/python -m nesurf.fetch_ww3 --hours 0:168:3        # full 7-day run (~57 requests)
.venv/bin/python -m nesurf.fetch_ww3 --hours 0:24:6 --source aws
```

Data sources (verified reachable 2026-09-21):

| Layer | Source | Access |
|---|---|---|
| Swell (WW3 / GFS-Wave) | `gfswave.tHHz.atlocn.0p16.fFFF.grib2` — NOMADS + AWS `noaa-gfs-bdp-pds` mirror | NOMADS `filter_gfswave.pl` subregion (~1–15 KB/step) or AWS `.idx` byte-range |
| Wind (HRRR) | `hrrr.tHHz.wrfsfcfFF.grib2` — NOMADS `filter_hrrr_2d.pl` subregion (~160 KB/h) or AWS `noaa-hrrr-bdp-pds` `.idx` | 10 m U/V + gust, 0–48 h hourly, resampled from 3 km Lambert to 0.03°/0.05° lat-lon |
| Buoys | `https://www.ndbc.noaa.gov/data/realtime2/<id>.txt` + `.spec` (swell / wind-sea split) | 44097 · 44008 · 44013 · 44098 · 44090 · 44007 (waves only on :20/:50 rows); 44018 & 44005 are 404 |
| Tides | `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter` predictions `interval=hilo` + `interval=h` (reference stations only; subordinates get a cosine curve from hi/lo) + `water_level` latest | station ids in `data/spots.json` |
| Bathymetry | NOAA CRM vol. 1 (Northeast), 3″, `https://www.ngdc.noaa.gov/thredds/dodsC/crm/crm_vol1.nc` OPeNDAP | per-spot 3 km transects → slope, profile, sandbar flag |
| Land mask | `global-land-mask` (GLOBE 1 km) | shoreline normal, shadow ray-casting, wind-raster paint mask |
| Geocoding | OSM Nominatim (1 req/s) | spot coordinate check only |

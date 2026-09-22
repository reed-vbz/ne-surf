# ne-surf — New England surf forecast (open source)

**Live:** https://ne-surf.vercel.app · **Source:** https://github.com/reed-vbz/ne-surf

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
│   ├── map/SurfMap.tsx            # MapLibre GL: satellite (Esri) / light (OpenFreeMap) basemap, markers, buoys, callouts, rasters
│   ├── map/SwellParticles.tsx     # canvas overlay: time-based streamlines coloured by swell quality + pulsing hotspot rings
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
│   ├── grid.ts                    # flat-grid sampling, wind colour ramp, raster → data URL
│   └── overlays.ts                # per-step rasters: swell-quality ocean shading (cut on the land mask), coastal wind band
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

## How it is hosted

- **Site**: Vercel, auto-deploys from `main` (Next.js static build; every route is prerendered).
- **Data**: GitHub Actions cron (`.github/workflows/ingest.yml`, 4×/day after each GFS-Wave cycle) runs the workers and
  force-pushes `public/cache` to the orphan **`data`** branch as a single commit, so `main` never grows.
  The site reads the cache from `raw.githubusercontent.com/reed-vbz/ne-surf/data/public/cache` via
  `NEXT_PUBLIC_CACHE_BASE` (see `.env.example`). Locally, without that variable, it reads `public/cache` written by `npm run ingest`.
- `public/cache/` is git-ignored on `main` for that reason.

## Run it

Alternative to GitHub Actions: `ops/ingest.sh` runs the pipeline locally and `ops/com.nesurf.ingest.plist` schedules it with launchd.

```sh
npm install            # also copies the MapLibre worker into public/vendor/maplibre (postinstall)
npm run ingest         # ww3 + hrrr + ndbc + tides + calibrate → public/cache  (needs workers/.venv)
npm run bathy          # NOAA CRM transects → data/bathymetry.json (only when spots change)
npm run verify:spots   # chart-check spots.json (add -- --apply to rewrite it)
npm run dev            # http://localhost:3000
npm test               # score-engine unit tests (vitest)
```

## Map engine — 5-layer permanent marine architecture (`/`)

MapLibre GL + deck.gl `MapboxOverlay` (interleaved) + self-hosted MVT, in `components/map/MarineMap.tsx`. All five layers
render concurrently; there are no layer toggles. Region (Reed's 2026-09-22 directive): 42.80–43.60 N, −70.85–−70.20 W
(Salisbury MA → Scarborough ME); the bbox bounds the default camera, the vector-tile source and the deck.gl physics.

| Layer | Source | Rendering |
|---|---|---|
| L0 ocean floor | 2D top-down (pitch 0, bearing 0, rotation locked). NOAA CRM 3″ isobaths as *nested* contours cut from one smoothed field, speckle < 16 cells absorbed, then differenced so adjacent bins share exact edges (`workers/nesurf/sandbox_nh.py` → `public/tiles/nh/{z}/{x}/{y}.pbf` z8–13, layer `bathy`), plus a hillshade from the Terrain-RGB DEM tiles baked from the same grid (`public/tiles/nh-dem`) for flat relief shading | MapLibre `fill`, `interpolate` on `min_depth`: 0 m #00E5FF → 20 m #0099CC → 100 m+ #0B192C; `hillshade` on the DEM |
| L1 wave energy | Two particle streamline layers, Surfline / Ventusky style, no grid or crest lines. **Groundswell**: the WW3 primary swell partition (`swell1_dp/hs`), Snell-refracted on the depth grid, RK2 streamlines with clocks on dispersion-relation travel time (heads slow over the shallows). **Wind waves**: the WW3 wind-sea partition (`wind_dp/hs`, HRRR wind where absent). Every streamline has a random phase and is emitted in loop-spaced copies so heads flow continuously | deck.gl `TripsLayer` ×2: groundswell = smooth long trails coloured by period (cyan → blue), wind waves = faint fast white dashes; density thins with zoom |
| L2 nearshore ribbon | 100 m high-water-mark segments with land→sea normal + exposure (`public/data/nh/ribbon.geojson`, MVT layer `ribbon`) | deck.gl `PathLayer`, #00FF88 / #FFB800 / #FF3366 by wind-to-beach angle |
| L3 land mask | the exact complement of the 0 m isobath (MVT layer `land`; never simplified client-side) | satellite land (Reed's call, 2026-09-22): the antialiased shoreline line sits above L0–L2 and zero bleed is enforced by the data — ocean-only L0 polygons sharing the 0 m outline, L1 streamlines only over water, rays stopping at the shore. The opaque fill stays in the style at opacity 0 for a chart look |
| L4 annotations | `data/spots.json` (the 14 regional breaks), NDBC buoys | deck.gl pulses + buoy status dots, HTML pins + callouts, React hover tooltips, and the glass UI: the **glass header** with the **full-forecast strip** (`ForecastStrip.tsx`, second header row above the timeline: the best break at the active hour surfaces itself — waves @ period (direction), wind + alignment, offshore peak, tide, hour; tap = fly there + open the drawer), the **polar swell radar** (`PolarRadar.tsx`: 360° compass, each WW3 partition at the active hour as a glowing bloom at its direction, radius by period, size by height, colour by energy; windsea scatters, groundswell clusters; swell window arc + facing notch) and the **buoy swell spectra graph** as widget-dock cards (`dockCard` in `OverviewScreen.tsx`, with the hotspot and legend cards) (`SpectraGraph.tsx`, bottom-left: wave energy across period, 3–21 s bins; the nearest NDBC buoy's raw spectral density (`realtime2/<id>.data_spec`, re-binned S(f)/T² → energy per period bin, labelled BUOY) or, when it has none, the WW3 partitions at the break synthesised as Gaussian peaks whose area is Hs²/16 (labelled MODEL); bars coloured by period like the particle layers, d3-shape monotone area, model partitions as markers), and the forecast drawer (`ForecastDrawer.tsx`: **wave avatar** `WaveAvatar.tsx` — side-profile wave to scale against a 1.75 m person, height from the forecast, lip curl from period + wind alignment — then 24-hour sparklines for height / period / wind / tide and a 7-day overview; hovering an hour moves the timeline knob and swaps the map's vector fields to that hour) |

Known limits: deck.gl 9.4's `MaskExtension` does not render in interleaved mode with MapLibre 6, so the mask is enforced by
the land fill + the data rather than a GPU mask; MapLibre 6 hides `map.transform`, which the overlay shims. The directive's
Mapbox Bathymetry v2 source needs a Mapbox token the project does not have; the CRM tiles are finer (90 m) and keyless.

Chrome: `design/ne-surf-handoff/ui-reference.html` is the source of truth (v2 2026-09-22: mode chips removed, the Layers
control became the Forecast control; v3: the search bar became the anticipatory pill band; v4: glass header + full-forecast strip, layer info card removed; v5: the bottom legends/hotspot became the widget dock — uniform 148×164 glass cards on an 8-pt grid, scroll-snap on phones, one row on desktop). `node scripts/render-reference.mjs` re-renders `ui-reference.png` from it;
`node scripts/pixel-diff.mjs 'http://localhost:3000/?ref=1'` diffs the build against it.

## Map overlays

All driven by the timeline step (no mocks):

- **Swell interaction** (ocean): colour = swell quality, 0.55 × share of energy that is swell (vs. wind sea) + 0.45 × period (6 s → 14 s). Orange = messy windswell, blue = clean groundswell. Bilinear over the 1/6° WW3 grid, extended to the shoreline and cut on the 1 km land mask. Streamlines use the same colour and travel along the primary swell direction.
- **Wind overlay** (coast): every land cell within ~5 km of water gets the HRRR wind projected on its local coast normal. Green = offshore, grey = alongshore, orange = onshore, fading inland.
- **Hotspots**: three staggered pulsing rings per spot, green / yellow / grey by score band, amplitude by band.

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

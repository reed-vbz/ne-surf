# Coastline mask + nearshore ribbon (data contract)

Produced by `workers/nesurf/coastline.py` from the NOAA Coastal Relief Model (3 arc-second ≈ 90 m). Both files are static
(`public/data/`) and regenerated only when the bbox, resolution or filters change.

## `coast-land.geojson` — land mask
`FeatureCollection<Polygon>`; 2,500–3,000 polygons over the bbox 40–45°N, 72.5–66°W, simplified to ~45 m, specks < 0.02 km² dropped.
Water narrower than ~1 km (tidal rivers, marsh channels, ponds) is treated as land so the ocean layers stop at the open coast.

```json
{ "type": "Feature", "properties": { "a": 12.418 },
  "geometry": { "type": "Polygon", "coordinates": [ [ [-70.66301,42.61712], [-70.66218,42.61712], … ] ] } }
```
`a` = area in km². Rings follow rasterio orientation; the client treats every ring (exterior and holes) with even-odd filling.

Client use: `FieldCanvas` / `FlowCanvas` rebuild a `Path2D` of *canvas rectangle − land rings* on `moveend` and draw every
ocean overlay through `ctx.clip(path, "evenodd")`. (A MapLibre `fill` layer above the overlays would clip them too, but it
would also paint over the satellite imagery of the land, which MapLibre cannot mask.)

## `coast-ribbon.geojson` — 100 m shoreline segments (canonical)
`FeatureCollection<LineString>`, one feature per 100 m of shoreline, Long Island Sound → Downeast Maine, ~45,000 features.

```json
{ "type": "Feature", "id": 18342,
  "geometry": { "type": "LineString", "coordinates": [ [-70.80812,42.84019], [-70.80780,42.84107] ] },
  "properties": { "n": 78, "e": 0.92, "m": [-70.80796, 42.84063] } }
```
| key | meaning |
|---|---|
| `id` | segment index (stable within one generation; use as the feature id / hover key) |
| `n` | **coast normal**, compass bearing from the segment toward open water (land → sea), integer degrees |
| `e` | **exposure** 0–1: fraction of 13 rays (±60° around `n`, 3 km) that stay over water; < 0.35 = inner harbour, omitted |
| `m` | midpoint `[lon, lat]`, where wind is sampled |

## `coast-ribbon.compact.json` — what the app loads (open coast only, `e ≥ 0.5`)
```json
{ "seg_m": 100, "fields": ["lon_a","lat_a","lon_b","lat_b","normal_deg"],
  "ids": [18342, …], "segs": [[-70.80812,42.84019,-70.80780,42.84107,78], …] }
```
~37,000 segments, ~1.8 MB raw / ~430 KB gzipped.

## Colouring a segment (lib/colors.ts)
```ts
alignment = cos(windTowardDeg − normalDeg)        // +1 offshore, 0 alongshore, −1 onshore
tier      = alignment ≥ 0.35 ? offshore : alignment > −0.25 ? cross : onshore
colour    = mix(cross #FFB800, ramp(alignment), confidence)   // confidence 0 at 3 kt → 1 at 12 kt
ramp: −1 → #FF3366 (onshore) … 0 → #FFB800 (cross) … +0.35..1 → #00FF88 (offshore)
```
Hovering a break highlights the nearest segment within 2 km of the pin and shows `|wind − normal|`, the swell period and the tier.

# NE Surf Overview — UI handoff

Drop this folder into the repo (e.g. `design/ne-surf-handoff/`) and point Claude Code at it.

## Files

| File | What it is | How Claude Code should use it |
|---|---|---|
| `ui-reference.png` | Pixel target. 390×844 @2x render of the finished screen. | The acceptance test. Build must match this. |
| `ui-reference.html` | The same screen as plain HTML/CSS/SVG. Every panel, chip, callout, legend and card is real markup with exact px values. | Lift the chrome from here verbatim. Do not re-invent it. |
| `build-spec.png` / `build-spec.html` | Tokens (hex + usage), type scale, layout/radii/elevation, map components (pin, rings, callout, zone label, chips, layers button) rebuilt in SVG, the 7-layer map stack, behavior rules and a do-not list. | Read fully before writing a line of code. |
| `map_layer.jpg` | Placeholder for the map engine (satellite + swell zones + wind streamlines + markers). | Use as a static background only until the real map layers exist. Production = MapLibre/Mapbox satellite basemap + layers 1–6 from the spec. |

## Prompt to paste into Claude Code

```
Implement the forecast screen in design/ne-surf-handoff/.
- ui-reference.png is the pixel target. ui-reference.html is the authoritative source for all chrome (header, toolbar chips, 7-day timeline, layer card, layers button, break callouts, legends, hotspot card): reuse its markup, sizes, colors and font (Barlow / Barlow Condensed from Google Fonts).
- build-spec.html defines tokens, type scale, map layer stack (0–6) and behaviors. Follow it exactly, including the "Do not" list.
- The map is a live map layer (MapLibre satellite), NOT the jpg. Use map_layer.jpg only as a temporary background until layers 1–6 render.
- Timeline: selected day drives swell zones, streamlines, rings and both callouts. Segments up to the selected day fill #4798B7; knob is a 16px white circle centered on the selected segment.
- Every tappable element has a ≥44px hit area even where the visual is 24–30px.
- Before finishing, screenshot your build at 390×844 @2x and diff it against ui-reference.png. Fix every difference in chrome position, size, color or type.
```

## Not covered here (decide before build)

- Swell / wind data source and the break-ranking model.
- Real break coordinates (mock geography is approximate).
- Target platform (web / React Native). Spec is px-based and platform-agnostic.


## v2 — 2026-09-22

Per Reed's UI refactor directive: the three mode chips (Forecast slider / Refraction map / Live buoy feed) were removed from the
search bar and the Layers map control became the Forecast-drawer control (chart icon, same box). `ui-reference.html` was edited
accordingly and `ui-reference.png` re-rendered from it with `node scripts/render-reference.mjs` (Chrome for Testing, 390×844 @2x).
The previous PNG is kept as `ui-reference-v1-2026-09-21.png`. The glass forecast drawer is closed in the reference (phone default).

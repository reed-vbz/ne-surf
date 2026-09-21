# What Surfline does (and what we copy)

Researched 2026-09-21. Surfline's site and support center are behind a Cloudflare
challenge, so these notes come from search-engine extracts of their own support
articles plus third-party writeups. Confidence is marked per item.

## Their pipeline (as they describe it)

| Item | What they say | Confidence |
|---|---|---|
| Wave model | **LOTUS**, their proprietary global model, built on NOAA's WAVEWATCH III source code; successor to LOLA. | high (their support article "What is LOTUS?") |
| Nearshore | "Surfline's special blend of high-resolution bathymetry mapping and near-shore wave models" turn deep-water spectra into surf height at the spot. | high (same article) |
| Calibration | Machine learning against their cam network, plus expert forecasters who "make multiple daily observations, adjusting the surf height and ratings", which "teaches the model". | high |
| Surf height | Face height (trough to crest) by default, Hawaiian scale optional. Uses significant height: "only includes the height of the biggest third of waves". | high (surfline.com "Surfline's Rating of Surf Heights") |
| Ratings | 7 levels: Very Poor · Poor · Poor to Fair · Fair · Fair to Good · Good · Epic. Only 5 bars in the UI; Good and Epic "need to be manually applied by a human forecaster". | high (support "Surf Ratings & Colors") |
| Automated rating inputs | "uses surf height and wind conditions to estimate a rating", updated hourly from LOTUS. Automated ratings "will not account for tides or key spot dynamics" and can "miss important factors, such as prior winds that have left residual swell". | high (support article) |
| Consistency | They show a "wave consistency" metric (how often set waves arrive) derived from period/spectral shape. | medium (article title only) |

Sources: Surfline support "What is LOTUS?", "Surf Ratings & Colors", "Wave Consistency", "The height & rating were wrong…"; surfline.com "Surfline's Rating of Surf Heights"; surfertoday.com WaveWatch article; stormsurf.com wave-model notes.

## What this means for our score engine

1. **Deep water → face height needs a nearshore step.** Surfline uses bathymetry + nearshore models; we start with a per-spot empirical `shoaling_factor` (already in the schema) applied to the *energy-weighted* swell partitions, calibrated later against NDBC buoys and, if we ever get them, cam/report observations. The Coastal Relief Model can replace the constant with a slope-aware factor in step 3.
2. **Use partitions, not just Hs.** Surfline's whole LOTUS pitch is better swell *arrival timing*, which only works with separated swell trains. GFS-Wave already gives us three partitions (`swell1..3`) plus wind sea; our angle match runs per partition and sums energy that actually reaches the spot after shadowing.
3. **Their automated rating is height + wind.** Tide and spot dynamics come from human forecasters. We can do better automatically because our spot file carries tide preference and shadow sectors; that is the one place a free app can beat them without cams.
4. **Ratings, not just a number.** Expose a 0–100 score but band it into their familiar seven labels so users can compare. Keep Good/Epic hard to reach: require size *and* period *and* wind *and* tide to all be in the ideal zone.
5. **Wave consistency.** Cheap proxy: peak period and spectral narrowness (ratio of partition-1 energy to total). Add later.

## What we do NOT copy
- Cam-based ML corrections (no cams).
- Human forecaster overrides (open-source: users can propose spot-file edits instead).

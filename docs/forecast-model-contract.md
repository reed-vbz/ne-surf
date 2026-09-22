# Forecast and rendering contract

Implementation version: 2. This is an empirical forecasting app, not a validated local surf model or navigation chart.

## Selected state and publication

The forecast drawer, spot pins and swell radar use the same selected UTC hour. New York time is a presentation layer; the fall-back hour has two distinct UTC instants. Forcing is interpolated before scoring, using variance for wave heights, wrapped wave bearings and vector wind interpolation. Numbered swell partitions with large direction/period changes are treated as different systems rather than blended. Missing wave inputs do not become a flat-ocean measurement.

Daily cards and the hotspot are explicitly best-window summaries. The animation is the nearest three-hour **regional primary swell** field, labeled with its own valid time in the data disclosure. It is not the spot-height calculation. HRRR and GFS wind sources are identified there. NDBC charts show **latest observed** time and age, independently of the selected forecast day; forecast partition markers are not drawn over those observations.

The publisher retains data commits and atomically advances `manifest.json`. Every product is loaded from that immutable commit. During migration, the client can resolve the legacy data branch to a commit through GitHub's public refs API; if neither source can be pinned it fails closed. Successful source refreshes are atomic, failures remain retryable, and unavailable fields are hidden by their request key. NDBC wave observations older than three hours are not presented as current. Model updates run four times daily; buoy-only refreshes run hourly.

## Wave physics

The regional field solves a monotone eikonal approximation with metric `(dy, dx)` spacing and phased inflow boundaries. Disconnected water has no injected energy. Empirical attenuation is integrated along local upstream characteristics; no global sorted-cell cumulative loss is used. Linear dispersion supplies phase/group velocities, shoaling and a depth cap. Texture encoding reserves zero for land/unreachable cells and rejects travel times beyond the encoding range. The shader reconstructs decoded data, antialiases crests and suppresses unresolved frequencies. This is a single primary-swell visualization: it does not resolve spectral diffraction, reflection, currents or ray focusing.

Spot height uses period-dependent empirical transfers weighted by each partition's usable variance. Transfer factors share total offshore height so splitting an equal-period system does not increase the resulting estimate. Bottom slope informs shape, not a surveyed reef-depth model. Tides use supplied hourly predictions where available. Existing local orientation/exposure preferences remain provisional. A rounded estimate is shown instead of inventing a set-height range.

## Spectra and calibration

NDBC frequency centers are serialized to six decimals and must be finite, positive and strictly increasing. Densities must be nonnegative. Midpoint frequency-bin edges are used, with half-bin endpoint extrapolation. Period bars integrate overlap with each 1-second period interval; data outside 2.5–21.5 seconds are not silently redistributed. Total spectral Hs includes all supplied frequency bins. Model spectra are labeled synthetic estimates, not measured spectral densities.

Buoy diagnostics deduplicate observation instants, count independent days and evaluate a chronological two-day holdout once seven days exist. Bulk-height skill does **not** validate applying one ratio to every partition or every nearby break. Automatic corrections remain gated off until representative per-partition/spot validation is supplied. A 12-hour cluster of 25 samples is no longer full-trust calibration.

Surrogate checkpoints require matching geometry/teacher versions, finite held-out metrics and matching training/validation provenance. A teacher-trained model is labeled teacher emulation. SWAN training is not evidence of SWAN accuracy when validation still uses the teacher. The repository supplies no real SWAN benchmark or local wave-face observations, so commercial accuracy and predictive alert reliability cannot be asserted.

## Geometry and UX

The published ocean polygon is the common render mask for depth, crests and particle trails. Deck's standalone overlay is used so its mask effect executes. A separate coastline omits the bounding-box edge; that edge is drawn as a dashed coverage limit. Ribbon paths follow the same polygon and retain bends within each at-most-100 m segment; 100 m describes **segment length**, not offshore width. This improves consistency with the chosen CRM-derived polygon, not the accuracy of that polygon against a surveyed shoreline.

The map marker layer stays above the ocean canvas. The dock scrolls horizontally on phones; charts expand into native modal dialogs. Hour selection works with keyboard and touch. Hidden drawers are inert. Contrast preferences persist locally; reduced-motion and hidden-tab states pause animation. Selected-spot pulses are the only pulses.

## Validation and release

Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, and `cd workers && .venv/bin/python -m unittest discover -s tests`. The optional PINN tests require the `pinn` dependency extra. After ingestion, run `python -m nesurf.validate_cache` before publication. CI performs the worker tests and cache checks before publishing.

First release should run a full ingestion to create version-2 textures and the retained manifest. Until then, legacy publication fallback is commit-pinned and incompatible textures are omitted. Existing data-branch history will grow; an immutable object store with an explicit retention policy is the long-term storage path.

Still requiring external evidence: chart/survey review of reef depth and shoreline/orientation; held-out storm and local face-height observations by spot/lead/period band; validated calibration transfer; real SWAN target/holdout runs; predictive-alert false-alarm/miss calibration. Do not enable confident notifications or claim these scientific validations are complete based on unit tests.

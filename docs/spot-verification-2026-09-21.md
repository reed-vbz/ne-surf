# Spot verification — 2026-09-21

What `workers/nesurf/verify_spots.py` and `workers/nesurf/bathy.py` checked, and what changed in `data/spots.json`.
Method: OSM Nominatim geocode of each spot name; shoreline normal from the GLOBE 1 km land mask (two estimators: circular mean of water bearings on 0.5–2 km rings, and the midpoint of the arc open to sea); shadow sectors by 2° ray-casting to 250 km; swell window clipped to the open-sea arc; nearshore slope from NOAA Coastal Relief Model 3″ transects.

Rules: a computed facing replaces the hand value only for `beach` breaks where both estimators agree within 20° and differ from the hand value by more than 15°. Reefs/points keep hand values (the 1 km mask cannot resolve a headland). Geocodes are adopted only for OSM beach/lighthouse/bay/park nodes within 3 km.

| Spot | Location | Facing | Window | Shadows (ray-cast) | Bottom slope (CRM) |
|---|---|---|---|---|---|
| **Misquamicut** | kept hand value (geocode 3.13 km, type beach) | hand value within 15° of computed (184) | hand window lies inside open-sea arc 102-232 | 114–134° Block Island (0.85, 25 km); 182–232° Long Island / Montauk (0.95, 32 km) | 1:40 (ok); marker is inland |
| **Matunuck** | OSM beach node, was 0.0 km away | hand value within 15° of computed (170) | hand window lies inside open-sea arc 104-236 | 180–192° Block Island (0.60, 17 km); 218–236° Long Island / Montauk (0.85, 53 km) | 1:88 (ok); marker at shoreline |
| **Point Judith (Lighthouse)** | OSM lighthouse node, was 0.0 km away | hand value within 15° of computed (165) | hand window lies inside open-sea arc 80-240 | 80–96° Elizabeth Islands (0.60, 59 km); 194–208° Block Island (0.60, 17 km); 224–240° Long Island / Montauk (0.60, 58 km) | 1:70 (ok); marker at shoreline |
| **Narragansett Town Beach** | OSM beach node, was 0.0 km away | hand value within 15° of computed (130) | clipped to open-sea arc 76-170 (was 90-200) | 84–104° Elizabeth Islands (0.85, 52 km) | 1:59 (ok); marker at shoreline |
| **Ruggles** | kept hand value (geocode 0.42 km, type tertiary) | kept hand value 165: computed 117 but reef / land fraction 0.83 makes the 1 km mask unreliable | clipped to open-sea arc 82-152 (was 110-210) | 80–96° Sakonnet Point (0.60, 10 km); 98–112° Elizabeth Islands (0.60, 42 km) | 1:58 (ok); marker is inland |
| **Second Beach (Sachuest)** | kept hand value (geocode None km, type None) | hand value within 15° of computed (171) | clipped to open-sea arc 100-238 (was 130-240) | 100–118° Sakonnet Point (0.85, 6 km); 214–224° Block Island (0.60, 40 km) | 1:204 (noisy); marker is offshore |
| **Horseneck Beach** | OSM beach node, was 0.0 km away | hand value within 15° of computed (163) | clipped to open-sea arc 130-224 (was 130-230) | none | 1:125 (ok); marker is inland |
| **South Beach (Katama)** | OSM beach node, was 0.01 km away | hand value within 15° of computed (174) | hand window lies inside open-sea arc 90-246 | 90–98° Martha's Vineyard (0.60, 5 km); 100–110° Nantucket (0.60, 22 km) | 1:112 (ok); marker is inland |
| **Nobadeer** | OSM beach node, was 0.0 km away | hand value within 15° of computed (173) | clipped to open-sea arc 112-230 (was 110-240) | none | 1:36 (ok); marker at shoreline |
| **Nauset Beach** | OSM beach node, was 0.01 km away | hand value within 15° of computed (85) | clipped to open-sea arc 8-152 (was 20-160) | 8–12° Monhegan / midcoast islands (0.45, 236 km) | 1:179 (noisy, bar); marker is inland |
| **Coast Guard Beach** | OSM beach node, was 0.01 km away | hand value within 15° of computed (84) | hand window lies inside open-sea arc 358-166 | 358–16° Monhegan / midcoast islands (0.64, 221 km) | 1:99 (ok); marker is inland |
| **Nantasket Beach** | kept hand value (geocode 0.6 km, type village) | adopted 40: ring-mean 28 and open-arc mid 47 agree (hand 75) | clipped to open-sea arc 350-104 (was 345-95) | 350–28° Cape Ann (0.95, 30 km); 30–36° Monhegan / midcoast islands (0.45, 213 km) | 1:79 (ok); marker at shoreline |
| **Good Harbor Beach** | OSM beach node, was 0.01 km away | adopted 120: ring-mean 117 and open-arc mid 118 agree (hand 140) | clipped to open-sea arc 72-164 (was 40-170) | 144–164° Cape Cod (0.85, 102 km) | 1:46 (ok); marker at shoreline |
| **Salisbury Beach** | kept hand value (geocode 1.57 km, type village) | hand value within 15° of computed (90) | hand window lies inside open-sea arc 0-180 | 350–44° Isles of Shoals (0.95, 13 km); 50–54° Monhegan / midcoast islands (0.45, 186 km); 140–190° Cape Ann (0.95, 19 km) | 1:61 (ok); marker is offshore |
| **The Wall (Hampton)** | kept hand value (geocode 1.02 km, type census) | adopted 115: ring-mean 117 and open-arc mid 114 agree (hand 95) | clipped to open-sea arc 48-180 (was 40-185) | 48–58° Monhegan / midcoast islands (0.45, 185 km); 148–180° Cape Ann (0.85, 28 km) | 1:156 (ok); marker is inland |
| **Jenness Beach** | kept hand value (geocode 3.13 km, type beach_resort) | kept hand value 110: estimators disagree (ring-mean 139, open-arc mid 114) — check on a chart | clipped to open-sea arc 36-192 (was 30-170) | 44–60° Monhegan / midcoast islands (0.45, 163 km); 100–104° Isles of Shoals (0.60, 10 km); 152–162° Cape Cod (0.60, 120 km); 164–192° Cape Ann (0.85, 36 km) | 1:78 (ok); marker is offshore |
| **Long Sands (York)** | OSM beach node, was 0.0 km away | adopted 135: ring-mean 130 and open-arc mid 142 agree (hand 115) | clipped to open-sea arc 110-174 (was 60-195) | 160–174° Cape Cod (0.45, 159 km) | 1:104 (ok); marker at shoreline |
| **Gooch's Beach (Kennebunk)** | kept hand value (geocode None km, type None) | adopted 175: ring-mean 185 and open-arc mid 166 agree (hand 135) | clipped to open-sea arc 112-220 (was 100-230) | 166–220° Cape Ann (0.95, 76 km) | n/a (too_shallow_or_flat); marker is inland |
| **Old Orchard Beach** | kept hand value (geocode 1.98 km, type census) | hand value within 15° of computed (128) | clipped to open-sea arc 68-186 (was 50-180) | 148–210° Cape Elizabeth (0.95, 6 km) | 1:172 (ok); marker is inland |
| **Higgins Beach** | OSM beach node, was 0.0 km away | adopted 175: ring-mean 173 and open-arc mid 177 agree (hand 150) | clipped to open-sea arc 138-216 (was 95-225) | 172–198° Cape Cod (0.64, 170 km); 200–216° Cape Elizabeth (0.60, 14 km) | 1:99 (ok); marker at shoreline |
| **Popham Beach** | OSM beach node, was 0.0 km away | kept hand value 175: estimators disagree (ring-mean 98, open-arc mid 123) — check on a chart | clipped to open-sea arc 88-158 (was 100-230) | 154–166° Monhegan / midcoast islands (0.60, 4 km); 184–200° Cape Cod (0.45, 208 km) | 1:208 (noisy); marker is inland |

## Flags to check by hand

- **Misquamicut**: marker 650 m inland of the shoreline
- **Ruggles**: facing estimators disagree — confirm on a chart; marker 1750 m inland of the shoreline
- **Second Beach (Sachuest)**: bottom profile noisy
- **Nauset Beach**: bottom profile noisy
- **Nantasket Beach**: adopted facing 40° looks too northerly for Nantasket (hand was 75°); 1 km mask struggles with the Hull spit
- **Salisbury Beach**: marker 750 m offshore of the shoreline
- **Jenness Beach**: facing estimators disagree — confirm on a chart; marker 650 m offshore of the shoreline
- **Gooch's Beach (Kennebunk)**: bottom profile too_shallow_or_flat; marker 700 m inland of the shoreline
- **Popham Beach**: facing estimators disagree — confirm on a chart; bottom profile noisy; marker 650 m inland of the shoreline

## Deep-water model calibration (buoys)

Cycle 2026-09-21T12:00:00Z, 86 model/obs pairs this run. Ratio = observed Hs / GFS-Wave Hs, applied to nearby spots damped by pair count (full trust at 24).

| Buoy | pairs | obs Hs | model Hs | ratio | period bias | dir bias |
|---|---|---|---|---|---|---|
| 44007 | 16 | 0.56 m | 0.52 m | 1.065 | -3.36 s | -38° |
| 44008 | 16 | 1.14 m | 1.13 m | 1.015 | -1.61 s | -13° |
| 44013 | 16 | 1.24 m | 0.89 m | 1.386 | 0.79 s | 1° |
| 44090 | 12 | 1.23 m | 0.96 m | 1.284 | 1.01 s | -19° |
| 44097 | 13 | 1.7 m | 1.32 m | 1.289 | 0.44 s | 3° |
| 44098 | 13 | 0.98 m | 0.85 m | 1.152 | 0.16 s | -8° |

## What is still hand-entered

Swell height/period bands, wind thresholds and tide preferences are surf knowledge, not measurements. The `shoaling_factor` is now only a fallback for spots whose CRM profile is unusable (Gooch's).

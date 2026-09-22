# SWAN-PINN surrogate (workers/pinn)

A PyTorch U-Net / ConvLSTM surrogate that emulates SWAN nearshore wave transformation over the NOAA CRM bathymetry of the
MA · NH · ME region, with a composite physics-informed loss, a FastAPI inference endpoint calibrated against live NDBC
buoys, and a GPU data bridge to the app's Rolling Wavefronts shader.

```
cd workers && uv pip install -p .venv/bin/python -e ".[pinn]"
PYTHONPATH=. .venv/bin/python -m pinn.sdf                       # geometry: depth + signed distance field (270 m grid)
PYTHONPATH=. .venv/bin/python -m pinn.train --epochs 30         # trains against the physics teacher → .scratch/pinn/checkpoint.pt
PYTHONPATH=. .venv/bin/uvicorn pinn.api:app --port 8100         # inference API (checkpoint if present, else the teacher)
```

| file | what |
|---|---|
| `sdf.py` | CRM depth → 2D depth tensor + signed distance field (EDT both sides of the shoreline), `geometry.npz` |
| `tensors.py` | WW3 deep-water boundary (H_s, T_p, θ_m of the primary swell partition) + HRRR wind → the 8-channel input tensor |
| `model.py` | `SwanUNet`: 4-level U-Net with a ConvLSTM bottleneck (sequence mode for consecutive steps); outputs H_s, T_p, θ, k; 3.75 M params; ≈160 ms on CPU |
| `physics.py` | differentiable dispersion relation, phase/group speed, shoaling, breaking limit, wave-action balance residual, Snell refraction |
| `losses.py` | L = L_MSE + λ₁·L_energy-balance + λ₂·L_dispersion + hinge terms for shoaling, γ-breaking and the land mask |
| `teacher.py` | the physics solver (eikonal travel time by fast marching + shoaling/friction/breaking) as target fields — swap in SWAN `.npz` outputs with `train.py --swan DIR` |
| `train.py` | randomised boundary-condition sweep → checkpoint |
| `api.py` | FastAPI: `/health`, `POST /infer`, `/infer.png` (shader texture), `/infer.f32` (Float32 planar for a raw data texture / UBO), `/index.json` + `/fNNN.png` (drop-in for `NEXT_PUBLIC_PINN_API`) |
| `texture.py` | data bridge: (H_s, k) → travel-time field → RGBA8 texture (R,G = t 16-bit, B = H_s) or Float32 planar |

**Honesty note.** No SWAN runs exist for this region yet, so a trained checkpoint is a surrogate of the physics teacher,
not of SWAN. The API and the published textures (`workers/nesurf/wavefield.py`, run by the ingest cron) use the teacher
until a checkpoint trained on real SWAN output is dropped at `.scratch/pinn/checkpoint.pt`. Buoy calibration uses
44097 and 44098; 44018 has returned 404 from NDBC since 2026-09-21.

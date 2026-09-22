# SWAN-PINN surrogate (workers/pinn)

A PyTorch U-Net / ConvLSTM surrogate of the regional physics teacher, with an optional SWAN target loader. It uses a composite physics-informed loss, a FastAPI inference endpoint and a GPU data bridge. No independent local forecast skill has been established. See `docs/forecast-model-contract.md` for the current contract.

```
cd workers && uv pip install -p .venv/bin/python -e ".[pinn]"
PYTHONPATH=. .venv/bin/python -m pinn.sdf                       # geometry: depth + signed distance field (stride-2 CRM grid; separate dy/dx metrics)
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

**First training run (2026-09-22, 10 epochs × 60 teacher fields, CPU ≈ 12 min):** loss 5.66 → 1.77, no divergence after the
sinh clamp; held-out vs the teacher: H_s MAE 0.30 m, wavenumber error 64 %. That is a working pipeline, not a usable model, so the API
**gates** checkpoints on held-out metrics (`GATE` in `api.py`: H_s MAE ≤ 0.10 m and k error ≤ 15 %) and keeps serving the teacher until
one passes; `/health` shows the checkpoint's metrics and `passes_gate`. More epochs/samples (`--epochs 60 --samples 300`) or real SWAN
targets are the path to passing it.

**Current serving contract (version 2).** Geometry is fingerprinted and old scalar-spacing geometry is rebuilt. Checkpoints must match that fingerprint and the solver version, have finite held-out metrics, and identify matching target/validation sources. Teacher emulation is labeled as such. A SWAN-target checkpoint evaluated only against the teacher is rejected. No real SWAN benchmark or local face-height observations are included in this repository.

Bulk buoy ratios are diagnostic until their transfer to individual partitions and locations is validated; the primary swell field is not scaled by an unvalidated regional average. Nonfinite physics losses abort training. The energy residual uses separate axis distances and excludes land-adjacent and domain-edge cells rather than wrapping opposite boundaries.

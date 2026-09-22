"""
Tensor assembly: NOAA WW3 deep-water boundary conditions + HRRR wind + CRM depth + SDF → the surrogate's input tensor.

Input channels (C = 8), all on the geometry grid (H × W ≈ 260 × 320 at 270 m):
  0 depth / 100 m         1 sdf / 2 km        2 water mask
  3 H_s0 / 5 m (boundary, broadcast)          4 T_p / 20 s          5 sin θ_m   6 cos θ_m   (θ = direction FROM)
  7 wind speed / 20 m/s   (+ optional 8, 9: wind u, v when the HRRR step is given)
Targets (C = 4): H_s (m), T_p (s), θ_m (rad, direction TO), k (rad/m) — the teacher (physics solver) or SWAN fields.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[2]
WW3 = ROOT / "public" / "cache" / "ww3"
GEOM = ROOT / "workers" / ".scratch" / "pinn" / "geometry.npz"


def load_geometry():
    if not GEOM.exists():
        from .sdf import build; build()
    g = np.load(GEOM)
    return {k: (g[k].item() if g[k].ndim == 0 else g[k]) for k in g.files}


def boundary_from_ww3(step: dict, index: dict, geom: dict) -> tuple[float, float, float, float]:
    """Deep-water (H_s, T_p, θ_m FROM, wind speed) from the WW3 primary swell partition averaged over the region's cells."""
    F = step["fields"]; lat = np.array(index["lat"]); lon = np.array(index["lon"]); nlat, nlon = index["shape"]
    h, w = geom["depth"].shape; S, N = geom["lat0"], geom["lat0"] + h * geom["res_deg"]; W, E = geom["lon0"], geom["lon0"] + w * geom["res_deg"]
    rows = []
    for i in range(nlat):
        for j in range(nlon):
            if not (S <= lat[i] <= N and W <= lon[j] <= E): continue
            k = i * nlon + j
            hs, tp, dp = F.get("swell1_hs", F["hs"])[k], F.get("swell1_tp", F["tp"])[k], F.get("swell1_dp", F["dp"])[k]
            if None in (hs, tp, dp): hs, tp, dp = F["hs"][k], F["tp"][k], F["dp"][k]
            if None in (hs, tp, dp): continue
            rows.append((hs, tp, dp, F.get("wind_speed", [None] * (nlat * nlon))[k] or 0.0))
    a = np.array(rows, dtype=float)
    r = np.radians(a[:, 2]); dp = math.degrees(math.atan2(np.sin(r).mean(), np.cos(r).mean())) % 360
    return float(a[:, 0].mean()), float(max(3.0, np.median(a[:, 1]))), float(dp), float(a[:, 3].mean())


def input_tensor(geom: dict, hs0: float, tp: float, dir_from_deg: float, wind_ms: float, wind_uv: tuple[np.ndarray, np.ndarray] | None = None) -> torch.Tensor:
    depth, sdf, water = geom["depth"], geom["sdf"], geom["water"].astype(np.float32)
    th = math.radians(dir_from_deg)
    ch = [depth / 100.0, sdf / 2000.0, water, np.full_like(depth, hs0 / 5.0), np.full_like(depth, tp / 20.0), np.full_like(depth, math.sin(th)), np.full_like(depth, math.cos(th)), np.full_like(depth, wind_ms / 20.0)]
    if wind_uv is not None: ch += [wind_uv[0] / 20.0, wind_uv[1] / 20.0]
    return torch.from_numpy(np.stack(ch).astype(np.float32))[None]   # (1, C, H, W)


def ww3_steps():
    index = json.loads((WW3 / "index.json").read_text())
    for st in index["steps"]:
        yield st, json.loads((WW3 / st["file"]).read_text()), index

"""
Physics teacher: the eikonal + shoaling solver (workers/nesurf/wavefield.py) as target fields for the surrogate.
Returns the 4-channel target (H_s, T_p, θ_to, k) on the geometry grid for one deep-water boundary condition.
θ_to is the propagation direction recovered from the travel-time gradient (crests are level sets of t, rays follow ∇t).
When SWAN output is available, load it here instead: the trainer only needs the same 4 channels.
"""
from __future__ import annotations

import math

import numpy as np
import torch

from nesurf import wavefield as WF


def teacher_fields(geom: dict, hs0: float, tp: float, dir_from_deg: float) -> torch.Tensor:
    depth, water, res_m = geom["depth"].astype(float), geom["water"], float(geom["res_m"])
    t = WF.travel_time(depth, water, tp, dir_from_deg, res_m)
    H = WF.wave_height(depth, water, t, hs0, tp, res_m)
    gy, gx = np.gradient(np.where(water, t, np.nan), res_m)
    theta_to = np.arctan2(np.nan_to_num(gx), np.nan_to_num(gy))            # bearing of ∇t (east, north) → clockwise from north
    theta_to = np.where(water, theta_to, 0.0)
    _, k = WF.phase_speed(depth, tp); k = np.where(water, k, 0.0)
    out = np.stack([H, np.full_like(H, tp), theta_to, k]).astype(np.float32)
    return torch.from_numpy(out)[None]

"""
GPU data bridge: (H_s, T_p, θ, k) fields → the RGBA texture the Rolling Wavefronts shader reads (workers/nesurf/wavefield.py
packing) and, for WebGL callers that want raw floats, a Float32 planar array.

The shader animates φ = ω·t(x) − ω·u_time, so the bridge converts the surrogate's k / θ field into a travel-time field
by integrating the eikonal equation with the surrogate's own phase speed c = ω / k (fast marching), which keeps the
crests continuous even where the network's θ is noisy.
"""
from __future__ import annotations

import io
import math

import numpy as np

from PIL import Image

from nesurf.wavefield import H_MAX, T_SCALE, encode, arrival_from_speed


def travel_time_from_k(k: np.ndarray, water: np.ndarray, tp: float, dir_from_deg: float, res_m: float) -> np.ndarray:
    omega = 2 * math.pi / tp; c = np.where(water & (k > 1e-6), omega / np.maximum(k, 1e-6), 1e-3)
    return arrival_from_speed(c, water, dir_from_deg, res_m)


def to_texture_png(hs: np.ndarray, k: np.ndarray, water: np.ndarray, sdf: np.ndarray, tp: float, dir_from_deg: float, res_m: float) -> bytes:
    t = travel_time_from_k(k, water, tp, dir_from_deg, res_m)
    rgba = encode(t, np.where(water, hs, 0.0), sdf)
    buf = io.BytesIO(); Image.fromarray(rgba[::-1], "RGBA").save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def to_float32(hs: np.ndarray, tp: np.ndarray, theta: np.ndarray, k: np.ndarray) -> bytes:
    """Planar Float32 (4, H, W) little-endian — bind as an RGBA32F texture or a UBO-backed storage buffer."""
    return np.stack([hs, tp, theta, k]).astype("<f4").tobytes()


ENCODING = {"t_scale_s": T_SCALE, "h_max_m": H_MAX, "land": "t == 0", "rows": "north first"}

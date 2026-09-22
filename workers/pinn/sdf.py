"""
Signed Distance Field + input tensor construction for the SWAN-PINN surrogate.

    python -m pinn.sdf            # -> workers/.scratch/pinn/geometry.npz  (depth, sdf, water, lat/lon origin, resolution)

The SDF encodes the coastal geometry explicitly for the network: positive metres over water (distance to the nearest
shoreline), negative over land. Together with depth it is what lets a convolutional surrogate learn refraction,
shadowing and shoreline dissipation without ever seeing a coastline polygon.
"""
from __future__ import annotations

import base64
import json
import hashlib
import math
from pathlib import Path

import numpy as np
from scipy import ndimage

ROOT = Path(__file__).resolve().parents[2]
DEPTH_JSON = ROOT / "public" / "data" / "nh" / "depth.json"
OUT = ROOT / "workers" / ".scratch" / "pinn" / "geometry.npz"
STRIDE = 2   # 3 × 3″ CRM cells ≈ 270 m: the same grid the wave-field textures use


def load_depth(stride: int = STRIDE):
    j = json.loads(DEPTH_JSON.read_text())
    a = np.frombuffer(base64.b64decode(j["data_b64"]), dtype="<u2").reshape(j["nlat"], j["nlon"]).astype(np.float32) / 10.0
    a = a[::stride, ::stride]
    res_deg = j["res"] * stride
    res_m = (res_deg * 111320, res_deg * 111320 * math.cos(math.radians(j["lat0"] + (a.shape[0] - 1) * res_deg / 2)))
    return a, float(j["lat0"]), float(j["lon0"]), float(res_deg), res_m


def signed_distance(water: np.ndarray, res_m: float) -> np.ndarray:
    """Euclidean distance transform on both sides of the shoreline, signed (+ water / − land), in metres."""
    return np.where(water, ndimage.distance_transform_edt(water, sampling=res_m), -ndimage.distance_transform_edt(~water, sampling=res_m)).astype(np.float32)


def build(stride: int = STRIDE):
    depth, lat0, lon0, res_deg, res_m = load_depth(stride)
    water = depth > 0
    sdf = signed_distance(water, res_m)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    fingerprint = hashlib.sha256(depth.tobytes() + water.tobytes() + np.asarray([lat0,lon0,res_deg,*res_m],dtype="<f8").tobytes()).hexdigest()
    np.savez_compressed(OUT, source_hash=hashlib.sha256(DEPTH_JSON.read_bytes()).hexdigest(), geometry_hash=fingerprint, geometry_version=2, depth=depth, sdf=sdf, water=water, lat0=lat0, lon0=lon0, res_deg=res_deg, res_m=res_m)
    return depth, sdf, water, res_m


if __name__ == "__main__":
    d, s, w, r = build()
    print(f"geometry {d.shape} at {r} m, water {w.mean():.2f}, sdf {s.min():.0f}…{s.max():.0f} m → {OUT}")

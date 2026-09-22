"""
Nearshore wave field per WW3 step → GPU data textures for the Rolling Wavefronts shader (Layer 1).

    python -m nesurf.wavefield            # -> public/cache/wavefield/index.json + fNNN.png (one RGBA texture per WW3 step)

Physics (the "teacher" the PINN in workers/pinn is trained against, and the runtime fallback when no checkpoint exists):
  • phase speed c(h, T) from the linear dispersion relation ω² = g k tanh(k h)
  • wave travel time t(x) from the eikonal equation |∇t| = 1 / c(h, T), solved by fast marching from the up-wave edge of
    the grid (the deep-water WW3 boundary). Crests are level sets of t: they refract, bend around headlands and align to
    coves because c drops with depth (c → √(g h) in the shallows). Wavelength L = c T (= g T² / 2π in deep water).
  • height H(x) by linear shoaling (K_s = √(c_g0 / c_g)), a bottom-friction decay over shallow travel, and depth-limited
    breaking H ≤ γ h (γ = 0.78), starting from the WW3 primary swell partition at the boundary.

Texture packing (RGBA8 PNG, one per step, `shape` cells at `res_deg`):
  R,G  travel time t, 16-bit big-endian, seconds × T_SCALE (0 = land: the shader discards it and fades crests toward it)
  B    H_s metres × (255 / H_MAX)
  A    255 (data never rides in alpha: browsers may premultiply alpha on image upload)
  The signed distance field (sdf.npy, metres, negative over land) is written next to the textures for the PINN.
index.json carries omega (2π / T_p), the swell direction and the scales for every step, so the shader animates
cos(omega · t(x) − omega · u_time) with no per-pixel direction lookup.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
import skfmm
from PIL import Image
from scipy import ndimage

from .common import REPO_ROOT

G = 9.81
GRID = REPO_ROOT / "public" / "data" / "nh" / "depth.json"
OUT = REPO_ROOT / "public" / "cache" / "wavefield"
WW3 = REPO_ROOT / "public" / "cache" / "ww3"
STRIDE = 3            # 3 CRM cells → ≈270 m texture cells (320 × 260 for the region)
T_SCALE = 0.25        # seconds per 16-bit unit (max ≈ 4.5 h of travel)
H_MAX = 10.0          # metres at B = 255
SDF_SCALE = 16.0      # metres per unit in A (±2 km)
GAMMA = 0.78          # depth-limited breaking H / h
CF = 0.012            # bottom friction coefficient (Collins-type decay, applied over shallow travel)


def load_depth():
    import base64
    j = json.loads(GRID.read_text())
    a = np.frombuffer(base64.b64decode(j["data_b64"]), dtype="<u2").reshape(j["nlat"], j["nlon"]).astype(float) / 10.0
    return a, j["lat0"], j["lon0"], j["res"]


def phase_speed(h, T):
    """Linear-theory phase speed for depth h (m, >0) and period T (s); Newton on the dispersion relation."""
    h = np.maximum(h, 0.05); w = 2 * math.pi / T
    k = w * w / G * np.ones_like(h)
    for _ in range(8):
        th = np.tanh(k * h); f = G * k * th - w * w; df = G * th + G * k * h * (1 - th * th); k = k - f / df
    return w / k, k


def group_speed(h, T):
    c, k = phase_speed(h, T); kh = np.clip(k * np.maximum(h, 0.05), 1e-6, 50)
    return c * 0.5 * (1 + 2 * kh / np.sinh(2 * kh))


def sdf_metres(water: np.ndarray, res_m: float) -> np.ndarray:
    """Signed distance to the shoreline: positive over water, negative over land."""
    d_water = ndimage.distance_transform_edt(water) * res_m
    d_land = ndimage.distance_transform_edt(~water) * res_m
    return np.where(water, d_water, -d_land)


def travel_time(depth: np.ndarray, water: np.ndarray, T: float, dir_from_deg: float, res_m: float) -> np.ndarray:
    """Fast-marching arrival time (s) of a swell of period T arriving FROM dir_from_deg, from the up-wave grid edge."""
    c, _ = phase_speed(depth, T); c = np.where(water, c, 1e-3)
    # zero-time front: the up-wave boundary = the water cells nearest the edge the swell comes from (a 2-cell band)
    a = math.radians(dir_from_deg); ux, uy = math.sin(a), math.cos(a)           # unit vector pointing TO where it comes from (east, north)
    ny, nx = depth.shape; yy, xx = np.mgrid[0:ny, 0:nx]
    proj = xx * ux + yy * uy                                                      # cells with the largest projection are the most up-wave
    # source band = the up-wave 3 % of water cells: a straight slab perpendicular to the swell direction (a fixed cell margin
    # off the max would collapse to a corner for oblique directions)
    band = proj >= np.quantile(proj[water], 0.97)
    phi = np.where(band & water, -1.0, 1.0)                                       # φ < 0 inside the source band
    masked = np.ma.MaskedArray(phi, mask=~water)
    t = skfmm.travel_time(masked, speed=c, dx=res_m)
    t = np.ma.filled(t, 0.0)
    return np.where(water, t, 0.0)


def wave_height(depth: np.ndarray, water: np.ndarray, t: np.ndarray, H0: float, T: float, res_m: float) -> np.ndarray:
    """Shoaling + friction + breaking along the wave's own travel: H = H0 · Ks · Kf, then H ≤ γ h."""
    cg0 = group_speed(np.full_like(depth, 2000.0), T); cg = group_speed(depth, T)
    ks = np.sqrt(cg0 / np.maximum(cg, 1e-3))
    # friction: exponential decay with the travel time spent in water shallower than ~3 wavelengths, weighted by 1/h
    shallow = water & (depth < 1.56 * T * T * 1.5)
    weight = np.where(shallow, 1.0 / np.maximum(depth, 1.0), 0.0)
    # accumulate along increasing t: sort cells by t and cumulate weight·dt along the marching order (cheap proxy for ray integration)
    order = np.argsort(t, axis=None); flat_t = t.ravel()[order]; flat_w = weight.ravel()[order]
    dt = np.diff(flat_t, prepend=flat_t[0]); cum = np.cumsum(flat_w * dt); kf_flat = np.exp(-CF * cum / max(1.0, H0))
    kf = np.empty_like(flat_t); kf[order] = kf_flat; kf = kf.reshape(t.shape)
    H = H0 * ks * kf
    return np.where(water, np.minimum(H, GAMMA * np.maximum(depth, 0.05)), 0.0)


def boundary_conditions(step: dict, index: dict, water: np.ndarray, lat0: float, lon0: float, res: float, shape) -> tuple[float, float, float] | None:
    """Deep-water H_s, T_p, θ_m from the WW3 primary swell partition, averaged over the grid's deep cells (fallback: whole spectrum)."""
    F = step["fields"]; lat = np.array(index["lat"]); lon = np.array(index["lon"]); nlat, nlon = index["shape"]
    S, N = lat0, lat0 + shape[0] * res; W, E = lon0, lon0 + shape[1] * res
    vals = []
    for i in range(nlat):
        for j in range(nlon):
            if not (S <= lat[i] <= N and W <= lon[j] <= E): continue
            k = i * nlon + j
            hs = F.get("swell1_hs", F["hs"])[k]; tp = F.get("swell1_tp", F["tp"])[k]; dp = F.get("swell1_dp", F["dp"])[k]
            if hs is None or tp is None or dp is None: hs, tp, dp = F["hs"][k], F["tp"][k], F["dp"][k]
            if hs is None or tp is None or dp is None: continue
            vals.append((hs, tp, dp))
    if not vals: return None
    a = np.array(vals); hs = float(a[:, 0].mean()); tp = float(np.median(a[:, 1]))
    r = np.radians(a[:, 2]); dp = float(math.degrees(math.atan2(np.sin(r).mean(), np.cos(r).mean())) % 360)
    return hs, max(3.0, tp), dp


def encode(t: np.ndarray, H: np.ndarray, sdf: np.ndarray) -> np.ndarray:
    q = np.clip(np.round(t / T_SCALE), 0, 65535).astype(np.uint32)
    rgba = np.zeros(t.shape + (4,), np.uint8)
    rgba[..., 0] = (q >> 8) & 255; rgba[..., 1] = q & 255
    rgba[..., 2] = np.clip(np.round(H / H_MAX * 255), 0, 255)
    rgba[..., 3] = 255
    q0 = (rgba[..., 0].astype(int) == 0) & (rgba[..., 1].astype(int) == 0) & (sdf > 0)
    rgba[..., 1] = np.where(q0, 1, rgba[..., 1])          # water cells on the source band: t = 1 unit, never the land sentinel 0
    return rgba


def main() -> int:
    depth_full, lat0, lon0, res = load_depth()
    depth = depth_full[::STRIDE, ::STRIDE]; water = depth > 0
    res_deg = res * STRIDE; res_m = res_deg * 111320 * math.cos(math.radians(lat0 + depth.shape[0] * res_deg / 2))
    sdf = sdf_metres(water, res_m)
    index = json.loads((WW3 / "index.json").read_text())
    OUT.mkdir(parents=True, exist_ok=True)
    np.save(OUT / "sdf.npy", sdf.astype(np.float32)); np.save(OUT / "depth.npy", depth.astype(np.float32))
    steps = []
    for st in index["steps"]:
        step = json.loads((WW3 / st["file"]).read_text())
        bc = boundary_conditions(step, index, water, lat0, lon0, res_deg, depth.shape)
        if not bc: continue
        hs, tp, dp = bc
        t = travel_time(depth, water, tp, dp, res_m)
        H = wave_height(depth, water, t, hs, tp, res_m)
        rgba = encode(t, H, sdf)
        name = f"f{st['hour']:03d}.png"
        Image.fromarray(rgba[::-1], "RGBA").save(OUT / name, optimize=True)      # row 0 = north for the texture
        steps.append({"hour": st["hour"], "valid_time": st["valid_time"], "file": name, "hs0_m": round(hs, 2), "tp_s": round(tp, 1), "dir_from_deg": round(dp, 1),
                      "omega": round(2 * math.pi / tp, 5), "t_max_s": round(float(t[water].max()), 1)})
        print(f"{name}: swell {hs:.2f} m @ {tp:.1f} s from {dp:.0f}°, travel ≤ {t[water].max() / 60:.0f} min, H ≤ {H.max():.2f} m", flush=True)
    (OUT / "index.json").write_text(json.dumps({
        "cycle": index["cycle"], "generated_at": index.get("generated_at"), "source": "WW3 primary swell partition → eikonal travel time (skfmm) + linear shoaling / friction / γ-breaking on NOAA CRM 3″ (stride 3)",
        "bounds": [lon0, lat0, lon0 + depth.shape[1] * res_deg, lat0 + depth.shape[0] * res_deg], "shape": [depth.shape[0], depth.shape[1]], "res_deg": res_deg,
        "encoding": {"t_scale_s": T_SCALE, "h_max_m": H_MAX, "land": "t == 0", "rows": "north first"},
        "steps": steps}, indent=0))
    print(f"wrote {len(steps)} wavefield textures to {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

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

Texture packing (RGBA8 PNG, one per step, `shape` cells at `res_deg`); plus geometry.png (R,G = sdf m + 8192 16-bit, B = depth/2 m):
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
import heapq
from PIL import Image
from scipy import ndimage

from .common import REPO_ROOT

G = 9.81
GRID = REPO_ROOT / "public" / "data" / "nh" / "depth.json"
OUT = REPO_ROOT / "public" / "cache" / "wavefield"
WW3 = REPO_ROOT / "public" / "cache" / "ww3"
STRIDE = 2            # 2 CRM cells → ≈180 m texture cells (480 × 390 for the region)
DEPTH_SIGMA = 1.0     # Gaussian smoothing of the depth field (cells) before the speed map: no stair-steps along contours
T_SCALE = 0.25        # seconds per 16-bit unit (max ≈ 4.5 h of travel)
H_MAX = 10.0          # metres at B = 255
GAMMA = 0.78          # depth-limited breaking H / h
CF = 0.012            # empirical energy damping velocity (m/s); rate = CF / depth, not a validated Collins coefficient


def load_depth():
    import base64
    j = json.loads(GRID.read_text())
    a = np.frombuffer(base64.b64decode(j["data_b64"]), dtype="<u2").reshape(j["nlat"], j["nlon"]).astype(float) / 10.0
    return a, j["lat0"], j["lon0"], j["res"]


def phase_speed(h, T):
    """Linear-theory phase speed for depth h (m, >0) and period T (s); Newton on the dispersion relation."""
    h = np.maximum(h, 0.05); w = 2 * math.pi / T
    k = np.maximum(w * w / G, w / np.sqrt(G * h))
    for _ in range(16):
        th = np.tanh(k * h); f = G * k * th - w * w; df = G * th + G * k * h * (1 - th * th); k = k - f / df
    return w / k, k


def group_speed(h, T):
    c, k = phase_speed(h, T); kh = np.clip(k * np.maximum(h, 0.05), 1e-6, 50)
    return c * 0.5 * (1 + 2 * kh / np.sinh(2 * kh))


def sdf_metres(water: np.ndarray, res_m: float | tuple[float, float]) -> np.ndarray:
    """Signed distance to the shoreline: positive over water, negative over land."""
    d_water = ndimage.distance_transform_edt(water, sampling=res_m)
    d_land = ndimage.distance_transform_edt(~water, sampling=res_m)
    return np.where(water, d_water, -d_land)


def smooth_over_water(a: np.ndarray, water: np.ndarray, sigma: float) -> np.ndarray:
    """Normalised Gaussian convolution restricted to water cells (land never leaks into the average)."""
    if sigma <= 0: return a
    w = water.astype(float)
    num = ndimage.gaussian_filter(np.where(water, a, 0.0), sigma); den = ndimage.gaussian_filter(w, sigma)
    return np.where(water, num / np.maximum(den, 1e-6), a)


def metric_spacing(res_deg: float, latitude: float) -> tuple[float, float]:
    """Array-axis spacing (north/south dy, east/west dx), in metres."""
    return res_deg * 111320.0, res_deg * 111320.0 * math.cos(math.radians(latitude))


def inflow_mask(water: np.ndarray, direction: float) -> np.ndarray:
    a = math.radians(direction); ux, uy = math.sin(a), math.cos(a)
    source = np.zeros_like(water)
    if ux > 1e-8: source[:, -1] = True
    if ux < -1e-8: source[:, 0] = True
    if uy > 1e-8: source[-1, :] = True
    if uy < -1e-8: source[0, :] = True
    return source & water


def arrival_from_speed(speed: np.ndarray, water: np.ndarray, direction: float, spacing) -> np.ndarray:
    """Monotone fast marching with a phased plane-wave Dirichlet inflow boundary.

    Only open inflow edges inject energy. Enclosed water remains unreachable (NaN).
    The phase offset across two inflow edges preserves oblique wave incidence.
    """
    dy, dx = (spacing, spacing) if np.isscalar(spacing) else spacing
    ny, nx = water.shape; yy, xx = np.mgrid[:ny, :nx]
    a = math.radians(direction); proj = xx * dx * math.sin(a) + yy * dy * math.cos(a)
    source = inflow_mask(water, direction)
    t = np.full(water.shape, np.inf); accepted = np.zeros_like(water)
    if not source.any(): return np.full(water.shape, np.nan)
    c0 = float(np.median(speed[source]))
    t[source] = (proj[source].max() - proj[source]) / max(c0, 1e-3) + T_SCALE
    heap = [(float(t[y, x]), int(y), int(x)) for y, x in np.argwhere(source)]
    heapq.heapify(heap)
    def update(y, x):
        tx = min(t[y, x-1] if x and accepted[y, x-1] else np.inf,
                 t[y, x+1] if x+1 < nx and accepted[y, x+1] else np.inf)
        ty = min(t[y-1, x] if y and accepted[y-1, x] else np.inf,
                 t[y+1, x] if y+1 < ny and accepted[y+1, x] else np.inf)
        slow = 1.0 / max(speed[y, x], 1e-3)
        value = min(tx + dx * slow, ty + dy * slow)
        if np.isfinite(tx) and np.isfinite(ty):
            # Shift the quadratic by min(tx,ty) to avoid cancellation at long travel times.
            m = min(tx, ty); ax, ay = tx-m, ty-m
            A = 1/dx**2 + 1/dy**2; B = -2*(ax/dx**2 + ay/dy**2)
            C = ax**2/dx**2 + ay**2/dy**2 - slow**2
            root = m + (-B + math.sqrt(max(0.0, B*B - 4*A*C))) / (2*A)
            if root >= max(tx, ty): value = min(value, root)
        return value
    while heap:
        value, y, x = heapq.heappop(heap)
        if accepted[y, x] or value > t[y, x]: continue
        accepted[y, x] = True
        for j, i in ((y-1,x), (y+1,x), (y,x-1), (y,x+1)):
            if not (0 <= j < ny and 0 <= i < nx) or not water[j,i] or accepted[j,i] or source[j,i]: continue
            candidate = update(j,i)
            if candidate < t[j,i]:
                t[j,i] = candidate; heapq.heappush(heap, (candidate,j,i))
    return np.where(water & np.isfinite(t), t, np.nan)


def travel_time(depth: np.ndarray, water: np.ndarray, T: float, dir_from_deg: float, res_m) -> np.ndarray:
    c, _ = phase_speed(smooth_over_water(depth, water, DEPTH_SIGMA), T)
    return arrival_from_speed(c, water, dir_from_deg, res_m)


def path_integral(t: np.ndarray, weight: np.ndarray, water: np.ndarray, spacing, sources=None) -> np.ndarray:
    """Integrate local attenuation along upstream characteristics, never global rank order."""
    dy, dx = (spacing, spacing) if np.isscalar(spacing) else spacing
    ny, nx = t.shape; out = np.zeros_like(t)
    wet = water & np.isfinite(t)
    for flat in np.argsort(np.where(wet, t, np.inf), axis=None):
        y, x = divmod(int(flat), nx)
        if not wet[y,x]: break
        if sources is not None and sources[y,x]: continue
        values, weights = [], []
        for j,i,d in ((y-1,x,dy),(y+1,x,dy),(y,x-1,dx),(y,x+1,dx)):
            if not (0 <= j < ny and 0 <= i < nx) or not wet[j,i]: continue
            dt = t[y,x] - t[j,i]
            if dt <= 1e-9: continue
            weights.append(dt / d**2)
            values.append(out[j,i] + 0.5 * (weight[y,x] + weight[j,i]) * dt)
        if weights: out[y,x] = np.dot(values, weights) / sum(weights)
    return out


def wave_height(depth: np.ndarray, water: np.ndarray, t: np.ndarray, H0: float, T: float, res_m, sources=None) -> np.ndarray:
    """Linear shoaling plus empirical path-local friction and a depth-limited cap.

    This monochromatic approximation does not model spectral transfer, reflection or diffraction.
    """
    cg0 = group_speed(np.full_like(depth, 2000.0), T); cg = group_speed(depth, T)
    ks = np.sqrt(cg0 / np.maximum(cg, 1e-3))
    wet = water & np.isfinite(t)
    c, _ = phase_speed(depth, T)
    # Travel time follows phase; energy travels at group speed. Convert dt_phase to dt_group.
    weight = np.where(wet & (depth < 1.56*T*T*1.5), CF * c / np.maximum(cg, 1e-3) / np.maximum(depth, 1.0), 0.0)
    loss = path_integral(t, weight, wet, res_m, sources)
    H = H0 * ks * np.exp(-0.5 * loss)  # E ∝ H²
    return np.where(wet, np.minimum(H, GAMMA * np.maximum(depth, 0.05)), 0.0)


def boundary_conditions(step: dict, index: dict, water: np.ndarray, lat0: float, lon0: float, res: float, shape) -> tuple[float, float, float] | None:
    """Regional primary-swell summary over WW3 cells in the domain (fallback: bulk sea).

    No depth selection or spatially varying boundary spectrum is available here.
    """
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


def encode_geometry(sdf: np.ndarray, depth: np.ndarray) -> np.ndarray:
    """Static geometry texture: R,G = signed distance to the shoreline (metres + 8192, 16-bit), B = depth / 2 m (0–510 m), A = 255."""
    q = np.clip(np.round(sdf + 8192), 0, 65535).astype(np.uint32)
    rgba = np.zeros(sdf.shape + (4,), np.uint8)
    rgba[..., 0] = (q >> 8) & 255; rgba[..., 1] = q & 255
    rgba[..., 2] = np.clip(np.round(depth / 2.0), 0, 255); rgba[..., 3] = 255
    return rgba


def encode(t: np.ndarray, H: np.ndarray, sdf: np.ndarray) -> np.ndarray:
    valid = (sdf > 0) & np.isfinite(t) & (t <= 65535 * T_SCALE)
    q = np.where(valid, np.clip(np.round(np.nan_to_num(t) / T_SCALE), 1, 65535), 0).astype(np.uint32)
    rgba = np.zeros(t.shape + (4,), np.uint8)
    rgba[..., 0] = (q >> 8) & 255; rgba[..., 1] = q & 255
    rgba[..., 2] = np.where(valid, np.clip(np.round(H / H_MAX * 255), 0, 255), 0)
    rgba[..., 3] = 255
    return rgba


def main() -> int:
    depth_full, lat0, lon0, res = load_depth()
    depth = depth_full[::STRIDE, ::STRIDE]; water = depth > 0
    res_deg = res * STRIDE; res_m = metric_spacing(res_deg, lat0 + (depth.shape[0] - 1) * res_deg / 2)
    sdf = sdf_metres(water, res_m)
    index = json.loads((WW3 / "index.json").read_text())
    OUT.mkdir(parents=True, exist_ok=True)
    np.save(OUT / "sdf.npy", sdf.astype(np.float32)); np.save(OUT / "depth.npy", depth.astype(np.float32))
    Image.fromarray(encode_geometry(sdf, depth)[::-1], "RGBA").save(OUT / "geometry.png", optimize=True)
    steps = []
    for st in index["steps"]:
        step = json.loads((WW3 / st["file"]).read_text())
        bc = boundary_conditions(step, index, water, lat0, lon0, res_deg, depth.shape)
        if not bc: continue
        hs, tp, dp = bc
        t = travel_time(depth, water, tp, dp, res_m)
        H = wave_height(depth, water, t, hs, tp, res_m, inflow_mask(water, dp))
        rgba = encode(t, H, sdf)
        name = f"f{st['hour']:03d}.png"
        Image.fromarray(rgba[::-1], "RGBA").save(OUT / name, optimize=True)      # row 0 = north for the texture
        steps.append({"hour": st["hour"], "valid_time": st["valid_time"], "file": name, "hs0_m": round(hs, 2), "tp_s": round(tp, 1), "dir_from_deg": round(dp, 1),
                      "omega": round(2 * math.pi / tp, 5), "t_max_s": round(float(np.nanmax(t[water])), 1)})
        print(f"{name}: swell {hs:.2f} m @ {tp:.1f} s from {dp:.0f}°, travel ≤ {np.nanmax(t[water]) / 60:.0f} min, H ≤ {H.max():.2f} m", flush=True)
    (OUT / "index.json").write_text(json.dumps({
        "cycle": index["cycle"], "generated_at": index.get("generated_at"), "solver_version": 2, "source": "WW3 primary swell; metric eikonal, empirical path-local friction, linear shoaling and depth cap; not a validated surf-height model",
        "bounds": [lon0 - res_deg/2, lat0 - res_deg/2, lon0 + (depth.shape[1] - 0.5) * res_deg, lat0 + (depth.shape[0] - 0.5) * res_deg], "shape": [depth.shape[0], depth.shape[1]], "res_deg": res_deg,
        "encoding": {"t_scale_s": T_SCALE, "h_max_m": H_MAX, "land": "t == 0", "rows": "north first", "geometry": {"file": "geometry.png", "sdf_offset_m": 8192, "depth_scale_m": 2}},
        "steps": steps}, indent=0))
    print(f"wrote {len(steps)} wavefield textures to {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

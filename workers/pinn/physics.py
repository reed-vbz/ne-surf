"""
Differentiable wave physics shared by the loss function, the teacher and the inference fallback (PyTorch).

  dispersion   ω² = g k tanh(k h)                     → k(h, T) by Newton, c = ω/k, c_g = c · ½(1 + 2kh / sinh 2kh)
  shoaling     H = H0 · √(c_g0 / c_g)                 (energy flux conservation along a ray, no refraction term)
  friction     dE/ds = −C_f · E / h                   (Collins-type bottom friction, applied on the group velocity path)
  breaking     H ≤ γ h, γ = 0.78                      (depth-limited, Miche/McCowan)
  energy balance residual   ∇·(c_g E ĉ) + D_f + D_b   (steady, spectral-mean, ĉ = unit wave direction)
Everything is written with torch ops so the same functions serve as loss terms (autograd) and as the physics teacher
that produces targets when no SWAN output is available.
"""
from __future__ import annotations

import math

import torch

G = 9.81
GAMMA = 0.78
CF = 0.012


def wavenumber(h: torch.Tensor, T: torch.Tensor, iters: int = 8) -> torch.Tensor:
    """k from ω² = g k tanh(k h) by Newton iteration (vectorised, differentiable)."""
    h = h.clamp_min(0.05); w = 2 * math.pi / T
    k = (w * w / G) * torch.ones_like(h)
    for _ in range(iters):
        th = torch.tanh(k * h); f = G * k * th - w * w; df = G * th + G * k * h * (1 - th * th)
        k = k - f / df
    return k


def phase_speed(h: torch.Tensor, T: torch.Tensor) -> torch.Tensor:
    return (2 * math.pi / T) / wavenumber(h, T)


def group_speed(h: torch.Tensor, T: torch.Tensor) -> torch.Tensor:
    k = wavenumber(h, T); kh = (k * h.clamp_min(0.05)).clamp(1e-6, 50)
    return phase_speed(h, T) * 0.5 * (1 + 2 * kh / torch.sinh(2 * kh))


def shoaling(H0: torch.Tensor, h: torch.Tensor, T: torch.Tensor) -> torch.Tensor:
    cg0 = group_speed(torch.full_like(h, 2000.0), T); cg = group_speed(h, T)
    return H0 * torch.sqrt(cg0 / cg.clamp_min(1e-3))


def breaking_limit(H: torch.Tensor, h: torch.Tensor) -> torch.Tensor:
    return torch.minimum(H, GAMMA * h.clamp_min(0.05))


def dispersion_residual(k: torch.Tensor, h: torch.Tensor, T: torch.Tensor) -> torch.Tensor:
    """(ω² − g k tanh(k h)) / ω²: zero when the predicted wavenumber satisfies the dispersion relation."""
    w2 = (2 * math.pi / T) ** 2
    return (w2 - G * k * torch.tanh(k * h.clamp_min(0.05))) / w2


def energy_balance_residual(H: torch.Tensor, theta: torch.Tensor, h: torch.Tensor, T: torch.Tensor, water: torch.Tensor, dx: float) -> torch.Tensor:
    """
    Steady wave-action balance residual per cell:  ∇·(c_g E ĉ) + D_friction + D_breaking, normalised by c_g E / dx.
    E = H²/16 (variance), ĉ = (sin θ, cos θ) is the propagation direction (θ = direction TO, radians clockwise from north),
    D_friction = C_f E / h · c_g, D_breaking = c_g E · max(0, 1 − (γ h / H)²) / dx (energy above the breaking limit is lost).
    Gradients use central differences over water cells only (land neighbours are excluded).
    """
    E = (H * H) / 16
    cg = group_speed(h, T)
    fx = cg * E * torch.sin(theta) * water; fy = cg * E * torch.cos(theta) * water
    dfx = (torch.roll(fx, -1, dims=-1) - torch.roll(fx, 1, dims=-1)) / (2 * dx)
    dfy = (torch.roll(fy, -1, dims=-2) - torch.roll(fy, 1, dims=-2)) / (2 * dx)
    div = dfx + dfy
    d_fric = CF * E / h.clamp_min(1.0) * cg
    over = (1 - (GAMMA * h.clamp_min(0.05) / H.clamp_min(1e-3)) ** 2).clamp_min(0)
    d_break = cg * E * over / dx
    scale = (cg * E / dx).clamp_min(1e-6)
    return ((div + d_fric + d_break) / scale) * water


def snell_direction(theta0: torch.Tensor, h: torch.Tensor, T: torch.Tensor, normal: torch.Tensor) -> torch.Tensor:
    """Refracted direction from Snell's law: sin(θ − n) · c_deep = sin(θ' − n) · c(h). `normal` = up-slope bearing (rad)."""
    c1 = phase_speed(torch.full_like(h, 2000.0), T); c2 = phase_speed(h, T)
    s = (torch.sin(theta0 - normal) * c2 / c1).clamp(-1, 1)
    return normal + torch.asin(s)

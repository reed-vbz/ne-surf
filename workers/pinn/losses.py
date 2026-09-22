"""
Composite physics-informed loss:  L = L_MSE + λ1 · L_energy_balance + λ2 · L_dispersion  (+ soft constraints)

  L_MSE               data term against the teacher / SWAN fields (H_s, T_p, θ, k), water cells only
  L_energy_balance    steady wave-action balance residual with bottom friction and depth-limited breaking (physics.py)
  L_dispersion        (ω² − g k tanh(k h))² / ω⁴ on the predicted wavenumber
  shoaling            H must not fall below the linear-shoaling prediction where nothing dissipates (h > 3 H0 and deep): hinge
  breaking            H ≤ γ h everywhere: hinge on the excess
  land                the field must vanish over land: H, k → 0 where water == 0
"""
from __future__ import annotations

import torch
import torch.nn.functional as F

from . import physics as P


def pinn_loss(pred: torch.Tensor, target: torch.Tensor | None, x: torch.Tensor, dx: float, lam1: float = 0.1, lam2: float = 1.0, lam_soft: float = 0.5) -> tuple[torch.Tensor, dict[str, float]]:
    """pred/target: (B, 4, H, W) = [H_s, T_p, θ_to, k]; x: input tensor (B, C, H, W) from tensors.py."""
    depth = x[:, 0:1] * 100.0; water = x[:, 2:3]; hs0 = x[:, 3:4] * 5.0
    hs, tp, theta, k = pred[:, 0:1], pred[:, 1:2], pred[:, 2:3], pred[:, 3:4]
    terms: dict[str, torch.Tensor] = {}
    if target is not None:
        w = water
        terms["mse"] = (F.mse_loss(hs * w, target[:, 0:1] * w) + 0.05 * F.mse_loss(tp * w, target[:, 1:2] * w)
                        + F.mse_loss(torch.sin(theta) * w, torch.sin(target[:, 2:3]) * w) + F.mse_loss(torch.cos(theta) * w, torch.cos(target[:, 2:3]) * w)
                        + 100.0 * F.mse_loss(k * w, target[:, 3:4] * w))
    else:
        terms["mse"] = torch.zeros((), device=pred.device)
    terms["energy"] = lam1 * (P.energy_balance_residual(hs, theta, depth, tp, water, dx) ** 2).mean()
    terms["dispersion"] = lam2 * ((P.dispersion_residual(k, depth, tp) ** 2) * water).mean()
    deep = (depth > 3 * hs0) & (water > 0.5)
    shoal = P.shoaling(hs0, depth, tp)
    terms["shoaling"] = lam_soft * (F.relu(shoal - hs) * deep).pow(2).mean()
    terms["breaking"] = lam_soft * (F.relu(hs - P.GAMMA * depth.clamp_min(0.05)) * water).pow(2).mean()
    terms["land"] = lam_soft * ((hs * (1 - water)).pow(2).mean() + (k * (1 - water)).pow(2).mean())
    total = sum(terms.values())
    return total, {n: float(v.detach()) for n, v in terms.items()}

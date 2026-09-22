"""
U-Net surrogate for SWAN (steady nearshore wave transformation) with a ConvLSTM bottleneck for sequence inputs.

  in  : (B, C_in, H, W)  input tensor from tensors.py (depth, SDF, water, boundary H_s/T_p/θ, wind)
  out : (B, 4, H, W)     H_s (m), T_p (s), θ (rad, direction TO), k (rad/m)  — all positive-constrained where physical

Sub-second inference on CPU at 260 × 320 (≈ 1.9 M parameters at base=24). The ConvLSTM is used when a time sequence
(B, S, C, H, W) is passed: the network then emulates the evolution of the field over consecutive WW3 steps.
"""
from __future__ import annotations

import math

import torch
import torch.nn as nn
import torch.nn.functional as F


def block(cin: int, cout: int) -> nn.Sequential:
    return nn.Sequential(nn.Conv2d(cin, cout, 3, padding=1), nn.GroupNorm(8, cout), nn.SiLU(), nn.Conv2d(cout, cout, 3, padding=1), nn.GroupNorm(8, cout), nn.SiLU())


class ConvLSTMCell(nn.Module):
    def __init__(self, ch: int):
        super().__init__(); self.gates = nn.Conv2d(2 * ch, 4 * ch, 3, padding=1); self.ch = ch
    def forward(self, x, state):
        h, c = state
        i, f, o, g = torch.chunk(self.gates(torch.cat([x, h], 1)), 4, dim=1)
        c = torch.sigmoid(f) * c + torch.sigmoid(i) * torch.tanh(g)
        h = torch.sigmoid(o) * torch.tanh(c)
        return h, (h, c)


class SwanUNet(nn.Module):
    def __init__(self, c_in: int = 8, base: int = 24):
        super().__init__()
        self.e1 = block(c_in, base); self.e2 = block(base, base * 2); self.e3 = block(base * 2, base * 4); self.e4 = block(base * 4, base * 8)
        self.lstm = ConvLSTMCell(base * 8)
        self.d3 = block(base * 8 + base * 4, base * 4); self.d2 = block(base * 4 + base * 2, base * 2); self.d1 = block(base * 2 + base, base)
        self.head = nn.Conv2d(base, 4, 1)
        self.c_in = c_in

    def _encode(self, x):
        e1 = self.e1(x); e2 = self.e2(F.max_pool2d(e1, 2)); e3 = self.e3(F.max_pool2d(e2, 2)); e4 = self.e4(F.max_pool2d(e3, 2))
        return e1, e2, e3, e4

    def _decode(self, e1, e2, e3, b):
        up = lambda t, ref: F.interpolate(t, size=ref.shape[-2:], mode="bilinear", align_corners=False)
        d3 = self.d3(torch.cat([up(b, e3), e3], 1)); d2 = self.d2(torch.cat([up(d3, e2), e2], 1)); d1 = self.d1(torch.cat([up(d2, e1), e1], 1))
        raw = self.head(d1)
        hs = F.softplus(raw[:, 0:1]); tp = 3.0 + F.softplus(raw[:, 1:2]); theta = raw[:, 2:3]; k = F.softplus(raw[:, 3:4]) + 1e-4
        return torch.cat([hs, tp, theta, k], 1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """x: (B, C, H, W) single step, or (B, S, C, H, W) sequence (ConvLSTM carries state across S)."""
        if x.dim() == 4:
            e1, e2, e3, e4 = self._encode(x)
            state = (torch.zeros_like(e4), torch.zeros_like(e4)); b, _ = self.lstm(e4, state)
            return self._decode(e1, e2, e3, b)
        outs = []; state = None
        for s in range(x.shape[1]):
            e1, e2, e3, e4 = self._encode(x[:, s])
            if state is None: state = (torch.zeros_like(e4), torch.zeros_like(e4))
            b, state = self.lstm(e4, state); outs.append(self._decode(e1, e2, e3, b))
        return torch.stack(outs, 1)


def count_params(m: nn.Module) -> int:
    return sum(p.numel() for p in m.parameters())

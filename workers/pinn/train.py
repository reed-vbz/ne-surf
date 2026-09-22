"""
Train the SWAN-PINN surrogate.

    PYTHONPATH=. .venv/bin/python -m pinn.train --epochs 30 --samples 200     # -> workers/.scratch/pinn/checkpoint.pt

Targets come from the physics teacher (teacher.py) over a randomised sweep of deep-water boundary conditions
(H_s 0.3–5 m, T_p 4–17 s, θ across the open-sea arc); point `--swan DIR` at SWAN output (.npz with hs/tp/theta/k on the
geometry grid) to train against a real model instead. The loss is the composite PINN loss (losses.py), so even with the
teacher the network is penalised for violating the dispersion relation, the wave-action balance, shoaling, breaking and
the land mask — not just for mismatching the target.
"""
from __future__ import annotations

import argparse
import random
import time
from pathlib import Path

import numpy as np
import torch

from .losses import pinn_loss
from .model import SwanUNet, count_params
from .teacher import teacher_fields
from .tensors import input_tensor, load_geometry

CKPT = Path(__file__).resolve().parents[1] / ".scratch" / "pinn" / "checkpoint.pt"


def sample_bc(rng: random.Random) -> tuple[float, float, float, float]:
    return rng.uniform(0.3, 5.0), rng.uniform(4.0, 17.0), rng.uniform(20.0, 200.0), rng.uniform(0.0, 15.0)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--epochs", type=int, default=20); ap.add_argument("--samples", type=int, default=120); ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--base", type=int, default=24); ap.add_argument("--swan", type=Path, default=None, help="directory of SWAN .npz targets (hs, tp, theta, k, hs0, tp0, dir0)")
    ap.add_argument("--seed", type=int, default=7); ap.add_argument("--out", type=Path, default=CKPT)
    a = ap.parse_args(argv)
    torch.manual_seed(a.seed); rng = random.Random(a.seed)
    geom = load_geometry(); dx = float(geom["res_m"])
    model = SwanUNet(c_in=8, base=a.base); opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=a.epochs)
    print(f"SwanUNet base={a.base}: {count_params(model) / 1e6:.2f} M params, grid {geom['depth'].shape} at {dx:.0f} m")

    # dataset: (input, target) pairs, teacher or SWAN
    data = []
    if a.swan:
        for f in sorted(a.swan.glob("*.npz")):
            z = np.load(f); data.append((input_tensor(geom, float(z["hs0"]), float(z["tp0"]), float(z["dir0"]), 0.0), torch.from_numpy(np.stack([z["hs"], z["tp"], z["theta"], z["k"]]).astype(np.float32))[None]))
    else:
        t0 = time.time()
        for _ in range(a.samples):
            hs0, tp, d, wind = sample_bc(rng)
            data.append((input_tensor(geom, hs0, tp, d, wind), teacher_fields(geom, hs0, tp, d)))
        print(f"teacher generated {len(data)} fields in {time.time() - t0:.1f} s")

    for ep in range(a.epochs):
        rng.shuffle(data); tot = 0.0; parts: dict[str, float] = {}
        for x, y in data:
            pred = model(x); loss, terms = pinn_loss(pred, y, x, dx)
            opt.zero_grad(); loss.backward(); torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0); opt.step()
            tot += float(loss); parts = {k: parts.get(k, 0) + v for k, v in terms.items()}
        sched.step()
        print(f"epoch {ep + 1:3d}  loss {tot / len(data):.4f}  " + "  ".join(f"{k} {v / len(data):.4f}" for k, v in parts.items()), flush=True)
    a.out.parent.mkdir(parents=True, exist_ok=True)
    torch.save({"state_dict": model.state_dict(), "base": a.base, "c_in": 8, "grid": list(geom["depth"].shape), "res_m": dx}, a.out)
    print(f"saved {a.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

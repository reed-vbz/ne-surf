"""
Real-time inference API (FastAPI).

    PYTHONPATH=. .venv/bin/uvicorn pinn.api:app --port 8100

  GET  /health                        model source (checkpoint | physics-teacher), grid, buoy calibration in force
  POST /infer   {hs0_m, tp_s, dir_from_deg, wind_ms?}   → JSON summary + texture URL fields (hs/tp/theta/k stats)
  GET  /infer.png?hs0_m=&tp_s=&dir_from_deg=            → RGBA texture for the Rolling Wavefronts shader
  GET  /infer.f32?…                                      → Float32 planar (4, H, W) for a raw data texture / UBO
  GET  /index.json + /fNNN.png                           → the same contract as the published cache (drop-in for
                                                          NEXT_PUBLIC_PINN_API): every WW3 step, inferred on request

Inference: the U-Net checkpoint when workers/.scratch/pinn/checkpoint.pt exists AND its held-out metrics (recorded by
train.py) pass GATE, else the physics teacher (identical outputs to the published textures); /health reports both. Calibration: the H_s field is scaled by the live NDBC ratio obs / model from the
calibration worker (buoys 44097 and 44098 — 44018 has been offline/404 since at least 2026-09-21), damped by pair count.
"""
from __future__ import annotations

import json
import math
from functools import lru_cache
from pathlib import Path

import numpy as np
import torch
from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from .model import SwanUNet
from .teacher import teacher_fields
from .tensors import boundary_from_ww3, input_tensor, load_geometry, ww3_steps
from .texture import ENCODING, to_float32, to_texture_png

ROOT = Path(__file__).resolve().parents[2]
CKPT = ROOT / "workers" / ".scratch" / "pinn" / "checkpoint.pt"
CAL = ROOT / "public" / "cache" / "calibration" / "latest.json"
CAL_BUOYS = ("44097", "44098")

app = FastAPI(title="ne-surf SWAN-PINN inference", version="0.1")


@lru_cache(maxsize=1)
def geometry():
    return load_geometry()


# a checkpoint is served only when it beats these held-out thresholds against the physics teacher (train.py records them);
# otherwise the API keeps the teacher and /health says so — an under-trained network never degrades the live field
GATE = {"hs_mae_m": 0.10, "k_rel_err": 0.15}


@lru_cache(maxsize=1)
def checkpoint() -> dict | None:
    return torch.load(CKPT, map_location="cpu") if CKPT.exists() else None


def checkpoint_passes(ck: dict | None) -> bool:
    m = (ck or {}).get("metrics")
    return bool(m) and m["hs_mae_m"] <= GATE["hs_mae_m"] and m["k_rel_err"] <= GATE["k_rel_err"]


@lru_cache(maxsize=1)
def model() -> SwanUNet | None:
    ck = checkpoint()
    if not ck or not checkpoint_passes(ck): return None
    m = SwanUNet(c_in=ck["c_in"], base=ck["base"]); m.load_state_dict(ck["state_dict"]); m.eval()
    return m


def calibration_ratio() -> tuple[float, dict]:
    """Damped obs/model H_s ratio from the live buoy calibration (mean over the calibration buoys that report)."""
    if not CAL.exists(): return 1.0, {}
    j = json.loads(CAL.read_text()); used = {}
    for b in CAL_BUOYS:
        r = j.get("buoys", {}).get(b)
        if r and r.get("ratio_hs") and not r.get("low_confidence"): used[b] = {"ratio_hs": r["ratio_hs"], "n_pairs": r["n_pairs"]}
    if not used: return 1.0, {}
    ratios = [v["ratio_hs"] for v in used.values()]; n = sum(v["n_pairs"] for v in used.values())
    damped = 1.0 + (float(np.mean(ratios)) - 1.0) * min(1.0, n / 24.0)
    return float(np.clip(damped, 0.5, 2.0)), used


class Boundary(BaseModel):
    hs0_m: float = Field(gt=0, le=15); tp_s: float = Field(ge=3, le=25); dir_from_deg: float = Field(ge=0, lt=360); wind_ms: float = 0.0


def infer(bc: Boundary) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, str]:
    g = geometry(); m = model()
    with torch.no_grad():
        if m is not None:
            out = m(input_tensor(g, bc.hs0_m, bc.tp_s, bc.dir_from_deg, bc.wind_ms))[0].numpy(); src = "checkpoint"
        else:
            out = teacher_fields(g, bc.hs0_m, bc.tp_s, bc.dir_from_deg)[0].numpy(); src = "physics-teacher"
    ratio, _ = calibration_ratio()
    hs = out[0] * ratio
    return hs, out[1], out[2], out[3], src


@app.get("/health")
def health():
    g = geometry(); ratio, used = calibration_ratio()
    ck = checkpoint()
    return {"model": "checkpoint" if model() is not None else "physics-teacher", "checkpoint": None if not ck else {"metrics": ck.get("metrics"), "epochs": ck.get("epochs"), "samples": ck.get("samples"), "passes_gate": checkpoint_passes(ck), "gate": GATE},
            "grid": list(g["depth"].shape), "res_m": g["res_m"], "calibration": {"ratio_hs": ratio, "buoys": used}}


@app.post("/infer")
def infer_json(bc: Boundary):
    hs, tp, th, k, src = infer(bc); g = geometry(); w = g["water"]
    return {"source": src, "hs_m": {"max": float(hs[w].max()), "mean": float(hs[w].mean())}, "tp_s": float(np.median(tp[w])), "k_rad_m": {"min": float(k[w].min()), "max": float(k[w].max())},
            "texture": f"/infer.png?hs0_m={bc.hs0_m}&tp_s={bc.tp_s}&dir_from_deg={bc.dir_from_deg}", "float32": f"/infer.f32?hs0_m={bc.hs0_m}&tp_s={bc.tp_s}&dir_from_deg={bc.dir_from_deg}", "encoding": ENCODING}


@app.get("/infer.png")
def infer_png(hs0_m: float = Query(gt=0), tp_s: float = Query(ge=3), dir_from_deg: float = Query(ge=0, lt=360), wind_ms: float = 0.0):
    bc = Boundary(hs0_m=hs0_m, tp_s=tp_s, dir_from_deg=dir_from_deg, wind_ms=wind_ms); hs, _, _, k, _ = infer(bc); g = geometry()
    return Response(to_texture_png(hs, k, g["water"], g["sdf"], tp_s, dir_from_deg, float(g["res_m"])), media_type="image/png", headers={"Cache-Control": "public, max-age=600"})


@app.get("/infer.f32")
def infer_f32(hs0_m: float = Query(gt=0), tp_s: float = Query(ge=3), dir_from_deg: float = Query(ge=0, lt=360), wind_ms: float = 0.0):
    hs, tp, th, k, _ = infer(Boundary(hs0_m=hs0_m, tp_s=tp_s, dir_from_deg=dir_from_deg, wind_ms=wind_ms))
    return Response(to_float32(hs, tp, th, k), media_type="application/octet-stream", headers={"X-Shape": f"4,{hs.shape[0]},{hs.shape[1]}"})


@app.get("/index.json")
def index():
    """Drop-in for the published cache: one entry per WW3 step, textures inferred on request at /fNNN.png."""
    g = geometry(); h, w = g["depth"].shape; steps = []
    for st, step, idx in ww3_steps():
        hs0, tp, d, _ = boundary_from_ww3(step, idx, g)
        steps.append({"hour": st["hour"], "valid_time": st["valid_time"], "file": f"f{st['hour']:03d}.png", "hs0_m": round(hs0, 2), "tp_s": round(tp, 1), "dir_from_deg": round(d, 1), "omega": round(2 * math.pi / tp, 5), "t_max_s": None})
    return JSONResponse({"cycle": "live", "source": "pinn.api " + ("checkpoint" if model() else "physics-teacher"), "bounds": [g["lon0"], g["lat0"], g["lon0"] + w * g["res_deg"], g["lat0"] + h * g["res_deg"]], "shape": [h, w], "res_deg": g["res_deg"], "encoding": ENCODING, "steps": steps})


@app.get("/f{hour}.png")
def step_png(hour: int):
    g = geometry()
    for st, step, idx in ww3_steps():
        if st["hour"] == hour:
            hs0, tp, d, wind = boundary_from_ww3(step, idx, g); hs, _, _, k, _ = infer(Boundary(hs0_m=hs0, tp_s=tp, dir_from_deg=d, wind_ms=wind))
            return Response(to_texture_png(hs, k, g["water"], g["sdf"], tp, d, float(g["res_m"])), media_type="image/png")
    return JSONResponse({"error": "no such step"}, status_code=404)

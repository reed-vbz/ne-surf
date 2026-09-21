#!/bin/zsh
# Runs the full NOAA ingest into public/cache. Safe to run any time; each worker picks the latest complete cycle.
set -euo pipefail
cd "$(dirname "$0")/../workers"
PY=.venv/bin/python
[ -x "$PY" ] || { echo "workers/.venv missing — run: cd workers && uv venv .venv && uv pip install -p .venv/bin/python -e ." >&2; exit 1; }
$PY -m nesurf.fetch_ww3 --source aws --hours 0:168:3
$PY -m nesurf.fetch_hrrr --res 0.05
$PY -m nesurf.fetch_ndbc
$PY -m nesurf.fetch_tides
$PY -m nesurf.calibrate
echo "ingest done $(date -u +%FT%TZ)"

#!/bin/bash
# Lance la voix de Claire (Kokoro-FastAPI) sur le Mac, avec la puce graphique (MPS).
# Utilisé par le service fr.hackathon2026.kokoro ; « bash mac/kokoro.sh --installer » prépare seulement
# l'environnement (dépendances Python et modèle) puis s'arrête.
# Remplace start-gpu_mac.sh de Kokoro-FastAPI, qui échoue sur une installation neuve (pas
# d'environnement Python) et écoute sur tout le réseau local.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/server/kokoro"

export USE_GPU=true DEVICE_TYPE=mps PYTORCH_ENABLE_MPS_FALLBACK=1
export PYTHONPATH="$PWD:$PWD/api" MODEL_DIR=src/models VOICES_DIR=src/voices/v1_0 WEB_PLAYER_PATH="$PWD/web"

# environnement Python (version fixée par Kokoro dans .python-version) et dépendances
[[ -x .venv/bin/python ]] || uv venv
if [[ ! -f .venv/.pret-ok || pyproject.toml -nt .venv/.pret-ok || "$ROOT/mac/kokoro-overrides.txt" -nt .venv/.pret-ok ]]; then
  # --only-binary av : version de PyAV fournie toute prête pour cette version de macOS
  uv pip install -e . --overrides "$ROOT/mac/kokoro-overrides.txt" --only-binary av
  touch .venv/.pret-ok
fi
# modèle : téléchargé la première fois, vérifié ensuite (empreinte)
uv run --no-sync python docker/scripts/download_model.py --output api/src/models/v1_0

[[ "${1:-}" == "--installer" ]] && exit 0
exec uv run --no-sync uvicorn api.src.main:app --host 127.0.0.1 --port 8880

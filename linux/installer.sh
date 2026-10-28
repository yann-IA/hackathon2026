#!/bin/bash
# Installe Claire (édition Hackathon 2026) sur un serveur Linux (Ubuntu 22.04/24.04 ou Debian 12),
# avec ou sans carte graphique NVIDIA. Voir docs/INSTALLATION-SERVEUR-LINUX.md.
#
#   sudo bash linux/installer.sh
#
# Installe : Node.js 22, Ollama (modèle de langue + empreintes), Kokoro-FastAPI (voix, conteneur
# Docker), whisper.cpp (écoute, facultatif), outils de lecture des PDF scannés, et le serveur de
# Claire comme service systemd. Tous les services n'écoutent que sur 127.0.0.1 : l'accès depuis
# l'extérieur passe par le proxy inverse HTTPS de votre choix (exemples dans linux/).
# Le script peut être relancé sans risque.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/hackathon2026}"
APP_USER="${APP_USER:-claire}"
REPO="${REPO:-https://github.com/yann-IA/hackathon2026.git}"
LLM_MODEL="${LLM_MODEL:-mistral-nemo}"
EMBED_MODEL="${EMBED_MODEL:-bge-m3}"
WITH_WHISPER="${WITH_WHISPER:-1}"      # 0 : pas d'écoute côté serveur (les navigateurs récents s'en chargent)
WHISPER_MODEL="${WHISPER_MODEL:-small}"
OLLAMA_PARALLEL="${OLLAMA_PARALLEL:-4}"

say() { printf '\n\033[1;33m▶ %s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "À lancer avec sudo : sudo bash linux/installer.sh"; exit 1; }
command -v apt-get >/dev/null || { echo "Ce script vise Ubuntu/Debian (apt). Voir la documentation pour une installation manuelle."; exit 1; }
GPU=0
if command -v nvidia-smi >/dev/null && nvidia-smi -L >/dev/null 2>&1; then GPU=1; fi

# ---------------------------------------------------------------------------- paquets
say "Paquets système"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates git build-essential cmake tesseract-ocr tesseract-ocr-fra poppler-utils >/dev/null
if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
ok "node $(node -v), tesseract (PDF scannés), poppler, outils de compilation"
[[ $GPU == 1 ]] && ok "carte graphique NVIDIA : $(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | head -1)" || warn "pas de carte graphique NVIDIA détectée : tout fonctionnera sur le processeur, plus lentement"

# ------------------------------------------------------------------------------ Ollama
say "Modèle de langue (Ollama)"
command -v ollama >/dev/null || curl -fsSL https://ollama.com/install.sh | sh
mkdir -p /etc/systemd/system/ollama.service.d
cat >/etc/systemd/system/ollama.service.d/claire.conf <<EOF
[Service]
Environment="OLLAMA_HOST=127.0.0.1:11434"
Environment="OLLAMA_NUM_PARALLEL=${OLLAMA_PARALLEL}"
Environment="OLLAMA_MAX_LOADED_MODELS=2"
Environment="OLLAMA_KEEP_ALIVE=24h"
EOF
systemctl daemon-reload
systemctl enable --now ollama >/dev/null 2>&1
systemctl restart ollama
for i in {1..30}; do curl -fs http://127.0.0.1:11434/api/tags >/dev/null && break; sleep 1; done
ollama pull "$LLM_MODEL"
ollama pull "$EMBED_MODEL"
ok "Ollama ($OLLAMA_PARALLEL réponses en parallèle), modèles $LLM_MODEL et $EMBED_MODEL"

# ------------------------------------------------------------------------------- voix
say "Voix (Kokoro-FastAPI, conteneur Docker)"
if ! command -v docker >/dev/null; then
  apt-get install -y -qq docker.io >/dev/null
  systemctl enable --now docker >/dev/null 2>&1
fi
KOKORO_IMAGE=ghcr.io/remsky/kokoro-fastapi-cpu:latest
GPU_FLAG=()
if [[ $GPU == 1 ]] && docker info 2>/dev/null | grep -qi 'runtimes.*nvidia'; then
  KOKORO_IMAGE=ghcr.io/remsky/kokoro-fastapi-gpu:latest
  GPU_FLAG=(--gpus all)
elif [[ $GPU == 1 ]]; then
  warn "NVIDIA Container Toolkit absent : la voix tournera sur le processeur (voir la documentation)"
fi
docker pull -q "$KOKORO_IMAGE" >/dev/null
docker rm -f kokoro >/dev/null 2>&1 || true
docker run -d --name kokoro --restart unless-stopped "${GPU_FLAG[@]}" -p 127.0.0.1:8880:8880 "$KOKORO_IMAGE" >/dev/null
ok "Kokoro ($KOKORO_IMAGE) sur 127.0.0.1:8880"

# ------------------------------------------------------------------------------ écoute
if [[ $WITH_WHISPER == 1 ]]; then
  say "Écoute (whisper.cpp, modèle $WHISPER_MODEL)"
  W=/opt/whisper.cpp
  [[ -d $W ]] || git clone -q --depth 1 https://github.com/ggml-org/whisper.cpp "$W"
  if [[ ! -x $W/build/bin/whisper-server ]]; then
    CUDA_FLAG=()
    [[ $GPU == 1 ]] && command -v nvcc >/dev/null && CUDA_FLAG=(-DGGML_CUDA=1)
    cmake -S "$W" -B "$W/build" -DCMAKE_BUILD_TYPE=Release "${CUDA_FLAG[@]}" >/dev/null
    cmake --build "$W/build" -j "$(nproc)" --target whisper-server >/dev/null
  fi
  [[ -f $W/models/ggml-$WHISPER_MODEL.bin ]] || bash "$W/models/download-ggml-model.sh" "$WHISPER_MODEL" >/dev/null
  cat >/etc/systemd/system/claire-whisper.service <<EOF
[Unit]
Description=Claire - écoute (whisper.cpp)
After=network.target

[Service]
ExecStart=$W/build/bin/whisper-server -m $W/models/ggml-$WHISPER_MODEL.bin --host 127.0.0.1 --port 8178 -l fr
Restart=always
DynamicUser=yes

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now claire-whisper >/dev/null 2>&1
  systemctl restart claire-whisper
  ok "whisper-server sur 127.0.0.1:8178"
fi

# ------------------------------------------------------------------------- application
say "Application et serveur de Claire"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir "/var/lib/$APP_USER" --shell /usr/sbin/nologin "$APP_USER"
if [[ ! -d $APP_DIR/.git ]]; then
  git clone -q "$REPO" "$APP_DIR"
fi
chown -R "$APP_USER": "$APP_DIR"
runuser -u "$APP_USER" -- bash -c "cd '$APP_DIR' && npm ci --no-audit --no-fund --loglevel=error >/dev/null && npm run build --silent >/dev/null"
if [[ ! -f $APP_DIR/server/.env ]]; then
  runuser -u "$APP_USER" -- cp "$APP_DIR/server/.env.example" "$APP_DIR/server/.env"
  sed -i "s/^LLM_MODEL=.*/LLM_MODEL=${LLM_MODEL}/; s/^EMBED_MODEL=.*/EMBED_MODEL=${EMBED_MODEL}/; s/^MAX_CONCURRENT=.*/MAX_CONCURRENT=${OLLAMA_PARALLEL}/" "$APP_DIR/server/.env"
  ok "réglages créés : $APP_DIR/server/.env"
fi
cat >/etc/systemd/system/claire.service <<EOF
[Unit]
Description=Claire - assistante du Hackathon 2026
After=network.target ollama.service docker.service

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) server/index.mjs
Restart=always
RestartSec=5
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now claire >/dev/null 2>&1
systemctl restart claire
for i in {1..20}; do curl -fs -m 2 -o /dev/null http://127.0.0.1:8090/api/health && break; sleep 1; done
curl -fs -m 2 -o /dev/null http://127.0.0.1:8090/api/health && ok "serveur de Claire sur 127.0.0.1:8090" || warn "le serveur ne répond pas encore : journalctl -u claire -n 50"

say "Terminé"
echo "  • Documents de l'événement : $APP_DIR/server/documents (propriétaire : $APP_USER)"
echo "  • Réglages :                 $APP_DIR/server/.env, puis : sudo systemctl restart claire"
echo "  • État :                     sudo bash $APP_DIR/linux/etat.sh"
echo "  • Accès HTTPS :              proxy inverse vers 127.0.0.1:8090 (linux/nginx-claire.conf ou linux/Caddyfile)"

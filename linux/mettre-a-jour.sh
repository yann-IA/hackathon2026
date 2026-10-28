#!/bin/bash
# Met Claire à jour sur le serveur Linux (dernière version du dépôt) et relance le service.
# Les documents, les réglages (server/.env), l'index et Questions.csv ne sont pas touchés.
# Usage : sudo bash /opt/hackathon2026/linux/mettre-a-jour.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_USER="$(stat -c %U "$ROOT")"
runuser -u "$APP_USER" -- bash -c "cd '$ROOT' && git pull --ff-only && npm ci --no-audit --no-fund --loglevel=error >/dev/null && npm run build --silent >/dev/null"
systemctl restart claire
echo "Claire est à jour et relancée."

#!/bin/bash
# Met Claire à jour (dernière version du dépôt), reconstruit l'application et relance le serveur.
# Les documents, les réglages (server/.env) et l'index ne sont pas touchés.
# Usage : bash mac/mettre-a-jour.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
git pull --ff-only
npm ci --no-audit --no-fund --loglevel=error >/dev/null
npm run build --silent >/dev/null 2>&1 || npm run build
launchctl kickstart -k "gui/$(id -u)/fr.hackathon2026.serveur"
echo "Claire est à jour et relancée."

#!/bin/bash
# Met Claire à jour (dernière version du dépôt), reconstruit l'application et relance le serveur.
# Les documents, les réglages (server/.env) et l'index ne sont pas touchés.
# Usage : bash mac/mettre-a-jour.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
git pull --ff-only
# (Ce qui précède « git pull » ne doit pas changer : le script se met à jour pendant qu'il tourne.)
# Réglages : complète server/.env pour les nouveautés (les choix déjà faits sont gardés).
# Résumé par e-mail à 8 h, 12 h et 17 h : remplace l'ancien envoi hebdomadaire.
if [[ -f server/.env ]] && ! grep -q '^REPORT_HOURS=' server/.env; then
  awk '!/^REPORT_(HOUR|DAY|SCHEDULE)=/' server/.env >server/.env.nouveau
  [[ -z "$(tail -c1 server/.env.nouveau)" ]] || echo >>server/.env.nouveau
  printf 'REPORT_SCHEDULE=quotidien\nREPORT_HOURS=8,12,17\n' >>server/.env.nouveau
  mv server/.env.nouveau server/.env
  echo "Réglages mis à jour : résumé par e-mail à 8 h, 12 h et 17 h (server/.env)."
fi
npm ci --no-audit --no-fund --loglevel=error >/dev/null
npm run build --silent >/dev/null 2>&1 || npm run build
launchctl kickstart -k "gui/$(id -u)/fr.hackathon2026.serveur"
echo "Claire est à jour et relancée."
[[ -d "$HOME/.hackathon2026-tailscale" ]] || echo "Pour l'adresse https://hackathon.….ts.net, lance maintenant : bash mac/acces-public.sh"

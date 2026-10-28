#!/bin/bash
# Vérifie que tous les services de Claire répondent, et affiche l'adresse publique.
# Usage : bash mac/etat.sh
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
check() { # nom, url
  if curl -fs -m 5 -o /dev/null "$2"; then printf '  \033[32m✓\033[0m %s\n' "$1"; else printf '  \033[31m✗\033[0m %s (%s)\n' "$1" "$2"; fi
}
echo "Services :"
check "Ollama (modèle de langue)" http://127.0.0.1:11434/api/tags
check "Kokoro (voix)" http://127.0.0.1:8880/v1/audio/voices
check "Whisper (écoute)" http://127.0.0.1:8178/
check "Serveur de Claire" http://127.0.0.1:8090/api/health
echo
echo "Claire :"
curl -fs -m 5 http://127.0.0.1:8090/api/health | sed 's/,/\n/g; s/[{}"]//g; s/^/  /' || echo "  (serveur injoignable)"
echo
echo "Modèles chargés :"
curl -fs -m 5 http://127.0.0.1:11434/api/ps | grep -o '"name":"[^"]*"' | sed 's/"name":"/  /; s/"$//' || true
echo
TS="$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)"
if [[ -x "$TS" ]]; then echo "Accès public :"; "$TS" funnel status 2>/dev/null | sed 's/^/  /'; fi
echo
echo "Journaux : $HOME/Library/Logs/Hackathon2026   (documents : $ROOT/server/documents)"

#!/bin/bash
# Vérifie que tous les services de Claire répondent (serveur Linux).
# Usage : sudo bash linux/etat.sh
check() { # nom, url
  if curl -fs -m 5 -o /dev/null "$2"; then printf '  \033[32m✓\033[0m %s\n' "$1"; else printf '  \033[31m✗\033[0m %s (%s)\n' "$1" "$2"; fi
}
echo "Services :"
check "Ollama (modèle de langue)" http://127.0.0.1:11434/api/tags
check "Kokoro (voix)" http://127.0.0.1:8880/v1/audio/voices
check "Whisper (écoute, facultatif)" http://127.0.0.1:8178/
check "Serveur de Claire" http://127.0.0.1:8090/api/health
echo
echo "Claire :"
curl -fs -m 5 http://127.0.0.1:8090/api/health | sed 's/,/\n/g; s/[{}"]//g; s/^/  /' || echo "  (serveur injoignable)"
echo
echo "Modèles chargés (et mémoire de la carte graphique) :"
curl -fs -m 5 http://127.0.0.1:11434/api/ps | grep -o '"name":"[^"]*"' | sed 's/"name":"/  /; s/"$//' || true
command -v nvidia-smi >/dev/null && nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu --format=csv,noheader | sed 's/^/  /'
echo
echo "Journaux : journalctl -u claire -f   (aussi : -u ollama, -u claire-whisper ; voix : docker logs kokoro)"

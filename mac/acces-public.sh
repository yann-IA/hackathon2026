#!/bin/bash
# Accès public de Claire à sa propre adresse : https://hackathon.<votre-réseau>.ts.net
#
# Une adresse Tailscale correspond à une machine. Pour que Claire ait une adresse à son nom, même
# sur le Mac de Camille (adresse « cgt… »), on fait tourner une seconde connexion Tailscale, réservée
# à Claire et nommée « hackathon » : elle apparaît comme une machine de plus dans votre compte
# Tailscale. L'application Tailscale et l'adresse de Camille ne changent pas.
#
# Usage : bash mac/acces-public.sh            (nom par défaut : hackathon)
#         TS_NAME=autre-nom bash mac/acces-public.sh
# La première fois, un lien de connexion à Tailscale s'affiche : ouvre-le et valide.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAME="${TS_NAME:-hackathon}"
PORT="${PORT:-8090}"
LABEL="fr.hackathon2026.tailscale"
STATE="$HOME/.hackathon2026-tailscale"   # état de la connexion (chemin court : limite des sockets macOS)
SOCK="$STATE/tailscaled.sock"
LOGS="$HOME/Library/Logs/Hackathon2026"
AGENTS="$HOME/Library/LaunchAgents"

say() { printf '\n\033[1;31m▶ %s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }

say "Connexion Tailscale réservée à Claire (« $NAME »)"
# Tailscale en ligne de commande, sans le mettre dans le PATH : la commande « tailscale » reste celle
# de l'application (utilisée par Camille).
brew list tailscale >/dev/null 2>&1 || brew install tailscale >/dev/null
brew unlink tailscale >/dev/null 2>&1 || true
BIN="$(brew --prefix tailscale)/bin"
[[ -x "$BIN/tailscaled" ]] || { warn "tailscaled introuvable dans $BIN"; exit 1; }
TS=("$BIN/tailscale" --socket="$SOCK")
mkdir -p "$STATE" "$LOGS" "$AGENTS"

# service qui démarre à l'ouverture de session (mode « userspace » : ni réseau virtuel, ni mot de passe)
plist="$AGENTS/$LABEL.plist"
cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${BIN}/tailscaled</string>
    <string>--tun=userspace-networking</string>
    <string>--statedir=${STATE}</string>
    <string>--socket=${SOCK}</string>
    <string>--port=0</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${LOGS}/tailscale.log</string>
  <key>StandardErrorPath</key><string>${LOGS}/tailscale.log</string>
</dict>
</plist>
EOF
plutil -lint -s "$plist"
if ! launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  for i in {1..5}; do launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null && break; sleep 2; done
fi
for i in {1..30}; do [[ -S "$SOCK" ]] && "${TS[@]}" version >/dev/null 2>&1 && break; sleep 1; done
ok "service $LABEL"

# connexion au compte Tailscale (lien à ouvrir la première fois), sous le nom choisi
if ! "${TS[@]}" status >/dev/null 2>&1; then
  echo "  Si un lien s'affiche ci-dessous, ouvre-le (Cmd + clic) et valide la connexion :"
fi
"${TS[@]}" up --hostname="$NAME" --accept-dns=false
ok "connectée"

# plus d'accès à Claire par l'adresse de Camille (ancienne installation : « …:8443 »)
APP="$(command -v tailscale || true)"
[[ -z "$APP" && -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]] && APP=/Applications/Tailscale.app/Contents/MacOS/Tailscale
if [[ -n "$APP" ]] && "$APP" funnel status 2>/dev/null | grep -q "127.0.0.1:$PORT"; then
  "$APP" funnel --https=8443 off >/dev/null 2>&1 && ok "ancienne adresse « …:8443 » fermée" || true
fi

if "${TS[@]}" funnel --bg "$PORT"; then
  URL="$("${TS[@]}" funnel status 2>/dev/null | grep -o 'https://[^ ]*' | head -1)"
  ok "Claire est accessible depuis Internet : ${URL:-https://$NAME.….ts.net}"
  echo "  (la première visite peut prendre une minute, le temps de créer le certificat)"
else
  warn "Funnel n'a pas pu démarrer : autorise-le pour cette machine dans la console Tailscale"
  warn "(lien affiché ci-dessus), puis relance : bash mac/acces-public.sh"
fi

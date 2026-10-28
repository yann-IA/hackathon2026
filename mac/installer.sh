#!/bin/bash
# Installe Claire (édition Hackathon 2026) sur un Mac Apple Silicon et la fait tourner 24 h/24 :
#   - Ollama : modèle de langue + empreintes de sens pour la recherche dans les documents ;
#   - Kokoro-FastAPI : voix française ;
#   - whisper.cpp : écoute (pour les téléphones dont le navigateur ne reconnaît pas la voix) ;
#   - le serveur de Claire (port 8090), qui sert l'application et répond aux questions.
# Chaque service démarre à l'ouverture de session et redémarre tout seul s'il s'arrête.
# Sur un Mac où Camille (édition CGT) est déjà installée, Ollama, la voix et l'écoute sont partagés :
# seul le serveur de Claire est ajouté. Claire a sa propre adresse publique, https://hackathon.….ts.net
# (voir mac/acces-public.sh).
#
# Usage (depuis le dossier du projet) :  bash mac/installer.sh
# On peut le relancer sans risque : ce qui est déjà installé est conservé.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LLM_MODEL="${LLM_MODEL:-mistral-nemo}"
EMBED_MODEL="${EMBED_MODEL:-bge-m3}"
WHISPER_MODEL="${WHISPER_MODEL:-small}"   # small (rapide) ou medium (plus précis, plus lent)
AGENTS="$HOME/Library/LaunchAgents"
LOGS="$HOME/Library/Logs/Hackathon2026"
PREFIX="fr.hackathon2026"   # noms des services (launchd)
PORT="${PORT:-8090}"

say() { printf '\n\033[1;31m▶ %s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }

[[ "$(uname -s)" == "Darwin" ]] || { echo "Ce script est prévu pour macOS."; exit 1; }
[[ "$(uname -m)" == "arm64" ]] || warn "Mac Intel détecté : tout fonctionnera, mais plus lentement."

# ---------------------------------------------------------------- Homebrew et outils
say "Outils (Homebrew)"
if ! command -v brew >/dev/null 2>&1; then
  echo "  Homebrew va être installé (le mot de passe du Mac sera demandé)."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  eval "$(/opt/homebrew/bin/brew shellenv)"
fi
BREW_PREFIX="$(brew --prefix)"
brew install node ollama whisper-cpp uv espeak-ng tesseract tesseract-lang poppler git >/dev/null
ok "node, ollama, whisper-cpp, uv, espeak-ng, tesseract (lecture des PDF scannés), poppler"

# services déjà fournis sur ce Mac par une autre installation (Camille) : partagés, pas dupliqués
mine() { launchctl print "gui/$(id -u)/$PREFIX.$1" >/dev/null 2>&1; }
share() { curl -fs -m 3 -o /dev/null "$2" && ! mine "$1"; }
SHARE_OLLAMA=0; share ollama http://127.0.0.1:11434/api/tags && SHARE_OLLAMA=1
SHARE_KOKORO=0; share kokoro http://127.0.0.1:8880/v1/audio/voices && SHARE_KOKORO=1
SHARE_WHISPER=0; share whisper http://127.0.0.1:8178/ && SHARE_WHISPER=1
# Ollama sera lancé par notre propre service (avec les bons réglages), pas par « brew services »
[[ $SHARE_OLLAMA == 1 ]] || brew services stop ollama >/dev/null 2>&1 || true

# ------------------------------------------------------------------- application
say "Application"
cd "$ROOT"
npm ci --no-audit --no-fund --loglevel=error >/dev/null
npm run build --silent >/dev/null 2>&1 || npm run build
ok "application construite (dossier dist)"
[[ -f server/.env ]] || { cp server/.env.example server/.env; ok "réglages créés : server/.env"; }
sed -i '' "s/^LLM_MODEL=.*/LLM_MODEL=${LLM_MODEL}/; s/^EMBED_MODEL=.*/EMBED_MODEL=${EMBED_MODEL}/" server/.env
mkdir -p server/documents server/models "$LOGS" "$AGENTS"

# ----------------------------------------------------------------- voix : Kokoro
say "Voix (Kokoro-FastAPI)"
if [[ $SHARE_KOKORO == 1 ]]; then
  ok "déjà en service sur ce Mac : partagée"
else
  if [[ ! -d server/kokoro ]]; then
    git clone --depth 1 https://github.com/remsky/Kokoro-FastAPI.git server/kokoro >/dev/null 2>&1
  fi
  echo "  Préparation de la voix (dépendances et modèle : plusieurs minutes la première fois)…"
  bash mac/kokoro.sh --installer >"$LOGS/kokoro-installation.log" 2>&1 \
    || { warn "échec de la préparation de la voix, voir $LOGS/kokoro-installation.log"; tail -n 15 "$LOGS/kokoro-installation.log"; exit 1; }
  ok "Kokoro-FastAPI prêt (voix ff_siwis)"
fi

# --------------------------------------------------------------- écoute : Whisper
say "Écoute (whisper.cpp, modèle $WHISPER_MODEL)"
WHISPER_FILE="server/models/ggml-${WHISPER_MODEL}.bin"
if [[ $SHARE_WHISPER == 1 ]]; then
  ok "déjà en service sur ce Mac : partagée"
elif [[ ! -f "$WHISPER_FILE" ]]; then
  curl -fL --progress-bar -o "$WHISPER_FILE" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${WHISPER_MODEL}.bin"
fi
WHISPER_BIN="$(command -v whisper-server || command -v whisper-cpp-server || true)"
[[ -n "$WHISPER_BIN" ]] || { warn "whisper-server introuvable (brew reinstall whisper-cpp)"; WHISPER_BIN="$BREW_PREFIX/bin/whisper-server"; }
[[ $SHARE_WHISPER == 1 ]] || ok "modèle $WHISPER_FILE"

# ------------------------------------------------------------------ services
say "Services (démarrage automatique)"
agent() { # nom, dossier, commande…
  local name="$1" dir="$2"; shift 2
  local label="$PREFIX.$name" plist="$AGENTS/$PREFIX.$name.plist" args=""
  for a in "$@"; do args+="    <string>${a}</string>"$'\n'; done
  cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${args}  </array>
  <key>WorkingDirectory</key><string>${dir}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${BREW_PREFIX}/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>OLLAMA_HOST</key><string>127.0.0.1:11434</string>
    <key>OLLAMA_NUM_PARALLEL</key><string>2</string>
    <key>OLLAMA_MAX_LOADED_MODELS</key><string>2</string>
    <key>OLLAMA_KEEP_ALIVE</key><string>24h</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${LOGS}/${name}.log</string>
  <key>StandardErrorPath</key><string>${LOGS}/${name}.log</string>
</dict>
</plist>
EOF
  plutil -lint -s "$plist"
  # « bootout » rend la main avant que l'ancien service soit arrêté : relancer trop tôt donne
  # « Bootstrap failed: 5: Input/output error ». On attend qu'il ait disparu, et on réessaie.
  launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
  for i in {1..30}; do launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1 || break; sleep 0.5; done
  for i in {1..5}; do launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null && break; sleep 2; done
  launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1 || launchctl bootstrap "gui/$(id -u)" "$plist"
  ok "$name"
}
[[ $SHARE_OLLAMA == 1 ]] && ok "ollama (partagé)" || agent ollama "$ROOT" "$BREW_PREFIX/bin/ollama" serve
[[ $SHARE_KOKORO == 1 ]] && ok "kokoro (partagé)" || agent kokoro "$ROOT" /bin/bash "$ROOT/mac/kokoro.sh"
[[ $SHARE_WHISPER == 1 ]] && ok "whisper (partagé)" || agent whisper "$ROOT" "$WHISPER_BIN" -m "$ROOT/$WHISPER_FILE" --host 127.0.0.1 --port 8178 -l fr
agent serveur "$ROOT" "$(command -v node)" server/index.mjs

# ------------------------------------------------------------------ modèles
say "Modèles d'IA (téléchargement, plusieurs Go la première fois)"
for i in {1..30}; do curl -fs http://127.0.0.1:11434/api/tags >/dev/null && break; sleep 2; done
ollama pull "$LLM_MODEL"
ollama pull "$EMBED_MODEL"
ok "$LLM_MODEL et $EMBED_MODEL"
launchctl kickstart -k "gui/$(id -u)/$PREFIX.serveur" >/dev/null 2>&1 || true
printf '  Démarrage de la voix'
for i in {1..60}; do curl -fs -m 2 http://127.0.0.1:8880/v1/audio/voices >/dev/null && break; printf '.'; sleep 3; done
echo
for i in {1..15}; do curl -fs -m 2 -o /dev/null "http://127.0.0.1:$PORT/api/health" && break; sleep 2; done
if curl -fs -m 60 -o /dev/null "http://127.0.0.1:$PORT/api/audio/speech" -H 'Content-Type: application/json' -d '{"input":"Bonjour, je suis Claire."}'; then
  ok "la voix de Claire répond"
else
  warn "la voix ne répond pas encore : relance « bash mac/etat.sh » dans quelques minutes (journal : $LOGS/kokoro.log)"
fi

# --------------------------------------------------------- Mac toujours allumé
say "Mac toujours disponible (mot de passe du Mac demandé)"
# jamais de veille, redémarrage automatique après une coupure de courant
sudo pmset -a sleep 0 disksleep 0 displaysleep 10 autorestart 1 womp 1 && ok "veille désactivée, redémarrage après coupure activé"
warn "Pour que tout reparte après un redémarrage, active l'ouverture de session automatique :"
warn "Réglages Système > Utilisateurs et groupes > « Se connecter automatiquement en tant que… »"

# ---------------------------------------------------------- accès depuis l'extérieur
# Claire a sa propre adresse (https://hackathon.….ts.net), distincte de celle de Camille
bash "$ROOT/mac/acces-public.sh" || warn "accès public à terminer : bash mac/acces-public.sh"

say "Terminé"
echo "  • Sur ce Mac :          http://127.0.0.1:$PORT"
echo "  • État des services :   bash mac/etat.sh"
echo "  • Documents (PDF) :     dépose-les dans $ROOT/server/documents (pris en compte en quelques secondes)"
echo "  • Journaux :            $LOGS"

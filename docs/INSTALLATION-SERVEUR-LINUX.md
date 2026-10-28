# Installer Claire sur un serveur Linux

*Document destiné à l'administrateur du serveur.*

Claire est l'assistante virtuelle (avatar 3D) du Hackathon 2026. Les participants l'ouvrent dans le
navigateur de leur téléphone, via un QR code, et lui posent des questions à la voix ou par écrit sur
l'événement. Elle répond uniquement à partir des documents de l'événement. Aujourd'hui, tout tourne sur
un Mac M1 et les réponses sont lentes. L'objectif est de la faire tourner sur un serveur Linux plus
puissant, idéalement équipé d'une carte graphique NVIDIA.

Tout fonctionne **en local sur le serveur** : aucune API externe, aucun service payant. Une fois
installée, l'application n'a plus besoin d'Internet en sortie, sauf pour envoyer les résumés par
e-mail.

---

## 1. Ce qui tourne sur le serveur

| Composant | Rôle | Écoute sur | Installé comme |
|---|---|---|---|
| **Serveur de Claire** (Node.js 22, ce dépôt) | Sert l'application web (fichiers statiques) et l'API : questions, recherche dans les documents, journal des questions, résumés par e-mail | `127.0.0.1:8090` | service systemd `claire` |
| **Ollama** | Modèle de langue (`mistral-nemo`, 12 milliards de paramètres) et calcul des empreintes pour la recherche dans les documents (`bge-m3`) | `127.0.0.1:11434` | service systemd `ollama` |
| **Kokoro-FastAPI** | Synthèse vocale (voix française `ff_siwis`) | `127.0.0.1:8880` | conteneur Docker `kokoro` |
| **whisper.cpp** (facultatif) | Reconnaissance vocale, uniquement pour les navigateurs qui ne la font pas eux-mêmes (Firefox…) | `127.0.0.1:8178` | service systemd `claire-whisper` |
| **Proxy inverse HTTPS** (nginx, Caddy… : déjà en place chez vous ou à installer) | Seul point d'entrée depuis l'extérieur | `443` | à votre convenance |

Tous les composants n'écoutent que sur `127.0.0.1`. **Seul le proxy inverse est exposé.** Le serveur
de Claire ne parle qu'aux trois autres composants, sur la machine elle-même.

```
téléphone ──HTTPS──▶ proxy inverse ──▶ Claire :8090 ──▶ Ollama :11434
                                                     ├─▶ Kokoro :8880
                                                     └─▶ whisper :8178
```

## 2. Points à valider avant l'installation

- **Confidentialité.** Les documents de l'événement sont marqués « Orange Restricted » : livret du
  participant (avec des numéros de téléphone), guide complet, fiches des sujets. Les héberger sur un
  serveur de l'entreprise est préférable au Mac personnel actuel. Claire peut répéter leur contenu à
  quiconque accède à l'application ; le téléchargement des fichiers eux-mêmes est désactivé par défaut
  (`DOCS_DOWNLOAD`).
- **Exposition.** Les participants utilisent leur téléphone, en 4G/5G ou sur le Wi-Fi de l'hôtel.
  L'application doit donc être joignable depuis Internet en **HTTPS** (le micro du navigateur exige
  HTTPS), sous un nom du type `hackathon.<domaine>`. Il faut pour cela une publication en DMZ ou par
  un proxy inverse d'entreprise. Si ce n'est pas possible, la variante du §11 garde l'accès public
  actuel.
- **Politique technique.** Les composants sont open source : Ollama (MIT), Kokoro-FastAPI (Apache 2.0),
  whisper.cpp (MIT), modèles `mistral-nemo` (Apache 2.0), `bge-m3` (MIT) et Kokoro-82M (Apache 2.0).
  Vérifiez qu'ils sont admis par la politique technique interne.
- **Accès sortants pendant l'installation** : `deb.nodesource.com`, `ollama.com` et
  `registry.ollama.ai`, `ghcr.io`, `github.com`, `huggingface.co`, `registry.npmjs.org`. Si un proxy
  est nécessaire, exportez `http_proxy`/`https_proxy` avant de lancer le script, et configurez-le aussi
  pour Docker et pour Ollama (variable `HTTPS_PROXY` dans le service).
- **Données personnelles.** Les questions sont enregistrées dans `Questions.csv` sans adresse IP ni
  identifiant (date, question, réponse). L'accueil de l'application en informe les participants.

## 3. Prérequis

| | Recommandé | Minimum |
|---|---|---|
| Système | Ubuntu 24.04 ou 22.04 LTS, Debian 12 | toute distribution Linux 64 bits (installation manuelle, §5) |
| Carte graphique | NVIDIA ≥ 16 Go (L4, A10, A100, RTX 4090…), pilote NVIDIA installé (`nvidia-smi` fonctionne) | aucune : tout tourne sur le processeur, nettement plus lentement |
| Pour la voix sur la carte graphique | [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) | sinon, la voix tourne sur le processeur, ce qui est suffisant |
| Processeur et mémoire | 8 cœurs, 32 Go | 4 cœurs, 16 Go |
| Disque | 40 Go libres | 25 Go |
| Accès | `sudo` | |

**Ordre de grandeur** (indicatif) : sur le Mac M1, le modèle produit 10 à 15 mots-jetons par seconde
et il faut 3 à 8 secondes avant le début de la réponse. Sur une carte de type L4 ou A10, c'est
plutôt 50 à 100 mots-jetons par seconde, et moins d'une seconde avant la réponse. Claire commence
à parler dès la première phrase écrite.

## 4. Installation automatique

```bash
git clone https://github.com/yann-IA/hackathon2026.git /tmp/hackathon2026
sudo bash /tmp/hackathon2026/linux/installer.sh
```

Le script dure de 10 à 30 minutes, surtout pour télécharger les modèles (environ 10 Go). On peut le
relancer sans risque. Il :

1. installe les paquets (Node.js 22, tesseract, poppler pour la lecture des PDF scannés, outils de
   compilation) ;
2. installe Ollama et le règle (écoute locale, 4 réponses en parallèle, modèles gardés en mémoire),
   puis télécharge `mistral-nemo` et `bge-m3` ;
3. installe Docker s'il manque et lance le conteneur Kokoro. Il prend l'image GPU si la carte
   graphique et le NVIDIA Container Toolkit sont présents, l'image CPU sinon ;
4. compile `whisper-server` (avec CUDA si `nvcc` est présent) et télécharge le modèle `small` ;
5. crée l'utilisateur système `claire`, installe l'application dans `/opt/hackathon2026`, la
   construit, crée `server/.env` et le service systemd `claire`.

Variables facultatives, à placer avant `bash` :

| Variable | Défaut | Rôle |
|---|---|---|
| `APP_DIR` | `/opt/hackathon2026` | dossier de l'application |
| `APP_USER` | `claire` | utilisateur système du service |
| `LLM_MODEL` | `mistral-nemo` | modèle de langue (voir §10) |
| `OLLAMA_PARALLEL` | `4` | réponses générées en même temps (Ollama et `MAX_CONCURRENT`) |
| `WITH_WHISPER` | `1` | `0` pour ne pas installer la reconnaissance vocale côté serveur |
| `WHISPER_MODEL` | `small` | `medium` : plus précis, plus lent |

Exemple : `sudo LLM_MODEL=mistral-small3.2 OLLAMA_PARALLEL=8 bash /tmp/hackathon2026/linux/installer.sh`

Vérification : `sudo bash /opt/hackathon2026/linux/etat.sh` doit afficher quatre coches vertes (trois
si `WITH_WHISPER=0`).

## 5. Installation manuelle (autres distributions)

Si le script ne convient pas, voici les mêmes étapes à la main :

1. **Node.js ≥ 20**, **git**, **tesseract** avec le français, **poppler-utils** (`pdftoppm`).
2. **Ollama** : <https://ollama.com/download/linux>. Dans le service, définir `OLLAMA_HOST=127.0.0.1:11434`,
   `OLLAMA_NUM_PARALLEL=4`, `OLLAMA_KEEP_ALIVE=24h` et `OLLAMA_MAX_LOADED_MODELS=2`, puis lancer
   `ollama pull mistral-nemo` et `ollama pull bge-m3`.
3. **Kokoro** :
   `docker run -d --name kokoro --restart unless-stopped --gpus all -p 127.0.0.1:8880:8880 ghcr.io/remsky/kokoro-fastapi-gpu:latest`
   (sans carte graphique : image `ghcr.io/remsky/kokoro-fastapi-cpu:latest`, sans `--gpus all`).
4. **whisper.cpp** (facultatif) : compiler la cible `whisper-server`, puis la lancer avec
   `-m models/ggml-small.bin --host 127.0.0.1 --port 8178 -l fr`.
5. **Application** :
   ```bash
   git clone https://github.com/yann-IA/hackathon2026.git /opt/hackathon2026
   cd /opt/hackathon2026 && npm ci && npm run build
   cp server/.env.example server/.env
   node server/index.mjs        # à transformer en service (voir linux/installer.sh, unité « claire »)
   ```

## 6. Publication en HTTPS (proxy inverse)

Faites pointer le nom choisi vers le serveur (ou vers votre proxy d'entreprise), puis relayez tout vers
`http://127.0.0.1:8090`. Des exemples sont fournis : `linux/nginx-claire.conf` et `linux/Caddyfile`.
Réglages **indispensables** :

- **pas de mise en tampon** des réponses (`proxy_buffering off` pour nginx, `flush_interval -1` pour
  Caddy) : elles arrivent en flux (Server-Sent Events), et Claire commence à parler avant d'avoir fini
  d'écrire ;
- un **délai de lecture** d'au moins 120 s (`proxy_read_timeout`) ;
- l'en-tête **`X-Forwarded-For`** : le serveur l'utilise pour limiter le nombre de questions par
  appareil (10 par minute par défaut) ;
- une taille de requête d'au moins 10 Mo (`client_max_body_size`), pour les messages vocaux.

Le certificat doit être reconnu par les téléphones : public, ou celui de l'entreprise s'il est
installé sur les appareils.

## 7. Réglages (`/opt/hackathon2026/server/.env`)

Après une modification : `sudo systemctl restart claire`.

| Réglage | Défaut | Rôle |
|---|---|---|
| `ASSISTANT_NAME`, `EVENT_NAME`, `EVENT_CONTACT` | Claire, Hackathon 2026, l'équipe d'organisation | repris dans les consignes, les messages et les résumés |
| `PORT`, `HOST` | `8090`, `127.0.0.1` | écoute du serveur (derrière le proxy) |
| `LLM_API`, `LLM_URL`, `LLM_MODEL` | `ollama`, `http://127.0.0.1:11434`, `mistral-nemo` | modèle de langue (`LLM_API=openai` pour vLLM, voir §10) |
| `LLM_API_KEY` | vide | clé d'un serveur compatible OpenAI protégé |
| `LLM_CONTEXT`, `LLM_MAX_TOKENS`, `LLM_TEMPERATURE` | `6144`, `450`, `0.2` | taille du contexte, longueur maximale d'une réponse, créativité |
| `EMBED_URL`, `EMBED_MODEL` | comme `LLM_URL`, `bge-m3` | empreintes pour la recherche dans les documents |
| `TTS_URL`, `TTS_VOICE`, `TTS_SPEED` | `http://127.0.0.1:8880/v1`, `ff_siwis`, `1.05` | voix |
| `STT_API`, `STT_URL` | `whispercpp`, `http://127.0.0.1:8178/inference` | reconnaissance vocale |
| `MAX_CONCURRENT`, `MAX_QUEUE`, `MAX_PER_MINUTE` | `2` (4 après le script), `30`, `10` | réponses en parallèle, file d'attente, questions par minute et par appareil |
| `RAG_TOP_K`, `RAG_CHUNK_CHARS` | `4`, `900` | nombre et taille des passages de documents fournis au modèle |
| `DOCS_DOWNLOAD` | désactivé | `true` : les documents cités sont téléchargeables depuis l'application |
| `LOG_QUESTIONS` | activé | `false` : ne plus enregistrer les questions |
| `REPORT_EMAIL`, `REPORT_SCHEDULE`, `REPORT_HOURS` | vide, `quotidien`, `8,12,17` | résumé des questions par e-mail |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | `smtp.gmail.com`, `465`, selon le port | serveur d'envoi ; un relais interne sans identification convient (par exemple `SMTP_HOST=relais.interne`, `SMTP_PORT=25`, sans utilisateur) |

## 8. Les documents de l'événement

Ils se déposent dans `/opt/hackathon2026/server/documents` et doivent appartenir à l'utilisateur
`claire`. Formats lus : PDF (y compris scannés), texte, Markdown, HTML et images. Ils sont indexés
automatiquement quelques secondes après leur arrivée. Pour en retirer un, supprimez le fichier. Les
10 sujets du hackathon sont déjà fournis avec le dépôt.

Pour reprendre les documents déposés sur le Mac :

```bash
# depuis le Mac
scp ~/Hackathon2026/server/documents/* utilisateur@serveur:/tmp/docs/
# sur le serveur
sudo install -o claire -g claire -m 640 /tmp/docs/* /opt/hackathon2026/server/documents/ && rm -r /tmp/docs
```

## 9. Exploitation

| Pour… | Commande |
|---|---|
| État des services | `sudo bash /opt/hackathon2026/linux/etat.sh` |
| Journaux | `journalctl -u claire -f` (et `-u ollama`, `-u claire-whisper`, `docker logs kokoro`) |
| Relancer | `sudo systemctl restart claire` |
| Mettre à jour l'application | `sudo bash /opt/hackathon2026/linux/mettre-a-jour.sh` |
| Tester l'envoi d'e-mail | `cd /opt/hackathon2026 && sudo -u claire npm run essai-mail` |
| Résumé des questions à la demande | `cd /opt/hackathon2026 && sudo -u claire npm run resume` |

À sauvegarder : `server/.env`, `server/documents/`, `Questions.csv` et `Résumés/`. Le reste se
reconstruit. Avant l'événement, supprimez `Questions.csv` pour repartir de zéro.

## 10. Aller plus vite, servir plus de monde

- **Réponses en parallèle** : augmentez ensemble `OLLAMA_NUM_PARALLEL` (service Ollama) et
  `MAX_CONCURRENT` (`server/.env`), selon la mémoire de la carte : chaque réponse en parallèle réserve
  son contexte.
- **Choix du modèle** : `mistral-nemo` (12 milliards de paramètres, environ 8 Go) est un bon compromis
  rapidité/qualité en français. `mistral-small3.2` (24 milliards, environ 16 Go) répond mieux mais
  environ deux fois plus lentement. Pour changer : `ollama pull <modèle>`, puis `LLM_MODEL=<modèle>`
  dans `server/.env`, puis relancer `claire`. Un modèle qui « réfléchit » avant de répondre
  (qwen3…) demande `LLM_THINK=false`.
- **Beaucoup d'utilisateurs simultanés** : [vLLM](https://docs.vllm.ai) sert le modèle plus efficacement
  qu'Ollama à forte charge. Lancez par exemple
  `vllm serve mistralai/Mistral-Nemo-Instruct-2407 --host 127.0.0.1 --port 8000 --max-model-len 8192`,
  puis réglez `LLM_API=openai`, `LLM_URL=http://127.0.0.1:8000`,
  `LLM_MODEL=mistralai/Mistral-Nemo-Instruct-2407` et, si besoin, `LLM_API_KEY`. Ollama reste utilisé
  pour la recherche dans les documents (`EMBED_URL`).
- **À éviter** : changer `LLM_CONTEXT` entre deux applications qui partagent le même modèle. Ollama
  recharge alors le modèle à chaque alternance.

## 11. Variante : le serveur ne fait que le calcul

Si l'application ne peut pas être publiée depuis le réseau de l'entreprise, le Mac peut rester le
point d'accès public (Tailscale), et le serveur ne fournir que le modèle de langue. Il faut alors un
accès réseau du Mac vers le serveur (VPN), puis un tunnel SSH lancé sur le Mac :

```bash
ssh -N -L 11435:127.0.0.1:11434 utilisateur@serveur
```

Ajoutez ensuite dans `server/.env` sur le Mac : `LLM_URL=http://127.0.0.1:11435` et
`EMBED_URL=http://127.0.0.1:11435`, puis relancez le serveur de Claire. Sur le serveur, seul Ollama est
nécessaire (§5, étape 2). Ollama ne doit jamais être exposé directement sur le réseau : il n'a pas
d'authentification.

## 12. Dépannage

| Symptôme | Piste |
|---|---|
| ✗ Ollama | `journalctl -u ollama -n 50` ; carte graphique non vue : `nvidia-smi`, pilote, puis `sudo systemctl restart ollama` |
| Réponses lentes malgré la carte graphique | `ollama ps` doit indiquer `100% GPU`. Sinon, le modèle ne tient pas en mémoire : prendre un modèle plus petit ou réduire `OLLAMA_NUM_PARALLEL` |
| ✗ Kokoro | `docker logs kokoro` ; le premier démarrage télécharge le modèle de voix (quelques minutes) |
| La voix est celle du téléphone | Kokoro injoignable (voir ci-dessus) : l'application bascule alors sur la voix du navigateur |
| Le texte de la réponse arrive d'un bloc, avec du retard | le proxy met en tampon (§6) |
| « Beaucoup de questions en peu de temps » pour tout le monde | `X-Forwarded-For` absent : tous les visiteurs semblent venir du proxy (§6) |
| Pas de micro sur le téléphone | la page n'est pas en HTTPS, ou le certificat n'est pas reconnu |
| Un document est ignoré | `journalctl -u claire | grep '!'` (format non lu, PDF protégé…) ; vérifier les droits de l'utilisateur `claire` |

## 13. Désinstallation

```bash
sudo systemctl disable --now claire claire-whisper
sudo rm /etc/systemd/system/claire.service /etc/systemd/system/claire-whisper.service
docker rm -f kokoro
sudo rm -r /opt/hackathon2026 /opt/whisper.cpp
# Ollama : sudo systemctl disable --now ollama, voir https://github.com/ollama/ollama/blob/main/docs/linux.md
```

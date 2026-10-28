# Claire — Hackathon 2026

Claire est une assistante en 3D qui accueille les participants et les visiteurs du Hackathon 2026. Elle
répond, à la voix ou par écrit, à leurs questions sur l'événement (programme, horaires, lieux,
règlement, équipes, jury et prix, infos pratiques) à partir des documents que vous déposez sur le Mac
(RAG). On y accède depuis son téléphone en scannant un QR code : rien à installer, aucun compte,
aucune clé.

Ce dépôt est une copie d'[Avatar-3D-XR](https://github.com/yann-IA/Avatar-3D-XR) dédiée à l'événement :
une seule avatar (Claire), pas de réglages pour les visiteurs, un accueil « kiosque » qui fait défiler
des questions suggérées, et un serveur (`server/`) qui fait tout le travail sur le Mac, sans API payante :

| Rôle | Logiciel gratuit |
|---|---|
| Modèle de langue | [Ollama](https://ollama.com) avec `mistral-nemo` |
| Recherche dans les documents | Ollama avec `bge-m3` |
| Voix | [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI), voix française `ff_siwis` |
| Écoute | [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (téléphones dont le navigateur ne reconnaît pas la voix) |
| Accès depuis Internet | [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) : adresse https fixe, sans ouvrir de port sur la box |

## Installation sur le Mac

Le Mac a besoin d'Homebrew, de `gh` (connecté à GitHub) et de Tailscale, comme pour Camille.

```bash
gh repo clone yann-IA/hackathon2026 ~/Hackathon2026
cd ~/Hackathon2026
bash mac/installer.sh
```

L'installation construit l'application, installe les services (qui démarrent tout seuls et redémarrent
s'ils s'arrêtent), télécharge les modèles et ouvre l'accès public. `bash mac/etat.sh` vérifie à tout
moment que tout fonctionne et rappelle l'adresse publique.

**Sur le Mac de Camille** : les deux éditions cohabitent. Ollama, la voix et l'écoute déjà installés
pour Camille sont partagés ; seul le serveur de Claire est ajouté (port 8090). L'adresse publique de
Claire est alors celle de Camille suivie de `:8443`, par exemple `https://cgt.tail1234.ts.net:8443`.
Pour une adresse distincte, renommez la machine dans la console Tailscale ou installez Claire sur un
autre Mac. Sur un Mac sans Camille, l'adresse est simplement `https://nom-du-mac.tail1234.ts.net`.

## Les documents de l'événement

Les **10 sujets du hackathon** sont déjà fournis (`server/documents/Sujets du Hackathon 2026.md`).
Ajoutez les autres documents dans **`server/documents`** (`open ~/Hackathon2026/server/documents`) :
programme, règlement, plan d'accès… Ils sont indexés automatiquement quelques secondes après leur arrivée ; pour en
retirer un, supprimez le fichier. Le nom du fichier sert de titre dans les sources affichées sous chaque
réponse. Formats lus : PDF (y compris scannés), texte, Markdown, HTML, images. Ces documents sont
publics (consultables depuis les sources).

Claire ne répond qu'à partir de ces documents : quand ils ne contiennent pas la réponse, elle le dit et
oriente vers l'équipe d'organisation, sans rien inventer.

## Questions des participants et résumé par e-mail

Toutes les questions sont notées, sans rien qui identifie la personne, dans **`Questions.csv`** (Numbers
ou Excel) : date, question, réponse trouvée ou non, sources, réponse de Claire. Chaque jour à **8 h,
12 h et 17 h**, un résumé est enregistré dans `Résumés/` et envoyé par e-mail : d'abord les **nouvelles
questions** depuis le résumé précédent (✓ réponse trouvée, ✗ sans réponse), puis le point depuis le
début (nombre de questions, thèmes et préoccupations principales, questions restées sans réponse,
questions les plus posées). Heures : `REPORT_HOURS=8,12,17` dans `server/.env`.

Envoi par e-mail, dans `server/.env` (Gmail : mot de passe d'application, voir
[myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) ; Orange :
`SMTP_HOST=smtp.orange.fr`) :

```
REPORT_EMAIL=votre.adresse@exemple.fr
SMTP_USER=adresse.qui.envoie@gmail.com
SMTP_PASS=abcd efgh ijkl mnop
```

```bash
npm run essai-mail                 # vérifie l'envoi
npm run resume                     # résumé tout de suite (ajouter -- --envoyer pour le recevoir)
```

## Personnaliser

- **Nom de l'assistante, de l'événement, contact** : `ASSISTANT_NAME`, `EVENT_NAME` et `EVENT_CONTACT`
  dans `server/.env` (consignes, messages, résumés), et les mêmes textes dans `src/edition.ts`
  (accueil, questions suggérées, bandeau en haut de l'écran), puis `bash mac/mettre-a-jour.sh`.
- **Personnage et consignes** : `server/persona.md` remplace la présentation de Claire (les règles de
  prudence restent ajoutées par le serveur).
- **Réglages du serveur** (modèle, voix, limites…) : `server/.env` (voir `server/.env.example`), puis
  `launchctl kickstart -k gui/$(id -u)/fr.hackathon2026.serveur`.

## Mettre à jour

```bash
cd ~/Hackathon2026 && bash mac/mettre-a-jour.sh
```

## Pour les développeurs

```bash
npm install
npm run server      # serveur (Ollama, Kokoro et whisper doivent tourner)
npm run dev         # application en développement, questions relayées vers le serveur (port 8090)
npm test
npm run build
```

- `server/` : serveur Node sans dépendance lourde (API compatible OpenAI avec file d'attente et sources,
  RAG, journal des questions, résumés, envoi d'e-mails).
- `src/edition.ts` : ce qui distingue l'édition dans l'application (réglages imposés, accueil).
- `scripts/build-claire.py` régénère Claire à partir du modèle d'exemple de pixiv (licence VRM 1.0 :
  modification et redistribution autorisées) ; `npm run fetch-avatar` télécharge d'abord le modèle.

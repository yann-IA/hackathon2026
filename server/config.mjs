// Configuration du serveur de l'assistante (édition événement). Tout se règle dans server/.env (voir server/.env.example) ;
// les valeurs ci-dessous sont celles utilisées par défaut.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** Lit un fichier « CLE=valeur » (lignes vides et commentaires # ignorés). */
export function parseEnv(text) {
  const out = {}
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (!m || line.trimStart().startsWith('#')) continue
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

export function loadConfig(overrides = {}) {
  const file = resolve(here, '.env')
  const env = { ...(existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {}), ...process.env, ...overrides }
  const num = (k, d) => (env[k] !== undefined && env[k] !== '' ? Number(env[k]) : d)
  const llmUrl = env.LLM_URL || 'http://127.0.0.1:11434'
  return {
    port: num('PORT', 8090), // 8090 : peut tourner sur le même Mac que Camille (8080)
    // 127.0.0.1 : seul le tunnel (Tailscale Funnel ou Cloudflare) peut joindre le serveur.
    host: env.HOST || '127.0.0.1',
    // l'assistante et l'événement (repris dans ses consignes, ses messages et les résumés)
    assistant: {
      name: env.ASSISTANT_NAME || 'Claire',
      event: env.EVENT_NAME || 'Hackathon 2026',
      contact: env.EVENT_CONTACT || "l'équipe d'organisation",
    },
    dist: resolve(here, '..', env.DIST_DIR || 'dist'),
    documents: resolve(here, env.DOCUMENTS_DIR || 'documents'),
    dataDir: resolve(here, env.DATA_DIR || 'data'),
    // journal des questions des salariés (anonyme) et résumés envoyés par e-mail
    questionsFile: resolve(here, '..', env.QUESTIONS_FILE || 'Questions.csv'),
    reportsDir: resolve(here, '..', env.REPORTS_DIR || 'Résumés'),
    logQuestions: env.LOG_QUESTIONS !== 'false',
    // téléchargement des documents depuis les sources : coupé par défaut (documents internes)
    docsDownload: env.DOCS_DOWNLOAD === 'true',
    report: {
      email: env.REPORT_EMAIL || '', // destinataire(s), séparés par des virgules
      schedule: env.REPORT_SCHEDULE || 'quotidien', // quotidien, hebdomadaire ou jamais
      day: num('REPORT_DAY', 1), // hebdomadaire : 1 = lundi … 0 = dimanche
      // heures d'envoi, séparées par des virgules (pendant l'événement : 8 h, 12 h et 17 h)
      hours: String(env.REPORT_HOURS || env.REPORT_HOUR || '8,12,17')
        .split(',')
        .map((h) => Number(h.trim()))
        .filter((h) => Number.isInteger(h) && h >= 0 && h < 24)
        .sort((a, b) => a - b),
    },
    smtp: {
      host: env.SMTP_HOST || 'smtp.gmail.com',
      port: num('SMTP_PORT', 465),
      // ssl (465), starttls (587) ou aucune (relais interne sur le port 25)
      security: env.SMTP_SECURITY || { 465: 'ssl', 587: 'starttls' }[num('SMTP_PORT', 465)] || 'aucune',
      user: env.SMTP_USER || '',
      // mot de passe d'application Gmail : affiché par groupes de 4 lettres, les espaces sont retirés
      pass: (env.SMTP_PASS || '').replace(/\s+/g, ''),
      from: env.SMTP_FROM || '',
    },
    llm: {
      // « ollama » (API native d'Ollama) ou « openai » (LM Studio, llama.cpp, MLX…)
      api: env.LLM_API || 'ollama',
      url: llmUrl,
      model: env.LLM_MODEL || 'mistral-nemo',
      apiKey: env.LLM_API_KEY || '', // serveur compatible OpenAI protégé par une clé (vLLM --api-key…)
      temperature: num('LLM_TEMPERATURE', 0.2), // bas : réponses fidèles aux documents
      maxTokens: num('LLM_MAX_TOKENS', 450),
      contextTokens: num('LLM_CONTEXT', 6144),
      // modèles qui « réfléchissent » (qwen3…) : false pour répondre tout de suite
      think: env.LLM_THINK === undefined || env.LLM_THINK === '' ? undefined : env.LLM_THINK === 'true',
    },
    embed: {
      url: env.EMBED_URL || llmUrl,
      model: env.EMBED_MODEL || 'bge-m3',
    },
    tts: {
      url: env.TTS_URL || 'http://127.0.0.1:8880/v1',
      model: env.TTS_MODEL || 'kokoro',
      voice: env.TTS_VOICE || 'ff_siwis',
      speed: num('TTS_SPEED', 1.05),
    },
    stt: {
      // « whispercpp » (whisper-server de whisper.cpp) ou « openai » (speaches, faster-whisper-server…)
      api: env.STT_API || 'whispercpp',
      url: env.STT_URL || 'http://127.0.0.1:8178/inference',
      model: env.STT_MODEL || 'whisper-1',
    },
    limits: {
      concurrent: num('MAX_CONCURRENT', 2), // réponses générées en même temps
      queue: num('MAX_QUEUE', 30), // personnes en attente au-delà
      perMinute: num('MAX_PER_MINUTE', 10), // questions par minute et par appareil
      ttsPerMinute: num('MAX_TTS_PER_MINUTE', 60),
      maxQuestionChars: num('MAX_QUESTION_CHARS', 600),
      maxHistory: num('MAX_HISTORY', 8),
      maxAudioBytes: num('MAX_AUDIO_BYTES', 8 * 1024 * 1024),
    },
    rag: {
      topK: num('RAG_TOP_K', 4),
      chunkChars: num('RAG_CHUNK_CHARS', 900),
      overlap: num('RAG_OVERLAP', 150),
      minScore: num('RAG_MIN_SCORE', 0.3),
      // documents toujours fournis au modèle, quelle que soit la question (noms de fichiers, séparés
      // par des virgules) : la vue d'ensemble que l'assistante doit toujours connaître
      always: String(env.RAG_ALWAYS ?? 'Sujets du Hackathon 2026.md')
        .split(',')
        .map((f) => f.trim())
        .filter(Boolean),
    },
  }
}

#!/usr/bin/env node
// Serveur de l'assistante (édition événement) : sert l'application et répond aux questions à
// partir des documents de server/documents, avec un modèle de langue, une voix et une écoute
// qui tournent sur le Mac. Usage : npm run server   (npm run index : indexer puis quitter)
import { createReadStream, realpathSync, watch } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadConfig } from './config.mjs'
import { Gate, RateLimiter } from './limits.mjs'
import { streamChat } from './llm.mjs'
import { buildMessages, searchQuery } from './prompt.mjs'
import { QuestionLog, TagStripper, plainAnswer } from './questions.mjs'
import { DocumentIndex, ollamaEmbedder } from './rag.mjs'
import { scheduleReports } from './report.mjs'
import { Suggestions } from './suggestions.mjs'

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.vrm': 'model/gltf-binary', '.vrma': 'model/gltf-binary', '.webmanifest': 'application/manifest+json',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.wasm': 'application/wasm',
}

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json' : 'text/plain; charset=utf-8', ...headers })
  res.end(data)
}

const apiError = (res, status, message) => send(res, status, { error: { message } })

async function readBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > limit) throw Object.assign(new Error('Requête trop volumineuse'), { status: 413 })
    chunks.push(c)
  }
  return Buffer.concat(chunks)
}

/** Adresse de l'appareil : derrière le tunnel, elle est transmise dans les en-têtes. */
function clientKey(req) {
  const remote = req.socket.remoteAddress ?? ''
  const local = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  const fwd = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']
  return local && fwd ? String(fwd).split(',')[0].trim() : remote
}

export async function createAssistantServer(overrides = {}, { log = console } = {}) {
  const cfg = loadConfig(overrides)
  const index = new DocumentIndex({
    documents: cfg.documents,
    dataDir: cfg.dataDir,
    embed: overrides.embed ?? ollamaEmbedder(cfg.embed),
    chunkChars: cfg.rag.chunkChars,
    overlap: cfg.rag.overlap,
    log,
  })
  await index.load()
  const gate = new Gate(cfg.limits.concurrent, cfg.limits.queue)
  const chatLimit = new RateLimiter(cfg.limits.perMinute)
  const ttsLimit = new RateLimiter(cfg.limits.ttsPerMinute)
  const stats = { questions: 0, unanswered: 0, errors: 0, since: new Date().toISOString() }
  const questionLog = cfg.logQuestions ? new QuestionLog(cfg.questionsFile) : null
  const suggestions = new Suggestions({ index, dataDir: cfg.dataDir, llm: cfg.llm, chat: overrides.streamChat ?? streamChat, gate, assistant: cfg.assistant, log })
  await suggestions.load()

  async function chat(req, res) {
    const key = clientKey(req)
    if (!chatLimit.allow(key)) return apiError(res, 429, 'Beaucoup de questions en peu de temps : patiente une minute avant de reposer une question.')
    let body
    try {
      body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8'))
    } catch (e) {
      return apiError(res, e.status ?? 400, e.status ? e.message : 'Requête invalide')
    }
    const query = searchQuery(body.messages)
    if (!query.trim()) return apiError(res, 400, 'Question vide')

    const abort = new AbortController()
    res.on('close', () => abort.abort())
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    const event = (data) => !res.writableEnded && res.write(`data: ${JSON.stringify(data)}\n\n`)
    const keepAlive = setInterval(() => !res.writableEnded && res.write(': attente\n\n'), 15_000)
    let release = null
    try {
      release = await gate.acquire((position) => event({ edition: { queue: position } }), abort.signal)
      if (abort.signal.aborted) return
      if (!release) {
        event({ error: { message: `${cfg.assistant.name} répond déjà à beaucoup de monde : réessaie dans une minute.` } })
        return
      }
      event({ edition: { queue: 0 } })
      let passages = []
      try {
        passages = await index.search(query, cfg.rag.topK, cfg.rag.minScore)
      } catch (e) {
        log.warn(`Recherche documentaire impossible : ${e.message}`)
      }
      const seen = new Set()
      const sources = passages.filter((p) => !seen.has(p.file) && seen.add(p.file)).map((p) => ({ title: p.title, page: p.page, ...(cfg.docsDownload ? { file: p.file, url: `/docs/${encodeURIComponent(p.file)}` } : {}) }))
      event({ edition: { sources } })
      const messages = buildMessages(body.messages, passages, cfg.limits, cfg.assistant)
      if (!messages) {
        event({ error: { message: 'Question vide' } })
        return
      }
      stats.questions++
      // la balise [inconnu] (documents sans la réponse) est retirée du texte et les sources effacées
      const strip = new TagStripper()
      let answer = ''
      const emit = (text) => {
        if (!text) return
        answer += text
        event({ choices: [{ delta: { content: text } }] })
      }
      try {
        for await (const piece of (overrides.streamChat ?? streamChat)(cfg.llm, messages, abort.signal)) {
          const wasFound = strip.found
          emit(strip.push(piece))
          if (strip.found && !wasFound) event({ edition: { sources: [] } })
        }
        emit(strip.flush())
      } finally {
        const answered = !strip.found && plainAnswer(answer).length > 0
        if (!answered) stats.unanswered++
        const question = [...body.messages].reverse().find((m) => m?.role === 'user' && typeof m.content === 'string')?.content ?? query
        questionLog
          ?.add({ question: question.trim(), answered, sources: answered ? sources.map((s_) => s_.title) : [], answer: answer || '(pas de réponse : erreur du serveur ou question interrompue)' })
          .catch((e) => log.warn(`Journal des questions : ${e.message}`))
      }
      if (!res.writableEnded) res.write('data: [DONE]\n\n')
    } catch (e) {
      if (!abort.signal.aborted) {
        stats.errors++
        log.warn(`Réponse impossible : ${e.message}`)
        event({ error: { message: `${cfg.assistant.name} ne peut pas répondre pour le moment (le serveur est peut-être surchargé). Réessaie dans un instant.` } })
      }
    } finally {
      clearInterval(keepAlive)
      release?.()
      res.end()
    }
  }

  async function speech(req, res) {
    if (!ttsLimit.allow(clientKey(req))) return apiError(res, 429, 'Trop de demandes de voix')
    let body
    try {
      body = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8'))
    } catch {
      return apiError(res, 400, 'Requête invalide')
    }
    const input = String(body.input ?? '').slice(0, 600).trim()
    if (!input) return apiError(res, 400, 'Texte vide')
    try {
      const upstream = await fetch(`${cfg.tts.url.replace(/\/+$/, '')}/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: cfg.tts.model, input, voice: cfg.tts.voice, response_format: 'mp3', speed: cfg.tts.speed }),
      })
      if (!upstream.ok) throw new Error(`voix : erreur ${upstream.status}`)
      res.writeHead(200, { 'Content-Type': upstream.headers.get('content-type') ?? 'audio/mpeg', 'Cache-Control': 'no-store' })
      for await (const c of upstream.body) res.write(c)
      res.end()
    } catch (e) {
      log.warn(`Synthèse vocale impossible : ${e.message}`)
      if (!res.headersSent) apiError(res, 502, `La voix de ${cfg.assistant.name} est indisponible pour le moment.`)
      else res.end()
    }
  }

  async function transcription(req, res) {
    if (!chatLimit.allow(`stt:${clientKey(req)}`)) return apiError(res, 429, 'Trop de demandes')
    let audio
    try {
      audio = await readBody(req, cfg.limits.maxAudioBytes)
    } catch (e) {
      return apiError(res, e.status ?? 400, e.message)
    }
    try {
      const url = cfg.stt.api === 'openai' ? `${cfg.stt.url.replace(/\/+$/, '')}/audio/transcriptions` : cfg.stt.url
      const upstream = await fetch(url, { method: 'POST', headers: { 'Content-Type': req.headers['content-type'] ?? 'application/octet-stream' }, body: audio })
      if (!upstream.ok) throw new Error(`écoute : erreur ${upstream.status}`)
      const json = await upstream.json()
      send(res, 200, { text: String(json.text ?? '').trim() })
    } catch (e) {
      log.warn(`Transcription impossible : ${e.message}`)
      apiError(res, 502, 'La reconnaissance vocale est indisponible : écris ta question.')
    }
  }

  async function serveFile(res, file, cache) {
    try {
      const st = await stat(file)
      if (!st.isFile()) return false
      res.writeHead(200, { 'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': cache })
      createReadStream(file).pipe(res)
      return true
    } catch {
      return false
    }
  }

  /** Fichier demandé, seulement s'il est bien dans le dossier autorisé. */
  function safeJoin(root, urlPath) {
    let p
    try {
      p = decodeURIComponent(urlPath)
    } catch {
      return null
    }
    const full = normalize(join(root, p))
    return full === root || full.startsWith(root + sep) ? full : null
  }

  const server = createServer(async (req, res) => {
    const started = Date.now()
    const url = new URL(req.url ?? '/', 'http://local')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.on('finish', () => {
      if (url.pathname.startsWith('/api/')) log.info(`${new Date().toISOString()} ${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started} ms`)
    })
    try {
      if (req.method === 'POST' && url.pathname === '/api/chat/completions') return await chat(req, res)
      if (req.method === 'POST' && url.pathname === '/api/audio/speech') return await speech(req, res)
      if (req.method === 'POST' && url.pathname === '/api/audio/transcriptions') return await transcription(req, res)
      if (req.method !== 'GET' && req.method !== 'HEAD') return apiError(res, 405, 'Méthode non autorisée')
      if (url.pathname === '/api/health') return send(res, 200, { ok: true, model: cfg.llm.model, documents: index.list().length, passages: index.size, waiting: gate.waiting.length, running: gate.running, ...stats })
      if (url.pathname === '/api/suggestions') return send(res, 200, { questions: suggestions.pick(12) }, { 'Cache-Control': 'no-store' })
      if (url.pathname === '/api/documents') return send(res, 200, index.list().map(({ file, title }) => ({ title, ...(cfg.docsDownload ? { url: `/docs/${encodeURIComponent(file)}` } : {}) })))
      if (url.pathname.startsWith('/docs/') && cfg.docsDownload) {
        const file = safeJoin(cfg.documents, url.pathname.slice(6))
        if (file && (await serveFile(res, file, 'public, max-age=300'))) return
        return send(res, 404, 'Document introuvable')
      }
      // application (fichiers produits par « npm run build »)
      const file = safeJoin(cfg.dist, url.pathname === '/' ? '/index.html' : url.pathname)
      const cache = url.pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : /\.(vrm|vrma|jpg|png|svg)$/.test(url.pathname) ? 'public, max-age=86400' : 'no-cache'
      if (file && (await serveFile(res, file, cache))) return
      if (!extname(url.pathname) && (await serveFile(res, join(cfg.dist, 'index.html'), 'no-cache'))) return
      send(res, 404, 'Introuvable')
    } catch (e) {
      log.warn(`Erreur ${url.pathname} : ${e.message}`)
      if (!res.headersSent) apiError(res, 500, 'Erreur du serveur')
      else res.end()
    }
  })

  return { server, index, gate, cfg, stats, suggestions }
}

/** Réindexe quand des documents sont ajoutés, modifiés ou supprimés (après 3 s de calme). */
function watchDocuments(index, log, onSynced) {
  let timer = null
  try {
    watch(index.documents, () => {
      clearTimeout(timer)
      timer = setTimeout(() => index.sync().then(onSynced).catch((e) => log.warn(`Indexation : ${e.message}`)), 3000)
    })
  } catch (e) {
    log.warn(`Surveillance du dossier impossible : ${e.message}`)
  }
}

// lancé directement (node server/index.mjs) et non importé par les tests
const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    return false
  }
})()
if (isMain) {
  const { server, index, cfg, suggestions } = await createAssistantServer()
  if (process.argv.includes('--index-only')) {
    await index.sync()
    console.info(`Base documentaire : ${index.list().length} document(s), ${index.size} passage(s).`)
    process.exit(0)
  }
  server.listen(cfg.port, cfg.host, () => {
    console.info(`${cfg.assistant.name} écoute sur http://${cfg.host}:${cfg.port} (modèle ${cfg.llm.model}, documents : ${cfg.documents})`)
  })
  index
    .sync()
    .then(() => console.info(`Base documentaire : ${index.list().length} document(s), ${index.size} passage(s).`))
    .then(() => suggestions.refresh()) // questions d'exemple pour l'accueil, tirées des documents
    .catch((e) => console.warn(`Indexation impossible (Ollama est-il lancé ?) : ${e.message}`))
  watchDocuments(index, console, () => suggestions.refresh())
  scheduleReports(cfg, { log: console })
}

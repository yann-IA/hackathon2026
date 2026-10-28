// Base documentaire (RAG) : les documents sont découpés en passages, chaque passage reçoit une
// « empreinte de sens » (embedding) calculée par Ollama, et l'index est enregistré dans
// server/data/index.json. Pour chaque question, on retrouve les passages les plus proches.
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { SUPPORTED, extractPages } from './extract.mjs'

const INDEX_VERSION = 1

/** Nettoie le texte extrait (espaces, césures de fin de ligne). */
export function cleanText(text) {
  return text
    .replace(/\r/g, '')
    .replace(/(\w)-\n(\w)/g, '$1$2')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Découpe des pages en passages d'environ `size` caractères, qui se chevauchent de `overlap`,
 * en coupant de préférence entre deux paragraphes ou deux phrases. [{ page, text }]
 */
export function chunkPages(pages, size = 900, overlap = 150) {
  const chunks = []
  for (const { page, text } of pages) {
    const t = cleanText(text)
    if (!t) continue
    let start = 0
    while (start < t.length) {
      let end = Math.min(t.length, start + size)
      if (end < t.length) {
        const window = t.slice(start + Math.floor(size * 0.5), end)
        const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('. '), window.lastIndexOf('\n'))
        if (cut > 0) end = start + Math.floor(size * 0.5) + cut + 1
      }
      const piece = t.slice(start, end).trim()
      if (piece.length > 20) chunks.push({ page, text: piece })
      if (end >= t.length) break
      start = Math.max(end - overlap, start + 1)
    }
  }
  return chunks
}

/** Titre lisible tiré du nom de fichier : « tract_CAP-2026.pdf » -> « tract CAP 2026 ». */
export function titleOf(file) {
  return basename(file, extname(file)).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
}

const normalize = (v) => {
  let n = 0
  for (const x of v) n += x * x
  n = Math.sqrt(n) || 1
  return v.map((x) => x / n)
}

/** Mots significatifs (sans accents, plus de 2 lettres, au singulier) : sert de bonus « mots-clés ». */
export function keywords(text) {
  const STOP = new Set(['les', 'des', 'une', 'est', 'que', 'qui', 'pour', 'dans', 'par', 'sur', 'avec', 'pas', 'plus', 'son', 'ses', 'aux', 'mais', 'comment', 'quand', 'quel', 'quelle', 'quels', 'quelles', 'cette', 'ces', 'vous', 'nous', 'elle', 'ils', 'tout', 'tous', 'etre', 'avoir', 'fait', 'faire', 'peut', 'peux', 'est-ce', 'sont', 'ont', 'quoi', 'faut', 'leur', 'leurs', 'mon', 'mes', 'ton', 'tes'])
  return new Set(
    text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
      .map((w) => (w.length > 3 ? w.replace(/(?<=[^s])[sx]$/, '') : w)), // « sujets » = « sujet »
  )
}

/** Client d'embeddings Ollama (/api/embed). */
export function ollamaEmbedder({ url, model }) {
  return async (texts) => {
    const out = []
    for (let i = 0; i < texts.length; i += 16) {
      const res = await fetch(`${url.replace(/\/+$/, '')}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: texts.slice(i, i + 16) }),
      })
      if (!res.ok) throw new Error(`Embeddings : erreur ${res.status} ${await res.text()}`)
      const json = await res.json()
      out.push(...json.embeddings)
    }
    return out
  }
}

export class DocumentIndex {
  constructor({ documents, dataDir, embed, chunkChars = 900, overlap = 150, log = console }) {
    Object.assign(this, { documents, dataDir, embed, chunkChars, overlap, log })
    this.file = join(dataDir, 'index.json')
    this.docs = {} // nom de fichier -> { signature, title, chunks: [{ page, text, vector, words }] }
    this.syncing = null
  }

  async load() {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'))
      if (data.version === INDEX_VERSION) this.docs = data.docs
    } catch {
      this.docs = {}
    }
    // comme à l'indexation : le titre du document compte dans les mots-clés de chaque passage
    for (const d of Object.values(this.docs)) for (const c of d.chunks) c.words = keywords(`${d.title} ${c.text}`)
  }

  async save() {
    await mkdir(this.dataDir, { recursive: true })
    const docs = Object.fromEntries(
      Object.entries(this.docs).map(([k, d]) => [k, { ...d, chunks: d.chunks.map(({ words, ...c }) => c) }]),
    )
    await writeFile(this.file, JSON.stringify({ version: INDEX_VERSION, docs }))
  }

  get size() {
    return Object.values(this.docs).reduce((n, d) => n + d.chunks.length, 0)
  }

  list() {
    return Object.entries(this.docs).map(([file, d]) => ({ file, title: d.title, chunks: d.chunks.length }))
  }

  /** Met l'index à jour : documents ajoutés, modifiés ou supprimés. Un seul passage à la fois. */
  sync() {
    this.syncing ??= this._sync().finally(() => (this.syncing = null))
    return this.syncing
  }

  async _sync() {
    await mkdir(this.documents, { recursive: true })
    const files = (await readdir(this.documents)).filter((f) => SUPPORTED.includes(extname(f).toLowerCase()) && !f.startsWith('.') && !/^lisezmoi/i.test(f))
    let changed = false
    for (const f of Object.keys(this.docs)) {
      if (!files.includes(f)) {
        delete this.docs[f]
        changed = true
        this.log.info(`- ${f} retiré de la base`)
      }
    }
    for (const f of files) {
      const path = join(this.documents, f)
      const st = await stat(path)
      const signature = `${st.size}:${Math.round(st.mtimeMs)}`
      if (this.docs[f]?.signature === signature) continue
      try {
        const pages = await extractPages(path, this.log)
        const chunks = chunkPages(pages, this.chunkChars, this.overlap)
        const title = titleOf(f)
        // le titre aide la recherche (« tract CAP », « profession de foi »…)
        const vectors = chunks.length ? await this.embed(chunks.map((c) => `${title}\n${c.text}`)) : []
        this.docs[f] = {
          signature,
          title,
          chunks: chunks.map((c, i) => ({ ...c, vector: normalize(vectors[i]), words: keywords(`${title} ${c.text}`) })),
        }
        changed = true
        this.log.info(`+ ${f} : ${chunks.length} passage(s)${chunks.length ? '' : ' (aucun texte trouvé)'}`)
      } catch (e) {
        this.log.warn(`! ${f} : ${e.message}`)
      }
    }
    if (changed) await this.save()
    return changed
  }

  /**
   * Documents fournis au modèle à chaque question (ex. la liste des sujets) : tous leurs passages,
   * dans l'ordre, jusqu'à `maxChars` caractères.
   */
  pinned(files, maxChars = 3500) {
    const out = []
    let total = 0
    for (const file of files) {
      const d = this.docs[file]
      if (!d) continue
      for (const c of d.chunks) {
        if (total + c.text.length > maxChars) return out
        out.push({ file, title: d.title, page: c.page, text: c.text, pinned: true })
        total += c.text.length
      }
    }
    return out
  }

  /**
   * Passages les plus pertinents pour une question : similarité de sens (cosinus), avec un petit
   * bonus pour les mots-clés communs (dates, sigles, noms propres…).
   */
  async search(query, k = 4, minScore = 0.3) {
    if (!this.size) return []
    const [qv] = await this.embed([query])
    const q = normalize(qv)
    const qw = keywords(query)
    const scored = []
    for (const [file, d] of Object.entries(this.docs)) {
      for (const c of d.chunks) {
        let dot = 0
        for (let i = 0; i < q.length; i++) dot += q[i] * c.vector[i]
        let common = 0
        for (const w of qw) if (c.words.has(w)) common++
        const score = dot + (qw.size ? (0.15 * common) / qw.size : 0)
        scored.push({ file, title: d.title, page: c.page, text: c.text, score })
      }
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.filter((s) => s.score >= minScore).slice(0, k)
  }
}

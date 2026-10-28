// Questions d'exemple tirées des documents : pour chaque document, le modèle propose quelques
// questions dont la réponse s'y trouve. L'accueil les fait défiler, si bien qu'elles couvrent tout ce
// que l'assistante sait. Gardées dans data/suggestions.json et refaites seulement pour les documents
// nouveaux ou modifiés.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Lignes de la réponse du modèle qui sont de vraies questions courtes. */
export function parseQuestions(text, max = 3) {
  const seen = new Set()
  const out = []
  for (const raw of String(text).split(/\r?\n/)) {
    const q = raw
      .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')
      .replace(/^["«“\s]+|["»”\s]+$/g, '')
      .replace(/\s+\?$/, ' ?')
      .trim()
    if (!q.endsWith('?') || q.length < 12 || q.length > 80 || /\[|\]/.test(q)) continue
    const key = q.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(q.replace(/([^ ])\?$/, '$1 ?'))
    if (out.length >= max) break
  }
  return out
}

/** Extrait représentatif d'un document : son début, puis un passage du milieu. */
function excerpt(chunks, size = 1800) {
  const picked = [chunks[0], chunks[Math.floor(chunks.length / 2)]].filter((c, i, a) => c && a.indexOf(c) === i)
  return picked.map((c) => c.text).join('\n…\n').slice(0, size)
}

export class Suggestions {
  constructor({ index, dataDir, llm, chat, gate, assistant, log = console, perDoc = 2 }) {
    Object.assign(this, { index, llm, chat, gate, assistant, log, perDoc })
    this.file = join(dataDir, 'suggestions.json')
    this.dataDir = dataDir
    this.docs = {}
  }

  async load() {
    try {
      this.docs = JSON.parse(await readFile(this.file, 'utf8')).docs ?? {}
    } catch {
      this.docs = {}
    }
  }

  /** Questions pour les documents nouveaux ou modifiés (un passage à la fois, en arrière-plan). */
  refresh() {
    this.running ??= this._refresh().finally(() => (this.running = null))
    return this.running
  }

  async _refresh() {
    let changed = false
    for (const file of Object.keys(this.docs)) {
      if (this.index.docs[file]) continue
      delete this.docs[file]
      changed = true
    }
    for (const [file, d] of Object.entries(this.index.docs)) {
      if (this.docs[file]?.signature === d.signature || !d.chunks.length) continue
      // les visiteurs passent avant : on prend une place dans la file comme une question
      const release = await this.gate.acquire(() => {})
      if (!release) return changed && this.save()
      try {
        const messages = [
          {
            role: 'system',
            content: `Tu prépares des exemples de questions affichés à l'accueil de ${this.assistant.name}, l'assistante virtuelle de l'événement « ${this.assistant.event} ». Réponds uniquement par les questions, une par ligne.`,
          },
          {
            role: 'user',
            content: `Document « ${d.title} » (extrait) :\n\n${excerpt(d.chunks)}\n\nPropose ${this.perDoc} questions courtes et variées (huit mots au plus) qu'un participant pourrait poser et dont la réponse se trouve dans cet extrait. Une question par ligne, sans numéro ni tiret, chacune terminée par un point d'interrogation.`,
          },
        ]
        let text = ''
        for await (const piece of this.chat({ ...this.llm, temperature: 0.5, maxTokens: 120 }, messages)) text += piece
        this.docs[file] = { signature: d.signature, title: d.title, questions: parseQuestions(text, this.perDoc) }
        changed = true
        this.log.info(`? ${file} : ${this.docs[file].questions.join(' / ') || 'aucune question proposée'}`)
      } catch (e) {
        this.log.warn(`Questions d'exemple pour ${file} impossibles : ${e.message}`)
      } finally {
        release()
      }
    }
    if (changed) await this.save()
    return changed
  }

  async save() {
    await mkdir(this.dataDir, { recursive: true })
    await writeFile(this.file, JSON.stringify({ docs: this.docs }))
  }

  /** Jusqu'à `n` questions, prises tour à tour dans chaque document (ordre mélangé). */
  pick(n = 12) {
    const lists = Object.values(this.docs)
      .map((d) => [...d.questions].sort(() => Math.random() - 0.5))
      .filter((l) => l.length)
      .sort(() => Math.random() - 0.5)
    const out = []
    for (let round = 0; out.length < n && lists.some((l) => l[round]); round++) {
      for (const l of lists) if (l[round] && out.length < n) out.push(l[round])
    }
    return out
  }
}

// Journal des questions posées à l'assistante (fichier Questions.csv, ouvrable avec Numbers ou Excel) et
// repérage des questions auxquelles elle n'a pas su répondre.
// Rien n'identifie la personne : ni adresse, ni appareil ; seulement la date, la question et la réponse.
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Balise que le modèle place au début de sa réponse quand les documents ne contiennent pas la réponse. */
export const UNKNOWN_TAG = '[inconnu]'

/**
 * Retire la balise [inconnu] d'un texte reçu morceau par morceau (elle peut être coupée en deux),
 * et retient si elle a été vue.
 */
export class TagStripper {
  constructor(tag = UNKNOWN_TAG) {
    this.tag = tag.toLowerCase()
    this.pending = ''
    this.found = false
    this.eatSpace = false // espace qui suivait la balise, éventuellement dans le morceau suivant
  }

  push(text) {
    let s = this.pending + text
    this.pending = ''
    if (this.eatSpace && s) {
      s = s.replace(/^ /, '')
      this.eatSpace = false
    }
    let out = ''
    for (;;) {
      const i = s.indexOf('[')
      if (i < 0) return out + s
      out += s.slice(0, i)
      s = s.slice(i)
      const head = s.slice(0, this.tag.length).toLowerCase()
      if (head === this.tag) {
        this.found = true
        s = s.slice(this.tag.length)
        if (s) s = s.replace(/^ /, '')
        else this.eatSpace = true
      } else if (this.tag.startsWith(head)) {
        this.pending = s // balise peut-être coupée : on attend la suite
        return out
      } else {
        out += '['
        s = s.slice(1)
      }
    }
  }

  flush() {
    const rest = this.pending
    this.pending = ''
    return rest
  }
}

/** Réponse lisible : sans balises d'émotion ni de geste. */
export const plainAnswer = (text) => text.replace(/\[[a-zA-Zéè-]+\]\s*/g, '').replace(/\s+/g, ' ').trim()

const pad = (n) => String(n).padStart(2, '0')
/** Date à l'heure du Mac, triable et reconnue par Excel : « 2026-10-17 12:24 ». */
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
function parseStamp(s) {
  const m = s.match(/^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)(?::(\d\d))?$/)
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)) : new Date(s)
}

const COLUMNS = ['Date', 'Question', 'Réponse trouvée', 'Sources', 'Réponse de l’assistante']
const SEP = ';' // séparateur attendu par Excel et Numbers en français

const cell = (v) => {
  const s = String(v ?? '').replace(/\r?\n/g, ' ')
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Découpe une ligne CSV (guillemets doublés). */
function parseLine(line) {
  const out = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') (cur += '"'), i++
      else if (c === '"') quoted = false
      else cur += c
    } else if (c === '"') quoted = true
    else if (c === SEP) out.push(cur), (cur = '')
    else cur += c
  }
  out.push(cur)
  return out
}

export class QuestionLog {
  constructor(file) {
    this.file = file
    this.queue = Promise.resolve()
  }

  /** Ajoute une question ; écritures à la suite les unes des autres (jamais mélangées). */
  add({ date = new Date(), question, answered, sources = [], answer = '' }) {
    const line = [stamp(date), question.slice(0, 600), answered ? 'oui' : 'non', sources.join(' | '), plainAnswer(answer).slice(0, 700)].map(cell).join(SEP) + '\r\n'
    this.queue = this.queue.then(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      const exists = await stat(this.file).then(() => true, () => false)
      // marque UTF-8 au début : Excel affiche correctement les accents
      await appendFile(this.file, (exists ? '' : '﻿' + COLUMNS.join(SEP) + '\r\n') + line)
    })
    return this.queue
  }

  /** Questions enregistrées depuis une date (toutes si since est absent). */
  async read(since) {
    let text
    try {
      text = await readFile(this.file, 'utf8')
    } catch {
      return []
    }
    return text
      .replace(/^﻿/, '')
      .split(/\r?\n/)
      .slice(1)
      .filter(Boolean)
      .map(parseLine)
      .map(([date, question, answered, sources, answer]) => ({ date: parseStamp(date), question, answered: answered === 'oui', sources: sources ? sources.split(' | ') : [], answer }))
      .filter((q) => !Number.isNaN(q.date.getTime()) && (!since || q.date > since))
  }
}

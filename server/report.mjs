#!/usr/bin/env node
// Résumé des questions posées à l'assistante : chiffres, analyse des préoccupations par le modèle local,
// questions restées sans réponse. Envoyé par e-mail (à 8 h, 12 h et 17 h par défaut) et enregistré dans
// le dossier « Résumés ».
//   npm run resume                    affiche le résumé (nouvelles questions depuis le dernier envoi)
//   npm run resume -- --tout          … en comptant toutes les questions comme nouvelles
//   npm run resume -- --envoyer       … et l'envoie par e-mail tout de suite
//   npm run essai-mail                envoie un e-mail d'essai (vérifie les réglages SMTP)
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { loadConfig } from './config.mjs'
import { streamChat } from './llm.mjs'
import { sendMail } from './mail.mjs'
import { QuestionLog } from './questions.mjs'

const frDate = (d) => d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()

/** Questions identiques (aux accents, majuscules et ponctuation près) regroupées, les plus fréquentes d'abord. */
export function groupQuestions(questions) {
  const groups = new Map()
  for (const q of questions) {
    const k = norm(q.question)
    if (!k) continue
    const g = groups.get(k) ?? { text: q.question.trim(), count: 0 }
    g.count++
    groups.set(k, g)
  }
  return [...groups.values()].sort((a, b) => b.count - a.count)
}

const line = (g) => `- ${g.count > 1 ? `(×${g.count}) ` : ''}${g.text}`

/** Analyse des thèmes et des préoccupations par le modèle de langue (texte simple). */
async function analyse(questions, llm, chat, a) {
  const list = questions
    .slice(-400)
    .map((q) => `- ${q.answered ? '' : '[sans réponse] '}${q.question.slice(0, 200).replace(/\s+/g, ' ')}`)
    .join('\n')
  const messages = [
    {
      role: 'system',
      content:
        `Tu analyses les questions posées par les participants et les visiteurs à ${a.name}, l'assistante virtuelle de l'événement « ${a.event} ». Tu écris un compte rendu pour l'équipe d'organisation. Réponds en français, en texte simple : pas de markdown, pas d'astérisques ni de dièses ; des tirets pour les listes. N'invente rien : appuie-toi uniquement sur les questions fournies.`,
    },
    {
      role: 'user',
      content: `Voici ${questions.length} questions (la mention [sans réponse] signale celles auxquelles ${a.name} n'a pas trouvé de réponse dans ses documents) :\n\n${list}\n\nRédige trois parties, chacune avec son titre sur une ligne :\nThèmes abordés : les grands thèmes, du plus fréquent au moins fréquent, avec le nombre approximatif de questions pour chacun.\nCe qui intéresse ou préoccupe le plus les participants : trois à cinq phrases.\nDocuments à ajouter : les informations qui manquent à ${a.name}, d'après les questions restées sans réponse (ou « aucun » s'il n'y en a pas).`,
    },
  ]
  let text = ''
  for await (const piece of chat({ ...llm, temperature: 0.2, maxTokens: 900, contextTokens: Math.max(llm.contextTokens, 8192) }, messages)) text += piece
  return text.replace(/\*\*|^#+\s*/gm, '').trim()
}

const hhmm = (d) => d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
const when = (d, ref) => (d.toDateString() === ref.toDateString() ? hhmm(d) : `${d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' })} ${hhmm(d)}`)

/**
 * Texte complet du résumé (et son objet d'e-mail) : les nouvelles questions depuis le résumé
 * précédent (`since`), puis le point sur toutes les questions depuis le début.
 */
export async function buildReport(questions, { since, to = new Date(), llm, chat = streamChat, questionsFile = 'Questions.csv', assistant = { name: 'Claire', event: 'Hackathon 2026' } }) {
  const a = assistant
  const fresh = since ? questions.filter((q) => q.date > since) : questions
  const unanswered = questions.filter((q) => !q.answered)
  const freshUnanswered = fresh.filter((q) => !q.answered)
  const s = (n) => (n > 1 ? 's' : '')
  const parts = [`Résumé des questions posées à ${a.name} (${a.event})\n${frDate(to)}, ${hhmm(to)}`]
  parts.push(
    `Nouvelles questions${since ? ` depuis le dernier résumé (${when(since, to)})` : ''} : ${fresh.length}` +
      (fresh.length ? `, dont ${freshUnanswered.length} sans réponse (✗)\n` + fresh.map((q) => `- ${when(q.date, to)} ${q.answered ? '✓' : '✗'} ${q.question.trim()}`).join('\n') : '\n- aucune'),
  )
  parts.push(
    `Depuis le début\n- ${questions.length} question${s(questions.length)}` +
      (questions.length ? `, dont ${questions.length - unanswered.length} avec une réponse trouvée dans les documents et ${unanswered.length} sans réponse.` : '.'),
  )
  if (questions.length) {
    let analysis
    try {
      analysis = await analyse(questions, llm, chat, a)
    } catch (e) {
      analysis = `(Analyse automatique indisponible : ${e.message}. Les listes ci-dessous restent exactes.)`
    }
    parts.push(`Analyse de ${a.name}\n${analysis}`)
    parts.push(`Questions restées sans réponse (informations à ajouter dans les documents)\n${unanswered.length ? groupQuestions(unanswered).map(line).join('\n') : '- aucune'}`)
    parts.push(`Questions les plus posées\n${groupQuestions(questions).slice(0, 15).map(line).join('\n')}`)
  }
  parts.push(`Toutes les questions, avec les réponses de ${a.name}, sont dans le fichier ${questionsFile} sur le Mac.`)
  return {
    subject: `${a.name} : ${fresh.length} nouvelle${s(fresh.length)} question${s(fresh.length)} (${questions.length} au total, ${unanswered.length} sans réponse)`,
    text: parts.join('\n\n') + '\n',
  }
}

/** Dernière échéance d'envoi passée (heure du Mac) : chaque jour aux heures prévues, ou chaque semaine. */
export function lastSlot(now, { schedule, day, hours = [8] }) {
  const hs = hours.length ? hours : [8]
  const at = (d, h) => {
    const x = new Date(d)
    x.setHours(h, 0, 0, 0)
    return x
  }
  if (schedule === 'quotidien') {
    const today = hs.map((h) => at(now, h)).filter((d) => d <= now)
    if (today.length) return today.at(-1)
    const y = new Date(now)
    y.setDate(y.getDate() - 1)
    return at(y, hs.at(-1))
  }
  const d = at(now, hs[0])
  d.setDate(d.getDate() - ((d.getDay() - day + 7) % 7)) // day : 1 = lundi … 0 = dimanche
  if (d > now) d.setDate(d.getDate() - 7)
  return d
}

const statePath = (cfg) => join(cfg.dataDir, 'resume.json')
async function readState(cfg) {
  try {
    return JSON.parse(await readFile(statePath(cfg), 'utf8'))
  } catch {
    return null
  }
}
const writeState = async (cfg, state) => (await mkdir(cfg.dataDir, { recursive: true }), writeFile(statePath(cfg), JSON.stringify(state)))

const mailReady = (cfg) => Boolean(cfg.report.email && cfg.smtp.user && cfg.smtp.pass)

/** Prépare le résumé, l'enregistre dans le dossier Résumés et l'envoie si l'e-mail est configuré. */
export async function runReport(cfg, { since, now = new Date(), send = true, chat = streamChat, log = console } = {}) {
  const questions = await new QuestionLog(cfg.questionsFile).read()
  const report = await buildReport(questions, { since, to: now, llm: cfg.llm, chat, questionsFile: cfg.questionsFile, assistant: cfg.assistant })
  await mkdir(cfg.reportsDir, { recursive: true })
  const file = join(cfg.reportsDir, `Résumé ${isoDay(now)} ${String(now.getHours()).padStart(2, '0')}h${String(now.getMinutes()).padStart(2, '0')}.txt`)
  await writeFile(file, report.text)
  let sent = false
  if (send && mailReady(cfg)) {
    await sendMail({ ...cfg.smtp, fromName: `${cfg.assistant.name} (${cfg.assistant.event})`, to: cfg.report.email, subject: report.subject, text: report.text })
    sent = true
    log.info(`Résumé envoyé à ${cfg.report.email} (${questions.length} questions)`)
  }
  return { ...report, file, sent, count: questions.length }
}

/** Envoi automatique : vérifie toutes les 5 minutes si une échéance est passée depuis le dernier résumé. */
export function scheduleReports(cfg, { log = console, chat = streamChat } = {}) {
  if (cfg.report.schedule === 'jamais') return null
  const tick = async () => {
    try {
      const now = new Date()
      const state = await readState(cfg)
      if (!state) return writeState(cfg, { last: now.toISOString() }) // premier lancement : point de départ
      const last = new Date(state.last)
      if (lastSlot(now, cfg.report) <= last) return
      const r = await runReport(cfg, { since: last, now, chat, log })
      await writeState(cfg, { last: now.toISOString() })
      if (!r.sent) log.info(`Résumé enregistré : ${r.file}${mailReady(cfg) ? '' : ' (e-mail non configuré)'}`)
    } catch (e) {
      log.warn(`Résumé des questions impossible : ${e.message} (nouvel essai dans 5 minutes)`)
    }
  }
  void tick()
  return setInterval(tick, 5 * 60_000)
}

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    return false
  }
})()
if (isMain) {
  const cfg = loadConfig()
  const args = process.argv.slice(2)
  try {
    if (args.includes('--essai-mail')) {
      if (!mailReady(cfg)) throw new Error('renseigne REPORT_EMAIL, SMTP_USER et SMTP_PASS dans server/.env')
      await sendMail({ ...cfg.smtp, fromName: `${cfg.assistant.name} (${cfg.assistant.event})`, to: cfg.report.email, subject: `${cfg.assistant.name} : e-mail d’essai`, text: 'Les résumés des questions des participants arriveront à cette adresse.\n' })
      console.info(`E-mail d'essai envoyé à ${cfg.report.email}.`)
    } else {
      const state = await readState(cfg)
      const since = args.includes('--tout') || !state ? undefined : new Date(state.last)
      const now = new Date()
      const r = await runReport(cfg, { since, now, send: args.includes('--envoyer') })
      console.info(r.text)
      console.info(`Enregistré dans : ${r.file}`)
      if (args.includes('--envoyer')) {
        if (!r.sent) console.warn("E-mail non envoyé : renseigne REPORT_EMAIL, SMTP_USER et SMTP_PASS dans server/.env")
        else await writeState(cfg, { last: now.toISOString() })
      }
    }
  } catch (e) {
    console.error(`Erreur : ${e.message}`)
    process.exit(1)
  }
}

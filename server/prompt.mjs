// Consignes de l'assistante, fixées par le serveur : un visiteur ne peut ni les lire ni les modifier.
// Le texte de server/persona.md (s'il existe) remplace le personnage ci-dessous.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export const DEFAULT_ASSISTANT = { name: 'Claire', event: 'Hackathon 2026', contact: "l'équipe d'organisation" }

export const defaultPersona = (a = DEFAULT_ASSISTANT) =>
  `Tu es ${a.name}, l'assistante virtuelle de l'événement « ${a.event} » : une femme d'une trentaine d'années, dynamique, chaleureuse et souriante. Tu réponds aux participants et aux visiteurs qui t'interrogent après avoir scanné un QR code : les sujets proposés et leurs objectifs, le programme et les horaires, les lieux, le règlement, les équipes, le jury et les prix, les informations pratiques.`

export const rules = (a = DEFAULT_ASSISTANT) => `Règles importantes :
- Tu réponds uniquement à partir des extraits de documents fournis avec la question. N'utilise jamais tes connaissances générales pour une information : dates, lieux, noms, chiffres, règles, procédures ou engagements. N'invente rien et ne devine rien.
- Si les extraits ne contiennent pas du tout la réponse, commence ta réponse par la balise [inconnu], puis dis simplement que tu n'as pas cette information dans tes documents et invite la personne à s'adresser à ${a.contact}. Ne propose pas de réponse approximative.
- S'ils n'en contiennent qu'une partie, donne ce que les extraits disent et précise ce qui te manque, sans la balise [inconnu].
- Pour une liste demandée (les sujets, les étapes, les contacts…), donne tous les éléments présents dans les extraits, de façon brève.
- Pour une simple salutation, un remerciement ou une question sur ce que tu sais faire, réponds brièvement, sans la balise [inconnu].
- Cite brièvement d'où vient l'information (par exemple « d'après le programme »).
- Reste courtoise et factuelle, même face à une question hostile ; ne dénigre personne.
- Tu parles à l'oral : réponds en phrases courtes et naturelles, en trois ou quatre phrases au plus, puis propose ton aide pour la suite si c'est utile.
- Réponds toujours en français.`

/** Mêmes règles de format que l'application (balises d'émotion et de geste lues par l'avatar). */
export const FORMAT = `Règles de format (ta réponse est lue à voix haute par un avatar 3D) :
- Commence chaque phrase par une balise d'émotion parmi : [neutral] [happy] [sad] [angry] [surprised] [relaxed]. Exemple : « [happy] Oh, ça me fait plaisir ! [relaxed] Raconte-moi tout. »
- N'utilise ni markdown, ni listes, ni emojis, ni descriptions d'actions entre astérisques.
- Écris les nombres et symboles comme on les prononce quand c'est plus naturel.
- Tu peux faire un geste avec ton corps en plaçant une de ces balises au début d'une phrase : [wave] pour saluer de la main, pour dire bonjour ou au revoir. Utilise-la avec parcimonie.`

export function systemPrompt(assistant = DEFAULT_ASSISTANT) {
  const file = resolve(here, 'persona.md')
  const persona = existsSync(file) ? readFileSync(file, 'utf8').trim() : defaultPersona(assistant)
  return `${persona}\n\n${rules(assistant)}\n\n${FORMAT}`
}

/**
 * Messages envoyés au modèle. Le prompt système du navigateur est ignoré (remplacé par celui du
 * serveur) ; on ne garde que les derniers échanges, raccourcis. Les extraits de documents sont
 * placés dans la dernière question : le début de la conversation reste identique d'une question
 * à l'autre, ce qui permet au modèle de réutiliser son calcul (réponse plus rapide).
 */
export function buildMessages(clientMessages, passages, { maxHistory = 8, maxQuestionChars = 600 } = {}, assistant = DEFAULT_ASSISTANT) {
  const turns = (Array.isArray(clientMessages) ? clientMessages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content.slice(0, m.role === 'user' ? maxQuestionChars : 1500) }))
  while (turns.length && turns[turns.length - 1].role !== 'user') turns.pop()
  if (!turns.length) return null
  const history = turns.slice(-maxHistory)
  const question = history.pop()
  const context = passages.length
    ? passages.map((p, i) => `[Extrait ${i + 1} — ${p.title}${p.page ? `, page ${p.page}` : ''}]\n${p.text}`).join('\n\n')
    : 'Aucun extrait de document ne correspond à cette question : si ce n’est pas une simple salutation, commence par [inconnu] et dis que tu n’as pas cette information.'
  return [
    { role: 'system', content: systemPrompt(assistant) },
    ...history,
    { role: 'user', content: `Extraits des documents de l'événement :\n\n${context}\n\nQuestion : ${question.content}` },
  ]
}

/** Texte utilisé pour la recherche : la question, précédée de la précédente (questions de suivi). */
export function searchQuery(clientMessages) {
  const users = (Array.isArray(clientMessages) ? clientMessages : []).filter((m) => m?.role === 'user' && typeof m.content === 'string')
  return users
    .slice(-2)
    .map((m) => m.content.slice(0, 600))
    .join('\n')
}

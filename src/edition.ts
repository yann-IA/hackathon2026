import type { Settings } from './settings'

/**
 * Édition événement (Hackathon 2026) : une seule avatar, Claire, accessible à tous depuis un QR code.
 * Tout passe par le serveur du Mac (server/) : modèle de langue avec les documents de l'événement
 * (RAG), voix et écoute. Les visiteurs n'ont rien à régler et aucune clé à saisir.
 * Le nom de l'assistante et de l'événement se règlent aussi côté serveur (server/.env).
 */
export const EDITION = {
  name: 'Claire',
  event: 'Hackathon 2026',
  welcome: 'Bonjour, je suis Claire ! Posez-moi vos questions sur le Hackathon 2026 : programme, règlement, infos pratiques…',
  privacy: 'Vos questions sont enregistrées de façon anonyme pour améliorer les réponses : n’y indiquez pas votre nom.',
  suggestions: ['Quel est le programme ?', 'Où et quand ça se passe ?', 'Comment former une équipe ?', 'Qu’est-ce qu’on peut gagner ?'],
  thinking: 'Claire cherche dans les documents…',
}

/** Réglages imposés à chaque démarrage (un ancien réglage enregistré ne peut pas les changer). */
export function applyEdition(s: Settings): void {
  s.activeProvider = 'custom'
  s.providers.custom = { ...s.providers.custom, baseUrl: '/api', apiKey: '', model: 'assistante' }
  s.useProxy = false
  // voix du serveur (Kokoro) ; si elle tombe en panne, la voix du téléphone prend le relais pour la session
  s.tts.engine = 'openai'
  s.tts.openai = { ...s.tts.openai, baseUrl: '/api', apiKey: '', model: 'kokoro', voice: 'ff_siwis', instructions: '' }
  // reconnaissance vocale du téléphone quand elle existe, sinon celle du serveur (Whisper)
  s.stt.engine = 'browser'
  s.stt.whisper = { baseUrl: '/api', apiKey: '', model: 'whisper-1' }
  s.stt.handsFree = false
  s.memory.enabled = false // pas de mémoire à long terme : chaque visiteur repart de zéro
  s.avatar.current = 'claire'
  s.persona.name = EDITION.name
  s.persona.language = 'fr-FR'
  s.historyLength = 8
  s.gestures.enabled = true
}

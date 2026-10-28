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
  welcome: 'Bonjour, je suis Claire ! Posez-moi vos questions sur le Hackathon 2026 et ses 10 sujets.',
  privacy: 'Vos questions sont enregistrées de façon anonyme pour améliorer les réponses : n’y indiquez pas votre nom.',
  // La première reste toujours en tête ; les autres défilent, mêlées aux questions que le modèle tire
  // des documents déposés sur le Mac (voir server/suggestions.mjs).
  suggestions: [
    'Quels sont les sujets du hackathon ?',
    'Comment venir depuis la gare de Poitiers ?',
    'À quelle heure commence le hackathon ?',
    'Combien de temps dure le pitch ?',
    'Quels sont les livrables attendus ?',
    'Sur quels critères le jury évalue-t-il ?',
    'C’est quoi le Skill Center ?',
    'Qui est le DIAM de mon sujet ?',
    'Que faut-il apporter ?',
    'Qui contacter pendant l’événement ?',
    'Quels hashtags utiliser sur LinkedIn ?',
    'Quel problème veut résoudre WIFIA ?',
    'Quel sujet parle des vols de cuivre ?',
    'Que vise le projet Loi de Finances ?',
  ],
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

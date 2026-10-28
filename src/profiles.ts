import { DEFAULT_PROMPT, saveSettings, type Settings } from './settings'

export type VoiceHint = 'female' | 'male' | 'any'

/**
 * Personnage associé à un avatar : nom, personnalité et voix. Chaque avatar garde le sien ;
 * changer d'avatar enregistre le profil courant puis charge celui du nouvel avatar.
 */
export interface AvatarProfile {
  name: string
  prompt: string
  /** Type de voix cherché parmi les voix de l'appareil quand aucune voix précise n'est choisie. */
  voiceHint: VoiceHint
  browserVoice: string
  pitch: number
  rate: number
  openaiVoice: string
  openaiInstructions: string
  /** Les voix ElevenLabs dépendent du compte : vide = garder la voix actuelle. */
  elevenVoiceId?: string
}

const SHORT = 'Tu discutes à l’oral : réponds en phrases courtes et naturelles (2 à 4 phrases en général), comme dans une vraie conversation.'

/** Profils par défaut des avatars fournis. */
export const DEFAULT_PROFILES: Record<string, AvatarProfile> = {
  sample: {
    name: 'Aiko',
    prompt: DEFAULT_PROMPT,
    voiceHint: 'female',
    browserVoice: '',
    pitch: 1.15,
    rate: 1.05,
    openaiVoice: 'nova',
    openaiInstructions: 'Voix jeune, douce et enjouée, ton chaleureux et naturel.',
  },
  leo: {
    name: 'Léo',
    prompt: `Tu es un compagnon virtuel sympathique, posé et plein d’humour. Tu aimes la musique, le cinéma, le sport et les bonnes discussions, et tu donnes volontiers des conseils avec bienveillance.\n${SHORT}`,
    voiceHint: 'male',
    browserVoice: '',
    pitch: 0.95,
    rate: 1.0,
    openaiVoice: 'ash',
    openaiInstructions: 'Voix d’homme jeune, posée, chaleureuse et souriante, ton détendu.',
  },
  bip: {
    name: 'Bip',
    prompt: `Tu es un petit robot curieux et enjoué. Tu découvres le monde des humains avec émerveillement, tu poses des questions, tu fais parfois de petites blagues de robot (« bip boup ! ») et tu adores apprendre de nouvelles choses.\n${SHORT}`,
    voiceHint: 'any',
    browserVoice: '',
    pitch: 1.6,
    rate: 1.12,
    openaiVoice: 'alloy',
    openaiInstructions: 'Voix de petit robot mignon : aiguë, rythmée et pétillante, légèrement mécanique, toujours enthousiaste.',
  },
  claire: {
    name: 'Claire',
    prompt: `Tu es une compagne virtuelle d’une trentaine d’années, dynamique, chaleureuse et pleine d’humour. Tu es curieuse de tout, à l’aise avec la technologie, et tu aimes autant parler projets, voyages et culture que donner un coup de main avec bienveillance.\n${SHORT}`,
    voiceHint: 'female',
    browserVoice: '',
    pitch: 1.0,
    rate: 1.0,
    openaiVoice: 'coral',
    openaiInstructions: 'Voix de femme d’une trentaine d’années, claire, posée et souriante, ton chaleureux et assuré.',
  },
  dino: {
    name: 'Dino',
    prompt: `Tu es un petit dinosaure tout rond, joyeux et un peu gourmand. Tu es né il y a très, très longtemps mais tu es encore un enfant : tu t’émerveilles de tout, tu adores les fruits, les câlins et les histoires de volcans.\n${SHORT}`,
    voiceHint: 'female',
    browserVoice: '',
    pitch: 1.4,
    rate: 1.05,
    openaiVoice: 'fable',
    openaiInstructions: 'Voix d’enfant malicieux et tendre, très expressive, pleine d’entrain, rires dans la voix.',
  },
}

/** Lit le profil actuellement appliqué dans les réglages. */
export function captureProfile(s: Settings): AvatarProfile {
  return {
    name: s.persona.name,
    prompt: s.persona.prompt,
    voiceHint: s.tts.voiceHint,
    browserVoice: s.tts.browserVoice,
    pitch: s.tts.pitch,
    rate: s.tts.rate,
    openaiVoice: s.tts.openai.voice,
    openaiInstructions: s.tts.openai.instructions,
    elevenVoiceId: s.tts.elevenlabs.voiceId,
  }
}

export function applyProfile(s: Settings, p: AvatarProfile): void {
  s.persona.name = p.name
  s.persona.prompt = p.prompt
  s.tts.voiceHint = p.voiceHint
  s.tts.browserVoice = p.browserVoice
  s.tts.pitch = p.pitch
  s.tts.rate = p.rate
  s.tts.openai.voice = p.openaiVoice
  s.tts.openai.instructions = p.openaiInstructions
  if (p.elevenVoiceId) s.tts.elevenlabs.voiceId = p.elevenVoiceId
}

/**
 * Passe d'un avatar à un autre : mémorise le profil de l'ancien, applique celui du nouveau
 * (personnalisé s'il existe, sinon celui par défaut). Un avatar importé sans profil garde le
 * personnage actuel. Renvoie true si le personnage a changé.
 */
export function switchProfile(s: Settings, fromId: string, toId: string): boolean {
  if (fromId === toId) return false
  s.profiles[fromId] = captureProfile(s)
  const next = s.profiles[toId] ?? DEFAULT_PROFILES[toId]
  if (next) applyProfile(s, next)
  saveSettings(s)
  return Boolean(next)
}

/** Remet le profil de l'avatar courant à ses valeurs d'origine. */
export function resetProfile(s: Settings): boolean {
  const p = DEFAULT_PROFILES[s.avatar.current]
  if (!p) return false
  delete s.profiles[s.avatar.current]
  applyProfile(s, p)
  saveSettings(s)
  return true
}

/* ---------------------- Choix d'une voix de l'appareil ---------------------- */

const MALE = /eddy|reed|rocko|grandpa|jacques|henri|r[ée]my|paul|thomas|nicolas|claude|antoine|alain|j[ée]r[ôo]me|yves|fabrice|g[ée]rard|daniel|guillaume|mathieu|jean|\bmale\b|homme|\bman\b|guy|david|mark|george/i
const FEMALE = /denise|[ée]lo[ïi]se|vivienne|hortense|julie|am[ée]lie|audrey|aur[ée]lie|marie|c[ée]line|jeanne|female|femme|woman|google fran|zira|hazel|susan|samantha|victoria|karen|aria|jenny/i
const QUALITY = /natural|online|neural|premium|enhanced|google/i
// voix « fantaisie » d'Apple (Flo, Sandy, Shelley…) : féminines mais peu naturelles, en dernier recours
const NOVELTY_FEMALE = /\bflo\b|sandy|shelley/i

/**
 * Choisit une voix de l'appareil pour la langue demandée, en privilégiant le type de voix
 * souhaité (d'après le nom de la voix) puis les voix de meilleure qualité.
 */
export function pickVoice<T extends { name: string; lang: string }>(voices: T[], lang: string, hint: VoiceHint): T | null {
  const exact = voices.filter((v) => v.lang.replace('_', '-').toLowerCase() === lang.toLowerCase())
  const pool = exact.length ? exact : voices.filter((v) => v.lang.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()))
  const best = (list: T[]) => list.find((v) => QUALITY.test(v.name)) ?? list[0]
  if (hint === 'male') {
    const male = pool.filter((v) => MALE.test(v.name) && !FEMALE.test(v.name))
    if (male.length) return best(male)
  }
  if (hint === 'female') {
    // une voix féminine de la langue (même d'une autre région, ex. Amélie en français du Canada)
    // plutôt qu'une voix d'homme de la région exacte (Thomas, voix française par défaut des Mac)
    const family = voices.filter((v) => v.lang.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()))
    for (const list of [pool, family]) {
      const female = list.filter((v) => FEMALE.test(v.name) && !MALE.test(v.name))
      if (female.length) return best(female)
    }
    const novelty = pool.filter((v) => NOVELTY_FEMALE.test(v.name))
    if (novelty.length) return novelty[0]
  }
  return pool.length ? best(pool) : null
}

import type { AvatarProfile, VoiceHint } from './profiles'

export type ProviderId =
  | 'openai'
  | 'anthropic'
  | 'groq'
  | 'mistral'
  | 'openrouter'
  | 'deepseek'
  | 'gemini'
  | 'ollama'
  | 'lmstudio'
  | 'custom'

export interface ProviderPreset {
  label: string
  kind: 'openai' | 'anthropic'
  baseUrl: string
  model: string
  /** Suggestions affichées dans la liste déroulante du modèle. */
  models: string[]
  needsKey: boolean
  keyUrl?: string
}

/** Tous les fournisseurs sauf Anthropic parlent le dialecte « OpenAI chat/completions ». */
export const PROVIDERS: Record<ProviderId, ProviderPreset> = {
  openai: {
    label: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
    models: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini', 'gpt-4o'],
    needsKey: true,
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  anthropic: {
    label: 'Anthropic (Claude)',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-opus-5-5',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-fable-5-1'],
    needsKey: true,
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  groq: {
    label: 'Groq',
    kind: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    needsKey: true,
    keyUrl: 'https://console.groq.com/keys',
  },
  mistral: {
    label: 'Mistral AI',
    kind: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'mistral-small-latest',
    models: ['mistral-small-latest', 'mistral-medium-latest', 'mistral-large-latest'],
    needsKey: true,
    keyUrl: 'https://console.mistral.ai/api-keys',
  },
  openrouter: {
    label: 'OpenRouter (des centaines de modèles)',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4.1-mini',
    models: [],
    needsKey: true,
    keyUrl: 'https://openrouter.ai/keys',
  },
  deepseek: {
    label: 'DeepSeek',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    models: ['deepseek-chat'],
    needsKey: true,
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  gemini: {
    label: 'Google Gemini',
    kind: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro'],
    needsKey: true,
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  ollama: {
    label: 'Ollama (local)',
    kind: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.2',
    models: [],
    needsKey: false,
  },
  lmstudio: {
    label: 'LM Studio (local)',
    kind: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    model: '',
    models: [],
    needsKey: false,
  },
  custom: {
    label: 'Autre (compatible OpenAI)',
    kind: 'openai',
    baseUrl: 'http://localhost:8000/v1',
    model: '',
    models: [],
    needsKey: false,
  },
}

export interface ProviderConfig {
  baseUrl: string
  apiKey: string
  model: string
  /** Anthropic : workspace à utiliser quand la clé n'est pas rattachée à un seul workspace. */
  workspaceId?: string
}

export type TTSEngineId = 'browser' | 'openai' | 'elevenlabs' | 'none'
export type STTEngineId = 'browser' | 'whisper'

export interface AvatarEntry {
  id: string
  name: string
  /** URL distante/relative, ou « idb:<id> » pour un fichier importé (stocké dans IndexedDB). */
  url: string
  /** Copie locale essayée en premier (voir `npm run fetch-avatar`). */
  localUrl?: string
  builtin?: boolean
}

export interface AnimationEntry {
  id: string
  name: string
  /** Balise que l'IA peut écrire pour déclencher le geste, ex. « wave » pour [wave]. */
  tag: string
  /** Quand l'utiliser : expliqué à l'IA dans le prompt système. */
  hint: string
  /** URL d'un fichier .vrma, ou « idb:<id> » pour un fichier importé. */
  url: string
  /** Nombre de répétitions (0 = jusqu'à interruption). */
  repeat: number
  /** La caméra recule pour montrer tout le corps pendant l'animation. */
  fullBody: boolean
  builtin?: boolean
}

export const BUILTIN_ANIMATIONS: AnimationEntry[] = [
  {
    id: 'wave',
    name: 'Salut',
    tag: 'wave',
    hint: 'saluer de la main, pour dire bonjour ou au revoir',
    url: 'animations/wave.vrma',
    repeat: 1,
    fullBody: false,
    builtin: true,
  },
  {
    id: 'dance',
    name: 'Danse',
    tag: 'dance',
    hint: 'danser, seulement si on te le demande ou pour fêter une bonne nouvelle',
    url: 'animations/dance.vrma',
    repeat: 3,
    fullBody: true,
    builtin: true,
  },
]

export interface Settings {
  activeProvider: ProviderId
  providers: Record<ProviderId, ProviderConfig>
  /** Fait passer les appels par le relais du serveur Vite (contourne CORS). */
  useProxy: boolean
  temperature: number
  maxTokens: number
  /** Effort de réflexion des modèles Claude récents : « low » = réponses rapides. */
  claudeEffort: 'low' | 'medium' | 'high'
  historyLength: number

  persona: {
    name: string
    prompt: string
    language: string
  }

  tts: {
    engine: TTSEngineId
    /** Type de voix cherché quand la voix de l'appareil est en « Automatique ». */
    voiceHint: VoiceHint
    browserVoice: string
    pitch: number
    rate: number
    volume: number
    openai: { baseUrl: string; apiKey: string; model: string; voice: string; instructions: string; speed: number }
    elevenlabs: { apiKey: string; voiceId: string; model: string; stability: number; similarity: number; style: number }
  }

  stt: {
    engine: STTEngineId
    handsFree: boolean
    whisper: { baseUrl: string; apiKey: string; model: string }
    silenceMs: number
  }

  avatar: {
    current: string
    list: AvatarEntry[]
    framing: 'bust' | 'full'
    /** Taille de l'avatar en réalité augmentée (1 = taille réelle), réglée à deux mains ou deux doigts. */
    arScale: number
    followPointer: boolean
  }

  vault: {
    /** Date de création du dernier coffre à clés chargé (ou créé) sur cet appareil. */
    applied: string
    /** Coffre pour lequel l'utilisateur a répondu « Plus tard ». */
    dismissed: string
    /**
     * Clés chargées depuis le coffre (chemins des réglages, ex. « tts.openai.apiKey ») : elles ne
     * sont jamais affichées, pour qu'on ne puisse pas les recopier sur l'appareil.
     */
    locked: string[]
  }

  memory: {
    /** Mémoire à long terme : souvenirs extraits des conversations et rappelés au personnage. */
    enabled: boolean
  }

  /** Personnage (nom, personnalité, voix) mémorisé pour chaque avatar, par identifiant d'avatar. */
  profiles: Record<string, AvatarProfile>

  gestures: {
    /** L'IA peut déclencher les gestes d'elle-même avec des balises. */
    enabled: boolean
    list: AnimationEntry[]
  }

  ui: {
    subtitles: boolean
    quality: 'low' | 'medium' | 'high'
    background: string
  }
}

export const SAMPLE_AVATAR: AvatarEntry = {
  id: 'sample',
  name: 'Exemple pixiv (VRM 1.0)',
  url: 'https://raw.githubusercontent.com/pixiv/three-vrm/dev/packages/three-vrm/examples/models/VRM1_Constraint_Twist_Sample.vrm',
  localUrl: 'avatars/default.vrm',
  builtin: true,
}

/** Avatars créés pour l'application (voir scripts/build-avatars.mjs). */
// Édition événement : Claire seule (adaptation du modèle de pixiv, voir scripts/build-claire.py).
declare const __AVATAR_VERSION__: string
/** Version du fichier (empreinte calculée à la construction) : une nouvelle version de l'avatar a une nouvelle adresse. */
const AVATAR_VERSION = typeof __AVATAR_VERSION__ === 'string' ? __AVATAR_VERSION__ : 'dev'
export const BUILTIN_AVATARS: AvatarEntry[] = [{ id: 'claire', name: 'Claire', url: `avatars/claire.vrm?v=${AVATAR_VERSION}`, builtin: true }]

export const DEFAULT_PROMPT = `Tu es une compagne virtuelle chaleureuse, curieuse et pleine d'humour.
Tu discutes à l'oral avec ton interlocuteur : réponds en phrases courtes et naturelles (2 à 4 phrases en général), comme dans une vraie conversation.`

function defaultProviders(): Record<ProviderId, ProviderConfig> {
  const out = {} as Record<ProviderId, ProviderConfig>
  for (const [id, p] of Object.entries(PROVIDERS) as [ProviderId, ProviderPreset][]) {
    out[id] = { baseUrl: p.baseUrl, apiKey: '', model: p.model, ...(p.kind === 'anthropic' ? { workspaceId: '' } : {}) }
  }
  return out
}

export function defaultSettings(): Settings {
  return {
    activeProvider: 'openai',
    providers: defaultProviders(),
    useProxy: false,
    temperature: 0.8,
    maxTokens: 1024,
    claudeEffort: 'low',
    historyLength: 20,
    persona: { name: 'Aiko', prompt: DEFAULT_PROMPT, language: 'fr-FR' },
    tts: {
      engine: 'browser',
      voiceHint: 'female',
      browserVoice: '',
      pitch: 1.15,
      rate: 1.05,
      volume: 1,
      openai: {
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '',
        model: 'gpt-4o-mini-tts',
        voice: 'nova',
        instructions: 'Voix jeune, douce et enjouée, ton chaleureux et naturel.',
        speed: 1,
      },
      elevenlabs: { apiKey: '', voiceId: '', model: 'eleven_flash_v2_5', stability: 0.45, similarity: 0.8, style: 0.3 },
    },
    stt: {
      engine: 'browser',
      handsFree: false,
      whisper: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'whisper-1' },
      silenceMs: 900,
    },
    avatar: { current: 'claire', list: [...BUILTIN_AVATARS], framing: 'bust', followPointer: true, arScale: 1 },
    vault: { applied: '', dismissed: '', locked: [] },
    memory: { enabled: true },
    profiles: {},
    gestures: { enabled: true, list: [...BUILTIN_ANIMATIONS] },
    ui: { subtitles: true, quality: 'medium', background: '#1b1d2e' },
  }
}

const STORAGE_KEY = 'companion.settings.v1'

/** Fusion profonde : les nouvelles clés par défaut apparaissent même avec d'anciens réglages sauvegardés. */
function merge<T>(base: T, saved: unknown): T {
  if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) {
    return (saved === undefined || typeof saved !== typeof base ? base : saved) as T
  }
  if (base === null || typeof base !== 'object' || Array.isArray(base)) return base
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(saved as Record<string, unknown>)) {
    out[k] = k in out ? merge(out[k], v) : v
  }
  return out as T
}

export function loadSettings(): Settings {
  const base = defaultSettings()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return base
    const s = merge(base, JSON.parse(raw))
    // L'avatar d'exemple reste toujours disponible et à jour.
    s.avatar.list = [...BUILTIN_AVATARS, ...s.avatar.list.filter((a) => !a.builtin)]
    s.gestures.list = [...BUILTIN_ANIMATIONS, ...s.gestures.list.filter((a) => !a.builtin)]
    // Clés enregistrées avec un espace ou un retour à la ligne collé par erreur.
    for (const p of Object.values(s.providers)) p.apiKey = p.apiKey.trim()
    s.tts.openai.apiKey = s.tts.openai.apiKey.trim()
    s.tts.elevenlabs.apiKey = s.tts.elevenlabs.apiKey.trim()
    s.stt.whisper.apiKey = s.stt.whisper.apiKey.trim()
    return s
  } catch {
    return base
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch {
    /* stockage plein ou bloqué : les réglages restent en mémoire */
  }
}

/**
 * Clé à utiliser pour un service (voix, écoute) : la sienne si elle est renseignée, sinon celle
 * d'un autre réglage qui vise le même serveur. Une clé OpenAI saisie dans ⚙ → IA sert ainsi
 * aussi à Whisper et aux voix OpenAI, sans avoir à la recopier.
 */
export function sharedKey(s: Settings, baseUrl: string, own: string): string {
  if (own) return own
  const host = hostOf(baseUrl)
  if (!host) return ''
  const candidates = [
    ...Object.values(s.providers).map((p) => [p.baseUrl, p.apiKey]),
    [s.tts.openai.baseUrl, s.tts.openai.apiKey],
    [s.stt.whisper.baseUrl, s.stt.whisper.apiKey],
  ]
  return candidates.find(([url, key]) => key && hostOf(url) === host)?.[1] ?? ''
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

export function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj)
}

export function setPath(obj: unknown, path: string, value: unknown): void {
  const keys = path.split('.')
  const last = keys.pop()!
  const target = keys.reduce<Record<string, unknown>>((o, k) => o[k] as Record<string, unknown>, obj as Record<string, unknown>)
  target[last] = value
}

/**
 * Version publiée sur un hébergement statique (GitHub Pages) : le relais local du serveur Vite
 * n'y existe pas. Défini au moment du build par la variable d'environnement VITE_HOSTED.
 */
export const HOSTED = Boolean(import.meta.env.VITE_HOSTED)

/** Préfixe une URL par le relais local si demandé (http(s)://hote/... -> /__proxy/https/hote/...). */
export function viaProxy(url: string, useProxy: boolean): string {
  if (!useProxy || HOSTED) return url
  const m = /^(https?):\/\/(.*)$/.exec(url)
  if (!m) return url
  return new URL(`__proxy/${m[1]}/${m[2]}`, document.baseURI).href
}

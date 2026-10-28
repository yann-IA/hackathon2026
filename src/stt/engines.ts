import { describeError } from '../llm/openai'
import { sharedKey, viaProxy, type Settings } from '../settings'
import { audioContext } from '../tts/audio'

export interface STTCallbacks {
  /** Transcription partielle (pendant que l'utilisateur parle). */
  onInterim(text: string): void
  /** Niveau du micro entre 0 et 1, pour l'animation du bouton. */
  onLevel?(level: number): void
}

export interface STTEngine {
  /** Écoute une phrase ; se termine sur un silence. Renvoie '' si rien n'a été dit. */
  listen(cb: STTCallbacks): Promise<string>
  /** Termine l'écoute maintenant (le texte déjà dit est conservé). */
  finish(): void
  /** Abandonne l'écoute. */
  cancel(): void
}

/* --------------------- Reconnaissance vocale du navigateur --------------------- */

type SpeechRecognitionCtor = new () => SpeechRecognitionLike
interface SpeechRecognitionLike {
  lang: string
  interimResults: boolean
  continuous: boolean
  maxAlternatives: number
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}

function recognitionCtor(): SpeechRecognitionCtor | undefined {
  const w = window as unknown as Record<string, SpeechRecognitionCtor | undefined>
  return w.SpeechRecognition ?? w.webkitSpeechRecognition
}

/**
 * Le navigateur du casque Meta Quest expose l'objet de reconnaissance vocale sans qu'il fonctionne :
 * on le considère comme absent (Whisper est alors utilisé).
 */
export const browserSTTAvailable = () => recognitionCtor() !== undefined && !/OculusBrowser|Quest/i.test(navigator.userAgent)

const NO_BROWSER_STT =
  'Ce navigateur ne sait pas reconnaître la voix. Ajoute une clé OpenAI dans ⚙ → IA (elle servira aussi à l’écoute), ou choisis « Whisper » dans ⚙ → Écoute avec une clé OpenAI ou Groq. Tu peux aussi écrire tes messages.'

/** Clé utilisée pour Whisper : la sienne, ou celle d'OpenAI (ou Groq…) saisie dans ⚙ → IA. */
export const whisperKey = (s: Settings) => sharedKey(s, s.stt.whisper.baseUrl, s.stt.whisper.apiKey)

/**
 * Moteur réellement utilisé : si la reconnaissance du navigateur n'existe pas (Firefox, certains
 * mobiles, casque Quest) et qu'une clé permet d'utiliser Whisper, on bascule automatiquement.
 */
export function sttEngineFor(s: Settings): 'browser' | 'whisper' | 'unavailable' {
  if (s.stt.engine === 'whisper') return 'whisper'
  if (browserSTTAvailable()) return 'browser'
  // serveur sur le même site (édition événement, adresse « /api ») : pas de clé nécessaire
  return whisperKey(s) || s.stt.whisper.baseUrl.startsWith('/') ? 'whisper' : 'unavailable'
}

export class BrowserSTT implements STTEngine {
  private rec: SpeechRecognitionLike | null = null

  constructor(private readonly s: Settings) {}

  listen(cb: STTCallbacks): Promise<string> {
    const Ctor = recognitionCtor()
    if (!Ctor) {
      return Promise.reject(
        new Error(NO_BROWSER_STT),
      )
    }
    return new Promise((resolve, reject) => {
      const rec = new Ctor()
      this.rec = rec
      rec.lang = this.s.persona.language
      rec.interimResults = true
      rec.continuous = false
      rec.maxAlternatives = 1
      let finalText = ''
      let interim = ''
      rec.onresult = (e) => {
        interim = ''
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i]
          if (r.isFinal) finalText += r[0].transcript
          else interim += r[0].transcript
        }
        cb.onInterim((finalText + interim).trim())
      }
      rec.onerror = (e) => {
        if (e.error === 'no-speech' || e.error === 'aborted') return
        this.rec = null
        reject(new Error(e.error === 'not-allowed' ? "Accès au micro refusé." : `Reconnaissance vocale : ${e.error}`))
      }
      rec.onend = () => {
        this.rec = null
        resolve((finalText || interim).trim())
      }
      rec.start()
    })
  }

  finish(): void {
    this.rec?.stop()
  }

  cancel(): void {
    if (!this.rec) return
    this.rec.onresult = null
    this.rec.abort()
  }
}

/* ------------- Whisper : enregistrement + API de transcription distante ------------- */

/**
 * Enregistre le micro, détecte la fin de phrase par le silence, puis envoie l'audio à une
 * API compatible OpenAI `/audio/transcriptions` (OpenAI, Groq, faster-whisper-server…).
 * Fonctionne partout, y compris sur Raspberry Pi / Chromium où la reconnaissance du navigateur est absente.
 */
export class WhisperSTT implements STTEngine {
  private stopNow: ((keep: boolean) => void) | null = null

  constructor(private readonly s: Settings) {}

  async listen(cb: STTCallbacks): Promise<string> {
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
    } catch {
      throw new Error("Accès au micro refusé (l'application doit être ouverte en HTTPS ou sur localhost).")
    }
    const blob = await this.record(stream, cb)
    stream.getTracks().forEach((t) => t.stop())
    if (!blob) return ''
    cb.onInterim('…')
    return this.transcribe(blob)
  }

  private record(stream: MediaStream, cb: STTCallbacks): Promise<Blob | null> {
    // Contexte audio partagé, déjà « déverrouillé » par un geste (bouton micro ou RA) : un contexte
    // créé ici, depuis un bouton de manette en RA, resterait suspendu et n'entendrait rien.
    const ctx = audioContext()
    void ctx.resume()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    const source = ctx.createMediaStreamSource(stream)
    source.connect(analyser)
    const data = new Float32Array(analyser.fftSize)

    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((m) => MediaRecorder.isTypeSupported(m))
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
    const chunks: Blob[] = []
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data)

    return new Promise((resolve, reject) => {
      let spoke = false
      let silent = false
      let keep = true
      let lastVoice = performance.now()
      const started = performance.now()
      let noiseFloor = 0.01
      let timer = 0

      const end = (k: boolean) => {
        keep = k
        clearInterval(timer)
        this.stopNow = null
        if (recorder.state !== 'inactive') recorder.stop()
      }
      this.stopNow = end

      recorder.onstop = () => {
        source.disconnect()
        cb.onLevel?.(0)
        if (silent) reject(new Error('Je n’ai rien entendu. Vérifie que le micro est autorisé pour ce site, puis parle juste après avoir appuyé.'))
        else resolve(keep && spoke && chunks.length ? new Blob(chunks, { type: recorder.mimeType }) : null)
      }

      const tick = () => {
        const now = performance.now()
        if (ctx.state !== 'running') {
          // Analyse du son impossible (contexte audio bloqué) : on enregistre quand même et on envoie
          // au second appui sur le bouton, ou au bout de 8 secondes.
          spoke = true
          cb.onLevel?.(0.3 + 0.2 * Math.sin(now / 150))
          if (now - started > 8000) end(true)
          return
        }
        analyser.getFloatTimeDomainData(data)
        let sum = 0
        for (const x of data) sum += x * x
        const rms = Math.sqrt(sum / data.length)
        // Le seuil s'adapte au bruit ambiant mesuré tant que personne ne parle.
        if (!spoke) noiseFloor = noiseFloor * 0.95 + rms * 0.05
        const threshold = Math.max(0.015, noiseFloor * 2.5)
        if (rms > threshold) {
          spoke ||= now - started > 150
          lastVoice = now
        }
        cb.onLevel?.(Math.min(1, rms * 12))
        if (spoke && now - lastVoice > this.s.stt.silenceMs) return end(true)
        if (!spoke && now - started > 10_000) {
          silent = true // personne n'a parlé
          return end(false)
        }
        if (now - started > 45_000) return end(true)
      }
      recorder.start(250)
      // Minuterie et non requestAnimationFrame : celui de la page est suspendu pendant une session
      // de réalité augmentée (casque Quest), la fin de phrase n'était alors jamais détectée.
      timer = window.setInterval(tick, 40)
    })
  }

  private async transcribe(blob: Blob): Promise<string> {
    const w = this.s.stt.whisper
    const ext = blob.type.includes('mp4') ? 'mp4' : blob.type.includes('ogg') ? 'ogg' : 'webm'
    const form = new FormData()
    form.append('file', blob, `audio.${ext}`)
    form.append('model', w.model)
    form.append('language', this.s.persona.language.slice(0, 2))
    form.append('response_format', 'json')
    const res = await fetch(viaProxy(w.baseUrl.replace(/\/+$/, '') + '/audio/transcriptions', this.s.useProxy), {
      method: 'POST',
      headers: whisperKey(this.s) ? { Authorization: `Bearer ${whisperKey(this.s)}` } : {},
      body: form,
    })
    if (!res.ok) throw new Error(await describeError(res))
    const json = (await res.json()) as { text?: string }
    return (json.text ?? '').trim()
  }

  finish(): void {
    this.stopNow?.(true)
  }

  cancel(): void {
    this.stopNow?.(false)
  }
}

export function createSTT(s: Settings): STTEngine {
  return sttEngineFor(s) === 'whisper' ? new WhisperSTT(s) : new BrowserSTT(s)
}

import type { Activity } from '../avatar/stage'
import type { MouthDriver } from '../avatar/lipsync'
import { createLLM, type ChatMessage } from '../llm'
import type { Settings } from '../settings'
import { createSTT, type STTEngine } from '../stt/engines'
import { createTTS } from '../tts/engines'
import { SpeechQueue } from '../tts/queue'
import { SentenceChunker } from './chunker'
import { EMOTION_INSTRUCTIONS, gestureInstructions, gestureMap, type Emotion, type Segment } from './emotion'
import type { MemoryManager } from './memory'

export interface ConversationEvents {
  onState(state: Activity): void
  onUserText(text: string, final: boolean): void
  onAssistantText(text: string): void
  onEmotion(e: Emotion): void
  /** L'IA a demandé un geste (identifiant d'animation). */
  onGesture(id: string): void
  onMouth(driver: MouthDriver | null): void
  /** Informations du serveur (édition événement) : file d'attente, sources de la réponse. */
  onMeta?(meta: Record<string, unknown>): void
  onMicLevel(level: number): void
  onError(message: string): void
}

const HISTORY_KEY = 'companion.history.v1'

/** Phrases que Whisper « entend » souvent dans le silence ou le bruit : on les ignore. */
const HALLUCINATIONS = /amara\.org|sous-titr|merci d'avoir regardé|thanks for watching|^\W*$/i

/**
 * Chef d'orchestre : micro -> texte -> IA (en flux) -> phrases -> voix + avatar,
 * avec interruption possible à tout moment.
 */
export class Conversation {
  private history: ChatMessage[] = []
  private state: Activity = 'idle'
  private abort: AbortController | null = null
  private stt: STTEngine | null = null
  private readonly queue: SpeechQueue
  private llmDone = true
  private spoken = ''
  private turn = 0

  constructor(
    private readonly settings: Settings,
    private readonly ev: ConversationEvents,
    private readonly memory?: MemoryManager,
  ) {
    // La conversation en cours survit à un rechargement de la page.
    try {
      const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]') as ChatMessage[]
      if (Array.isArray(saved)) this.history = saved.filter((m) => m && typeof m.content === 'string')
    } catch {
      /* historique illisible */
    }
    this.queue = new SpeechQueue(createTTS(settings), {
      onSegmentStart: (seg) => {
        this.spoken += (this.spoken ? ' ' : '') + seg.text
        this.ev.onEmotion(seg.emotion)
        if (seg.gesture) this.ev.onGesture(seg.gesture)
        this.ev.onAssistantText(this.spoken)
      },
      onMouth: (d) => this.ev.onMouth(d),
      onError: (e) => this.ev.onError(`Voix : ${(e as Error).message ?? e}`),
      onDrain: () => this.maybeFinishTurn(),
    })
  }

  get current(): Activity {
    return this.state
  }

  /** À appeler quand les réglages de voix changent. */
  reloadVoice(): void {
    this.queue.setEngine(createTTS(this.settings))
  }

  clearHistory(): void {
    this.interrupt()
    this.history = []
    this.saveHistory()
  }

  /** Dernier échange enregistré (pour réafficher les sous-titres après un rechargement). */
  get lastExchange(): { user: string; assistant: string } | null {
    const h = this.history
    const a = h[h.length - 1]
    const u = h[h.length - 2]
    return a?.role === 'assistant' && u?.role === 'user' ? { user: u.content, assistant: a.content } : null
  }

  private saveHistory(): void {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(this.history))
    } catch {
      /* stockage plein ou bloqué */
    }
  }

  private setState(s: Activity): void {
    this.state = s
    this.ev.onState(s)
  }

  /** Bouton micro : écoute, ou termine l'écoute, ou coupe la parole de l'avatar. */
  async toggleListening(): Promise<void> {
    if (this.state === 'listening') {
      this.stt?.finish()
      return
    }
    this.interrupt()
    await this.listen()
  }

  private async listen(): Promise<void> {
    const stt = createSTT(this.settings)
    this.stt = stt
    this.memory?.postpone() // l'utilisateur parle : on attend la fin de la conversation pour mémoriser
    this.setState('listening')
    try {
      const text = await stt.listen({
        onInterim: (t) => this.ev.onUserText(t, false),
        onLevel: (l) => this.ev.onMicLevel(l),
      })
      if (this.stt !== stt) return // annulé entre-temps
      this.stt = null
      if (!text || HALLUCINATIONS.test(text)) {
        this.ev.onUserText('', true)
        this.setState('idle')
        return
      }
      await this.send(text)
    } catch (err) {
      if (this.stt === stt) this.stt = null
      this.setState('idle')
      this.ev.onError((err as Error).message)
    }
  }

  /** Envoie un message (tapé ou dicté) et fait répondre l'avatar. */
  async send(text: string): Promise<void> {
    text = text.trim()
    if (!text) return
    this.interrupt()
    const turn = ++this.turn
    this.ev.onUserText(text, true)
    this.ev.onAssistantText('')
    this.history.push({ role: 'user', content: text })
    this.trimHistory()
    this.memory?.postpone()
    this.setState('thinking')

    this.abort = new AbortController()
    this.llmDone = false
    this.spoken = ''
    const gestures = this.settings.gestures.enabled ? gestureMap(this.settings.gestures.list) : undefined
    const chunker = new SentenceChunker((seg: Segment) => {
      if (turn !== this.turn) return
      if (!seg.text) {
        // Geste sans paroles : on le joue tout de suite.
        if (seg.gesture) this.ev.onGesture(seg.gesture)
        return
      }
      if (this.state === 'thinking') this.setState('speaking')
      this.queue.push(seg)
    }, gestures)

    try {
      const llm = createLLM(this.settings)
      const reply = await llm.streamChat({
        system: this.systemPrompt(text),
        messages: this.history,
        signal: this.abort.signal,
        onText: (d) => chunker.push(d),
        onMeta: (m) => turn === this.turn && this.ev.onMeta?.(m),
      })
      if (turn !== this.turn) return
      chunker.flush()
      this.history.push({ role: 'assistant', content: reply })
      this.saveHistory()
      this.memory?.observe([
        { role: 'user', content: text },
        { role: 'assistant', content: reply },
      ])
    } catch (err) {
      if (turn !== this.turn || (err as Error).name === 'AbortError' || this.abort?.signal.aborted) return
      this.history.pop() // la question sans réponse ne doit pas rester dans l'historique
      this.ev.onError((err as Error).message)
    } finally {
      if (turn === this.turn) {
        this.llmDone = true
        this.abort = null
        this.maybeFinishTurn()
      }
    }
  }

  /** Coupe tout : l'IA qui écrit, la voix qui parle, le micro qui écoute. */
  interrupt(): void {
    this.turn++
    this.abort?.abort()
    this.abort = null
    this.llmDone = true
    if (this.stt) {
      const stt = this.stt
      this.stt = null
      stt.cancel()
    }
    if (this.queue.busy) {
      // Garder dans l'historique ce qui a vraiment été dit avant l'interruption.
      const last = this.history[this.history.length - 1]
      if (this.spoken && last?.role === 'user') {
        this.history.push({ role: 'assistant', content: this.spoken + '…' })
        this.saveHistory()
        this.memory?.observe([last, { role: 'assistant', content: this.spoken + '…' }])
      }
    }
    this.queue.stop()
    this.ev.onMouth(null)
    if (this.state !== 'idle') this.setState('idle')
  }

  private maybeFinishTurn(): void {
    if (!this.llmDone || this.queue.busy || this.state === 'listening' || this.state === 'idle') return
    this.setState('idle')
    if (this.settings.stt.handsFree) void this.listen()
  }

  private trimHistory(): void {
    const max = Math.max(2, this.settings.historyLength)
    while (this.history.length > max) this.history.shift()
    while (this.history.length && this.history[0].role !== 'user') this.history.shift()
  }

  private systemPrompt(query: string): string {
    const p = this.settings.persona
    const lang = new Intl.DisplayNames(['fr'], { type: 'language' }).of(p.language.slice(0, 2)) ?? p.language
    const gestures = this.settings.gestures.enabled ? gestureInstructions(this.settings.gestures.list) : ''
    const memories = this.memory?.promptFor(query) ?? ''
    return `${p.prompt.trim()}\n\nTon nom est ${p.name}. Réponds en ${lang}.${memories ? '\n\n' + memories : ''}\n\n${EMOTION_INSTRUCTIONS}${gestures ? '\n' + gestures : ''}`
  }
}

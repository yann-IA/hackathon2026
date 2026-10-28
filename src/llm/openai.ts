import { readSSE } from './sse'
import { LLMError, type ChatRequest, type LLMClient } from './types'

export interface OpenAICompatibleOptions {
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  maxTokens: number
}

/** Client pour toute API compatible « OpenAI chat/completions » (OpenAI, Groq, Mistral, Ollama…). */
export class OpenAICompatibleClient implements LLMClient {
  constructor(private readonly opts: OpenAICompatibleOptions) {}

  private headers(): HeadersInit {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.opts.apiKey) h.Authorization = `Bearer ${this.opts.apiKey}`
    return h
  }

  private url(path: string): string {
    return this.opts.baseUrl.replace(/\/+$/, '') + path
  }

  async streamChat({ system, messages, signal, onText, onMeta }: ChatRequest): Promise<string> {
    if (!this.opts.model) throw new LLMError('Aucun modèle choisi dans les réglages.')
    const key = `${this.opts.baseUrl}|${this.opts.model}`
    const quirks = QUIRKS.get(key) ?? initialQuirks(this.opts.baseUrl, this.opts.model)
    // Les paramètres acceptés varient selon les modèles : si le fournisseur en refuse un, on
    // adapte la requête et on réessaie (et on s'en souvient pour les suivantes).
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(this.url('/chat/completions'), {
        method: 'POST',
        headers: this.headers(),
        signal,
        body: JSON.stringify(this.body(system, messages, quirks)),
      })
      if (res.ok && res.body) {
        QUIRKS.set(key, quirks)
        return quirks.noStream ? this.readFull(res, onText) : this.readStream(res.body, onText, onMeta)
      }
      const error = await describeError(res)
      if (res.status !== 400 || attempt >= 4 || !adapt(quirks, error)) throw new LLMError(error)
    }
  }

  private body(system: string, messages: ChatRequest['messages'], q: Quirks): Record<string, unknown> {
    return {
      model: this.opts.model,
      ...(q.noStream ? {} : { stream: true }),
      ...(q.noTemperature ? {} : { temperature: this.opts.temperature }),
      // Les modèles « qui réfléchissent » comptent leur réflexion dans la limite : on leur laisse de la marge.
      ...(q.completionTokens ? { max_completion_tokens: this.opts.maxTokens + (q.reasoning ? 4000 : 0) } : { max_tokens: this.opts.maxTokens }),
      // Réflexion courte : pour une conversation orale, la rapidité de réponse compte plus.
      ...(q.reasoning && !q.noReasoningEffort ? { reasoning_effort: 'low' } : {}),
      messages: [{ role: 'system', content: system }, ...messages],
    }
  }

  private async readStream(body: ReadableStream<Uint8Array>, onText: (t: string) => void, onMeta?: ChatRequest['onMeta']): Promise<string> {
    let full = ''
    for await (const data of readSSE(body)) {
      if (data === '[DONE]') break
      let json: { choices?: { delta?: { content?: string } }[]; error?: { message?: string }; edition?: Record<string, unknown> }
      try {
        json = JSON.parse(data)
      } catch {
        continue
      }
      if (json.error) throw new LLMError(json.error.message ?? 'Erreur du fournisseur')
      if (json.edition) onMeta?.(json.edition)
      const delta = json.choices?.[0]?.delta?.content
      if (delta) {
        full += delta
        onText(delta)
      }
    }
    return full
  }

  /** Réponse d'un bloc (fournisseur ou modèle qui refuse le streaming). */
  private async readFull(res: Response, onText: (t: string) => void): Promise<string> {
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    const text = json.choices?.[0]?.message?.content ?? ''
    if (text) onText(text)
    return text
  }

  async listModels(): Promise<string[]> {
    const res = await fetch(this.url('/models'), { headers: this.headers() })
    if (!res.ok) throw new LLMError(await describeError(res))
    const json = (await res.json()) as { data?: { id: string }[]; models?: { name: string }[] }
    const ids = json.data?.map((m) => m.id) ?? json.models?.map((m) => m.name) ?? []
    return ids.sort()
  }
}

/* ------------------- Paramètres acceptés selon le modèle ------------------- */

export interface Quirks {
  /** `max_completion_tokens` au lieu de `max_tokens` (modèles récents d'OpenAI). */
  completionTokens: boolean
  /** Modèle qui « réfléchit » (o1, o3, o4, gpt-5…) : température imposée, réflexion à doser. */
  reasoning: boolean
  noTemperature: boolean
  noReasoningEffort: boolean
  noStream: boolean
}

const QUIRKS = new Map<string, Quirks>()

export function initialQuirks(baseUrl: string, model: string): Quirks {
  const openai = /(^|\.)openai\.com/.test(hostOf(baseUrl))
  const reasoning = openai && /^(o\d|gpt-5)/i.test(model.replace(/^openai\//, ''))
  return { completionTokens: openai, reasoning, noTemperature: reasoning, noReasoningEffort: false, noStream: false }
}

/** Adapte la requête d'après le message d'erreur du fournisseur. Renvoie false si rien à changer. */
export function adapt(q: Quirks, error: string): boolean {
  const e = error.toLowerCase()
  if (e.includes('max_tokens') && !q.completionTokens) return (q.completionTokens = true)
  if (e.includes('max_completion_tokens') && q.completionTokens) return !(q.completionTokens = false)
  if (e.includes('temperature') && !q.noTemperature) return (q.noTemperature = true)
  if (e.includes('reasoning_effort') && q.reasoning && !q.noReasoningEffort) return (q.noReasoningEffort = true)
  if (e.includes('stream') && !q.noStream) return (q.noStream = true)
  return false
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

export async function describeError(res: Response): Promise<string> {
  let detail = ''
  try {
    const text = await res.text()
    try {
      const j = JSON.parse(text)
      detail = j.error?.message ?? j.message ?? j.detail?.message ?? j.detail ?? text
    } catch {
      detail = text
    }
  } catch {
    /* corps illisible */
  }
  const hint =
    res.status === 401 || res.status === 403
      ? ' (clé API invalide ou manquante ?)'
      : res.status === 404
        ? ' (URL ou nom de modèle incorrect ?)'
        : res.status === 429
          ? ' (quota ou limite de débit atteint)'
          : ''
  return `Erreur ${res.status}${hint} : ${String(detail).slice(0, 300)}`
}

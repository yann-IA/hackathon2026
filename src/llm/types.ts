export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatRequest {
  system: string
  messages: ChatMessage[]
  signal: AbortSignal
  onText: (delta: string) => void
  /** Informations du serveur de l'édition : position dans la file d'attente, sources. */
  onMeta?: (meta: Record<string, unknown>) => void
}

export interface LLMClient {
  /** Envoie la conversation, diffuse le texte au fil de l'eau et renvoie la réponse complète. */
  streamChat(req: ChatRequest): Promise<string>
  listModels(): Promise<string[]>
}

export class LLMError extends Error {}

// Modèle de langue local : Ollama (API native) ou tout serveur compatible OpenAI (LM Studio,
// llama.cpp, MLX…). Les réponses arrivent mot à mot (flux).

async function* lines(body) {
  const decoder = new TextDecoder()
  let buf = ''
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true })
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (line) yield line
    }
  }
  if (buf.trim()) yield buf.trim()
}

/** Génère la réponse morceau par morceau. */
export async function* streamChat(cfg, messages, signal) {
  const base = cfg.url.replace(/\/+$/, '')
  if (cfg.api === 'openai') {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({ model: cfg.model, messages, stream: true, temperature: cfg.temperature, max_tokens: cfg.maxTokens }),
    })
    if (!res.ok) throw new Error(`Modèle : erreur ${res.status} ${await res.text()}`)
    for await (const line of lines(res.body)) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') return
      const delta = JSON.parse(data).choices?.[0]?.delta?.content
      if (delta) yield delta
    }
    return
  }
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model: cfg.model,
      messages,
      stream: true,
      keep_alive: '24h', // le modèle reste chargé : pas d'attente au premier message
      ...(cfg.think === undefined ? {} : { think: cfg.think }),
      options: { temperature: cfg.temperature, num_predict: cfg.maxTokens, num_ctx: cfg.contextTokens },
    }),
  })
  if (!res.ok) throw new Error(`Modèle : erreur ${res.status} ${await res.text()}`)
  for await (const line of lines(res.body)) {
    const json = JSON.parse(line)
    if (json.error) throw new Error(json.error)
    if (json.message?.content) yield json.message.content
    if (json.done) return
  }
}

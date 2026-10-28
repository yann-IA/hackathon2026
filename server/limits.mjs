// Protection du Mac : nombre de réponses générées en même temps, file d'attente, et nombre de
// questions par minute pour chaque appareil.

/** File d'attente : au plus `concurrent` tâches en cours, `maxQueue` en attente. */
export class Gate {
  constructor(concurrent = 2, maxQueue = 30) {
    Object.assign(this, { concurrent, maxQueue })
    this.running = 0
    this.waiting = [] // { resolve, onPosition }
  }

  /**
   * Attend son tour. onPosition(n) est appelé avec le nombre de personnes devant soi.
   * Renvoie une fonction à appeler une fois terminé, ou null si la file est pleine.
   */
  async acquire(onPosition = () => {}, signal) {
    if (this.running < this.concurrent && !this.waiting.length) {
      this.running++
      return this.releaser()
    }
    if (this.waiting.length >= this.maxQueue) return null
    return new Promise((resolve) => {
      const entry = { resolve, onPosition }
      this.waiting.push(entry)
      onPosition(this.waiting.length)
      signal?.addEventListener('abort', () => {
        const i = this.waiting.indexOf(entry)
        if (i >= 0) {
          this.waiting.splice(i, 1)
          this.notify()
          resolve(null)
        }
      })
    })
  }

  releaser() {
    let done = false
    return () => {
      if (done) return
      done = true
      this.running--
      const next = this.waiting.shift()
      if (next) {
        this.running++
        next.resolve(this.releaser())
      }
      this.notify()
    }
  }

  notify() {
    this.waiting.forEach((w, i) => w.onPosition(i + 1))
  }
}

/** Limite de débit : `max` demandes par fenêtre de `windowMs` et par clé (adresse de l'appareil). */
export class RateLimiter {
  constructor(max = 10, windowMs = 60_000) {
    Object.assign(this, { max, windowMs })
    this.hits = new Map()
  }

  allow(key, now = Date.now()) {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs)
    if (list.length >= this.max) {
      this.hits.set(key, list)
      return false
    }
    list.push(now)
    this.hits.set(key, list)
    if (this.hits.size > 10_000) this.prune(now)
    return true
  }

  prune(now = Date.now()) {
    for (const [k, list] of this.hits) if (!list.some((t) => now - t < this.windowMs)) this.hits.delete(k)
  }
}

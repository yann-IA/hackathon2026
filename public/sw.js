// Service worker minimal : rend l'application installable et utilisable hors-ligne
// (l'interface et les avatars déjà chargés sont mis en cache ; les appels aux API d'IA ne le sont jamais).
// À changer quand un avatar fourni est modifié : sinon l'ancienne version reste en cache sur les appareils.
const CACHE = 'hackathon2026-v1'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  const sameOrigin = url.origin === self.location.origin
  const isAvatar = url.pathname.endsWith('.vrm')
  // Le coffre à clés doit toujours être lu sur le réseau pour qu'une nouvelle version soit vue.
  if (url.pathname.includes('/__proxy/') || url.pathname.endsWith('/vault.json') || (!sameOrigin && !isAvatar)) return

  if (req.mode === 'navigate') {
    // Page : réseau d'abord pour profiter des mises à jour, cache si hors-ligne.
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put(req, copy))
          return res
        })
        .catch(() => caches.match(req)),
    )
    return
  }

  // Fichiers statiques et avatars : cache d'abord.
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ??
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone()
            caches.open(CACHE).then((c) => c.put(req, copy))
          }
          return res
        }),
    ),
  )
})

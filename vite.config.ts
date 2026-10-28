import { defineConfig, type Plugin, type Connect } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { Readable } from 'node:stream'

/**
 * Relais local optionnel : /__proxy/https/api.exemple.com/v1/... -> https://api.exemple.com/v1/...
 * Sert à contourner les fournisseurs qui refusent les appels directs depuis un navigateur (CORS).
 * Il n'existe que dans `vite dev` / `vite preview` : ce n'est pas un serveur de production.
 */
const PREFIX = '/__proxy/'
const HOP_BY_HOP = new Set(['host', 'origin', 'referer', 'connection', 'content-length', 'accept-encoding'])

function proxyMiddleware(): Connect.NextHandleFunction {
  return async (req, res, next) => {
    if (!req.url?.startsWith(PREFIX)) return next()
    const rest = req.url.slice(PREFIX.length)
    const slash = rest.indexOf('/')
    const scheme = rest.slice(0, slash)
    if (slash < 0 || (scheme !== 'https' && scheme !== 'http')) {
      res.statusCode = 400
      return res.end('URL de proxy invalide')
    }
    const target = `${scheme}://${rest.slice(slash + 1)}`

    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k) || k.startsWith('sec-')) continue
      headers.set(k, Array.isArray(v) ? v.join(', ') : v)
    }
    try {
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
        // @ts-expect-error option Node nécessaire pour un corps en flux
        duplex: 'half',
      })
      res.statusCode = upstream.status
      upstream.headers.forEach((v, k) => {
        if (k !== 'content-encoding' && k !== 'content-length' && k !== 'transfer-encoding') res.setHeader(k, v)
      })
      if (!upstream.body) return res.end()
      Readable.fromWeb(upstream.body as never).pipe(res)
    } catch (err) {
      res.statusCode = 502
      res.end(`Proxy : ${(err as Error).message}`)
    }
  }
}

function localProxy(): Plugin {
  return {
    name: 'companion-local-proxy',
    configureServer: (server) => void server.middlewares.use(proxyMiddleware()),
    configurePreviewServer: (server) => void server.middlewares.use(proxyMiddleware()),
  }
}

/** Empreinte du fichier de l'avatar : son adresse change à chaque nouvelle version, ce qui contourne
 * toutes les mémoires (navigateur, cache hors-ligne) qui garderaient l'ancienne. */
const avatarFile = 'public/avatars/claire.vrm'
const avatarVersion = existsSync(avatarFile) ? createHash('sha1').update(readFileSync(avatarFile)).digest('hex').slice(0, 10) : 'dev'

export default defineConfig({
  base: './',
  define: { __AVATAR_VERSION__: JSON.stringify(avatarVersion) },
  plugins: [localProxy(), ...(process.env.HTTPS ? [basicSsl()] : [])],
  build: { chunkSizeWarningLimit: 1500 },
  // en développement, les questions vont au serveur de l'assistante (npm run server)
  server: { proxy: { '/api': 'http://127.0.0.1:8090', '/docs': 'http://127.0.0.1:8090' } },
})

// Envoi d'un e-mail texte par SMTP (Gmail, Orange, OVH…), sans dépendance.
// security : « ssl » (port 465), « starttls » (port 587) ou « aucune » (tests uniquement).
import net from 'node:net'
import tls from 'node:tls'

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`)

/** Lit les réponses du serveur SMTP (réponses sur plusieurs lignes : « 250-… » puis « 250 … »). */
function reader(socket) {
  let buf = ''
  let waiting = null
  const lines = []
  const pump = () => {
    if (!waiting) return
    const end = lines.findIndex((l) => /^\d{3} /.test(l))
    if (end >= 0) {
      const reply = lines.splice(0, end + 1)
      const w = waiting
      waiting = null
      w.resolve({ code: Number(reply.at(-1).slice(0, 3)), text: reply.join('\n') })
    }
  }
  const onData = (d) => {
    buf += d.toString('utf8')
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      lines.push(buf.slice(0, i).replace(/\r$/, ''))
      buf = buf.slice(i + 1)
    }
    pump()
  }
  const onError = (e) => waiting && (waiting.reject(e), (waiting = null))
  socket.on('data', onData)
  socket.on('error', onError)
  return {
    next: () => new Promise((resolve, reject) => ((waiting = { resolve, reject }), pump())),
    detach: () => (socket.off('data', onData), socket.off('error', onError)),
  }
}

export async function sendMail({ host, port, security = 'ssl', user, pass, from, fromName = 'Assistante', to, subject, text, timeout = 30_000 }) {
  const recipients = (Array.isArray(to) ? to : String(to).split(',')).map((s) => s.trim()).filter(Boolean)
  if (!host || !recipients.length) throw new Error('adresse du serveur SMTP ou destinataire manquant')
  let socket = await new Promise((resolve, reject) => {
    const s = security === 'ssl' ? tls.connect({ host, port, servername: host }, () => resolve(s)) : net.connect({ host, port }, () => resolve(s))
    s.once('error', reject)
  })
  socket.setTimeout(timeout, () => socket.destroy(new Error('le serveur SMTP ne répond pas')))
  let r = reader(socket)
  const expect = async (codes, what) => {
    const reply = await r.next()
    if (!codes.includes(reply.code)) throw new Error(`${what} refusé par le serveur SMTP : ${reply.text}`)
    return reply
  }
  const cmd = async (line, codes, what) => (socket.write(line + '\r\n'), expect(codes, what))
  try {
    await expect([220], 'connexion')
    let ehlo = await cmd('EHLO assistante.local', [250], 'EHLO')
    if (security === 'starttls') {
      await cmd('STARTTLS', [220], 'STARTTLS')
      r.detach()
      socket = await new Promise((resolve, reject) => {
        const s = tls.connect({ socket, servername: host }, () => resolve(s))
        s.once('error', reject)
      })
      r = reader(socket)
      ehlo = await cmd('EHLO assistante.local', [250], 'EHLO')
    }
    if (user) {
      if (/AUTH[ =][^\n]*PLAIN/i.test(ehlo.text)) await cmd(`AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`).toString('base64')}`, [235], 'identifiant ou mot de passe')
      else {
        await cmd('AUTH LOGIN', [334], 'AUTH LOGIN')
        await cmd(b64(user), [334], 'identifiant')
        await cmd(b64(pass ?? ''), [235], 'identifiant ou mot de passe')
      }
    }
    const sender = from || user
    await cmd(`MAIL FROM:<${sender}>`, [250], 'expéditeur')
    for (const rcpt of recipients) await cmd(`RCPT TO:<${rcpt}>`, [250, 251], `destinataire ${rcpt}`)
    await cmd('DATA', [354], 'DATA')
    const body = b64(text).replace(/.{1,76}/g, '$&\r\n')
    const message = [
      `From: ${encodeHeader(fromName)} <${sender}>`,
      `To: ${recipients.join(', ')}`,
      `Subject: ${encodeHeader(subject)}`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      body,
    ].join('\r\n')
    await cmd(`${message}\r\n.`, [250], 'message')
    await cmd('QUIT', [221, 250], 'QUIT').catch(() => {})
  } finally {
    socket.destroy()
  }
}

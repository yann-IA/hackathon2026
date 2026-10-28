import './styles.css'
import { AvatarStage } from './avatar/stage'
import { Conversation } from './core/conversation'
import { parseSegment, slugify } from './core/emotion'
import { MemoryManager } from './core/memory'
import { sttEngineFor } from './stt/engines'
import { ARSession } from './xr/ar'
import { VaultDialog } from './ui/vaultDialog'
import { WrongPassphraseError, availableVault, forgetVaultKeys, loadedVaultKeys, parseVault, releaseKey, unlockVault, type VaultFile } from './vault'
import { DEFAULT_PROFILES, applyProfile, resetProfile, switchProfile } from './profiles'
import { createLLM } from './llm'
import { PROVIDERS, loadSettings, saveSettings, type AnimationEntry, type AvatarEntry } from './settings'
import { deleteAvatarFile, loadAvatarFile, saveAvatarFile } from './storage'
import { unlockAudio } from './tts/audio'
import { createTTS, listElevenLabsVoices } from './tts/engines'
import { SettingsPanel } from './ui/panel'
import { EDITION, applyEdition } from './edition'

const settings = loadSettings()
applyEdition(settings) // édition événement : l'assistante et le serveur du Mac, rien à régler
// Première version avec un personnage par avatar : si Léo, Bip ou Dino était déjà choisi
// avec le personnage par défaut (Aiko), il reçoit le sien.
{
  const own = DEFAULT_PROFILES[settings.avatar.current]
  if (own && !Object.keys(settings.profiles).length && settings.avatar.current !== 'sample' && settings.persona.name === DEFAULT_PROFILES.sample.name) {
    applyProfile(settings, own)
    saveSettings(settings)
  }
}
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

const stage = new AvatarStage($<HTMLCanvasElement>('stage'))
if (new URLSearchParams(location.search).has('debug')) Object.assign(window, { stage, getAR: () => ar })
const statusEl = $('status')
const userLine = $('user-line')
const aiLine = $('ai-line')
const toastEl = $('toast')
const micBtn = $('mic-btn')

/* ------------------------------ Messages ------------------------------ */

let toastTimer = 0
function toast(message: string, kind: 'error' | 'info' = 'error', ms = 7000): void {
  toastEl.textContent = message
  toastEl.className = `toast ${kind === 'info' ? 'info' : ''}`
  toastEl.hidden = false
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (toastEl.hidden = true), ms)
}
toastEl.addEventListener('click', () => (toastEl.hidden = true))

const STATE_LABELS = { idle: 'En attente', listening: 'J’écoute…', thinking: 'Réfléchit…', speaking: 'Parle' }

/* ----------------- Édition événement : réflexion et sources ----------------- */

const thinkingEl = $('thinking')
const sourcesEl = $('sources')
interface Source {
  title: string
  url?: string
  page?: number
}

/** Animation d'attente : l'assistante cherche, ou des personnes passent avant (file d'attente du Mac). */
function showThinking(queue: number): void {
  $('thinking-text').textContent =
    queue > 0 ? `Beaucoup de questions en ce moment : ${queue} ${queue > 1 ? 'personnes' : 'personne'} avant vous…` : EDITION.thinking
}

/** Documents dont vient la réponse, à ouvrir d'un geste. */
function showSources(list: Source[]): void {
  sourcesEl.replaceChildren()
  sourcesEl.hidden = !list.length
  if (!list.length) return
  const label = document.createElement('span')
  label.textContent = list.length > 1 ? 'Sources :' : 'Source :'
  sourcesEl.append(label)
  for (const s of list) {
    // sans lien quand le serveur ne permet pas de télécharger les documents (DOCS_DOWNLOAD)
    const a = document.createElement(s.url ? 'a' : 'span')
    if (a instanceof HTMLAnchorElement && s.url) {
      a.href = s.url
      a.target = '_blank'
      a.rel = 'noopener'
    }
    a.className = 'source'
    a.textContent = s.page ? `${s.title} (p. ${s.page})` : s.title
    sourcesEl.append(a)
  }
}

/* ---------------------------- Conversation ---------------------------- */

/** Session de réalité augmentée (créée seulement si l'appareil la prend en charge). */
let ar: ARSession | null = null

const memory = new MemoryManager(settings)
memory.onChange((added) => {
  if (added.length) {
    const more = added.length > 1 ? ` (+${added.length - 1})` : ''
    toast(`💭 ${settings.persona.name} retient : « ${added[0].text} »${more}`, 'info', 4000)
  }
  panel.refresh('memoire')
})

const convo = new Conversation(settings, {
  onState: (s) => {
    if (s === 'thinking') showThinking(0)
    thinkingEl.hidden = s !== 'thinking'
    statusEl.dataset.state = s
    statusEl.textContent = STATE_LABELS[s]
    document.body.dataset.state = s
    stage.setActivity(s)
    micBtn.setAttribute('aria-label', s === 'listening' ? 'Terminer' : s === 'idle' ? 'Parler' : 'Interrompre')
    ar?.setState(s)
  },
  onMeta: (m) => {
    if (typeof m.queue === 'number') showThinking(m.queue)
    if (Array.isArray(m.sources)) showSources(m.sources as Source[])
  },
  onUserText: (text, final) => {
    if (final && text) {
      $('welcome').hidden = true
      showSources([])
    }
    userLine.textContent = text
    userLine.classList.toggle('interim', !final)
    ar?.setUserText(text)
  },
  onAssistantText: (text) => {
    aiLine.textContent = text
    aiLine.scrollTop = aiLine.scrollHeight
    ar?.setAssistantText(text)
  },
  onEmotion: (e) => stage.setEmotion(e),
  onGesture: (id) => void playGesture(id),
  onMouth: (d) => stage.setMouth(d),
  onMicLevel: (l) => {
    micBtn.style.setProperty('--level', String(l))
    ar?.setLevel(l) // en RA, le bouton micro du panneau grossit avec la voix : on voit que le micro entend
  },
  onError: (m) => {
    // voix du serveur indisponible : la voix du téléphone prend le relais pour cette visite
    if (settings.tts.engine === 'openai' && /voix|audio\/speech|Kokoro/i.test(m)) {
      settings.tts.engine = 'browser'
      convo.reloadVoice()
      toast(`La voix de ${EDITION.name} est indisponible : celle de votre téléphone prend le relais.`, 'info', 5000)
      return
    }
    toast(m)
    if (ar?.active) ar.showNotice(m) // les messages à l'écran ne sont pas visibles dans le casque
  },
}, memory)

function needsSetup(): boolean {
  const preset = PROVIDERS[settings.activeProvider]
  return preset.needsKey && !settings.providers[settings.activeProvider].apiKey
}

async function talk(): Promise<void> {
  await unlockAudio()
  if (needsSetup()) {
    panel.open('ia')
    toast('Choisis un fournisseur d’IA et colle ta clé API pour commencer.', 'info')
    return
  }
  await convo.toggleListening()
}

micBtn.addEventListener('click', () => void talk())

$('text-form').addEventListener('submit', (e) => {
  e.preventDefault()
  const input = $<HTMLInputElement>('text-input')
  const text = input.value
  input.value = ''
  void unlockAudio()
  if (needsSetup()) {
    panel.open('ia')
    toast('Choisis un fournisseur d’IA et colle ta clé API pour commencer.', 'info')
    return
  }
  void convo.send(text)
})

window.addEventListener('keydown', (e) => {
  const typing = (e.target as HTMLElement).closest('input, textarea, select')
  if (e.code === 'Space' && !typing && !e.repeat) {
    e.preventDefault()
    void talk()
  } else if (e.code === 'Escape') {
    if (panel.isOpen) panel.close()
    else if (!gestureMenu.hidden) gestureMenu.hidden = true
    else {
      convo.interrupt()
      stage.stopGesture()
    }
  }
})

$('settings-btn').addEventListener('click', () => panel.toggle())

/* ------------------------------- Gestes ------------------------------- */

const gestureMenu = $('gesture-menu')
const animationUrls = new Map<string, string>()

async function resolveAnimationUrl(a: AnimationEntry): Promise<string> {
  if (!a.url.startsWith('idb:')) return a.url
  let url = animationUrls.get(a.id)
  if (!url) {
    const blob = await loadAvatarFile(a.url.slice(4))
    if (!blob) throw new Error('Fichier d\u2019animation introuvable dans le stockage du navigateur.')
    url = URL.createObjectURL(blob)
    animationUrls.set(a.id, url)
  }
  return url
}

async function playGesture(id: string): Promise<void> {
  const entry = settings.gestures.list.find((a) => a.id === id)
  if (!entry || !stage.loaded) return
  try {
    await stage.playGesture(await resolveAnimationUrl(entry), entry.repeat, entry.fullBody)
  } catch (e) {
    toast(`Animation « ${entry.name} » : ${(e as Error).message}`)
  }
}

function renderGestureMenu(): void {
  gestureMenu.innerHTML =
    settings.gestures.list
      .map((a) => `<button data-gesture="${a.id}">${a.name.replace(/[<>&]/g, '')}</button>`)
      .join('') + '<button data-gesture="" class="stop">■ Arrêter</button>'
}

$('gesture-btn').addEventListener('click', () => {
  renderGestureMenu()
  gestureMenu.hidden = !gestureMenu.hidden
})
gestureMenu.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-gesture]')
  if (!btn) return
  gestureMenu.hidden = true
  if (btn.dataset.gesture) void playGesture(btn.dataset.gesture)
  else stage.stopGesture()
})
document.addEventListener('pointerdown', (e) => {
  if (!(e.target as HTMLElement).closest('#gesture-menu, #gesture-btn')) gestureMenu.hidden = true
})

/* ------------------------------- Avatars ------------------------------- */

let objectUrl: string | null = null

async function resolveAvatarUrl(a: AvatarEntry): Promise<string> {
  if (a.url.startsWith('idb:')) {
    const blob = await loadAvatarFile(a.url.slice(4))
    if (!blob) throw new Error('Fichier d’avatar introuvable dans le stockage du navigateur.')
    if (objectUrl) URL.revokeObjectURL(objectUrl)
    objectUrl = URL.createObjectURL(blob)
    return objectUrl
  }
  if (a.localUrl) {
    // Copie locale (npm run fetch-avatar) : utile hors-ligne et plus rapide.
    try {
      const res = await fetch(a.localUrl, { method: 'HEAD' })
      if (res.ok && !res.headers.get('content-type')?.includes('text/html')) return a.localUrl
    } catch {
      /* pas de copie locale */
    }
  }
  return a.url
}

async function loadAvatar(id: string): Promise<void> {
  const entry = settings.avatar.list.find((a) => a.id === id) ?? settings.avatar.list[0]
  const loader = $('loader')
  const loaderText = $('loader-text')
  loader.hidden = false
  loaderText.textContent = `Chargement de « ${entry.name} »…`
  try {
    const url = await resolveAvatarUrl(entry)
    await stage.load(url, (r) => (loaderText.textContent = `Chargement de « ${entry.name} »… ${Math.round(r * 100)} %`))
    // Chaque avatar a son personnage : on mémorise celui de l'avatar quitté et on charge le sien.
    const changed = switchProfile(settings, settings.avatar.current, entry.id)
    settings.avatar.current = entry.id
    saveSettings(settings)
    if (changed) {
      personaChanged()
      toast(`${settings.persona.name} est là ! Son nom, sa personnalité et sa voix sont chargés.`, 'info', 3500)
    }
  } catch (e) {
    toast(`Impossible de charger l’avatar : ${(e as Error).message}`)
  } finally {
    loader.hidden = true
    if (panel.isOpen) panel.render()
  }
}

/** Le personnage a changé (nom, voix…) : mise à jour de l'affichage et de la voix. */
function personaChanged(): void {
  $('persona-name').textContent = settings.persona.name
  convo.reloadVoice()
}

/* ---------------------------- Coffre à clés ---------------------------- */

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`

/** Clés du coffre chargées : on recharge la voix et on met les indicateurs à jour. */
function vaultApplied(keys: number): void {
  convo.reloadVoice()
  if (panel.isOpen) panel.render()
  updateKeysIndicator()
  const msg = `${plural(keys, 'clé')} ${keys > 1 ? 'chargées' : 'chargée'} depuis le coffre.`
  toast(`🔐 ${msg}`, 'info', 5000)
  if (ar?.active) ar.showNotice(`✓ ${msg} Tu peux parler (A ou X).`, 6000, true)
}

const vault = new VaultDialog(settings, vaultApplied)
/** Dernier coffre trouvé (site ou fichier importé), pour l'indicateur et la réalité augmentée. */
let knownVault: VaultFile | null = null

/** État des clés pour le panneau de réalité augmentée (le détail est dans ⚙ → IA). */
function updateKeysIndicator(): void {
  ar?.setKeys(loadedVaultKeys(settings) ? 'vault' : needsSetup() ? 'missing' : 'manual')
}

/** Au démarrage : propose le coffre s'il est nouveau pour cet appareil. */
async function offerVault(): Promise<boolean> {
  const file = (knownVault = await availableVault())
  updateKeysIndicator()
  panel.refresh('ia')
  if (!file || file.created === settings.vault.applied) return false
  // Appareil sans clé : on propose toujours le coffre (« Plus tard » ne vaut que pour cette fois).
  if (needsSetup()) {
    vault.unlock(file)
    return true
  }
  // Appareil déjà configuré : seulement un coffre plus récent que celui chargé ici, s'il n'a pas été écarté.
  if (settings.vault.applied && file.created > settings.vault.applied && file.created !== settings.vault.dismissed) {
    vault.unlock(file)
    return true
  }
  return false
}

/** Réalité augmentée : clavier virtuel pour taper la phrase secrète sans quitter le casque. */
async function arUnlock(): Promise<void> {
  if (!ar?.active || ar.typing) return
  if (ar.overlay) {
    // Téléphone : l'interface web est visible, on utilise la fenêtre et le clavier du téléphone.
    const file = (knownVault = await availableVault())
    if (file && !loadedVaultKeys(settings)) vault.unlock(file, { remindLater: false })
    else if (needsSetup()) panel.open('ia')
    return
  }
  const loaded = loadedVaultKeys(settings)
  if (loaded && !needsSetup()) {
    ar.showNotice(`✓ ${plural(loaded, 'clé')} du coffre ${loaded > 1 ? 'sont chargées' : 'est chargée'}. Pour ${loaded > 1 ? 'les' : 'la'} désactiver : ⚙ → IA → « Désactiver le coffre ».`, 7000, true)
    return
  }
  const file = (knownVault = await availableVault())
  if (!file) {
    ar.showNotice('Aucun coffre à clés disponible. Crée-le sur ton PC (⚙ → IA → Coffre à clés) puis publie-le avec le site.', 8000)
    return
  }
  ar.askText({
    title: '🔐 Coffre à clés',
    hint: 'Vise les touches et appuie sur la gâchette (ou pince), puis « Valider ».',
    async submit(text) {
      try {
        vaultApplied(await unlockVault(settings, file, text))
        return null
      } catch (e) {
        return e instanceof WrongPassphraseError ? 'Phrase secrète incorrecte, réessaie.' : `Coffre illisible : ${(e as Error).message}`
      }
    },
    cancel() {
      if (needsSetup()) ar?.showNotice('Sans clé API, l’avatar ne peut pas répondre. Le cadenas sous le panneau rouvre le clavier.', 7000)
    },
  })
}

/* ------------------------------ Réglages ------------------------------ */

const panel = new SettingsPanel(settings, {
  onChange(path) {
    if (path.startsWith('tts.') || path === 'persona.language' || path === 'useProxy') convo.reloadVoice()
    if (path.endsWith('.apiKey') || path === 'activeProvider') updateKeysIndicator()
    if (path === 'persona.name') $('persona-name').textContent = settings.persona.name
    if (path === 'memory.enabled' && !settings.memory.enabled) memory.disable()
    if (path === 'avatar.framing') stage.setFraming(settings.avatar.framing)
    if (path === 'avatar.followPointer') stage.followPointer = settings.avatar.followPointer
    if (path === 'ui.quality') stage.setQuality(settings.ui.quality)
    if (path === 'ui.background') stage.setBackground(settings.ui.background)
    if (path === 'ui.subtitles') $('subtitles').classList.toggle('hidden', !settings.ui.subtitles)
  },
  listModels: () => createLLM(settings).listModels(),
  listElevenVoices: () => listElevenLabsVoices(settings),
  async testVoice() {
    await unlockAudio()
    const tts = createTTS(settings)
    const phrase =
      settings.persona.language.startsWith('fr')
        ? `Bonjour ! Je m’appelle ${settings.persona.name}. Tu aimes ma voix ?`
        : `Hi! My name is ${settings.persona.name}. Do you like my voice?`
    try {
      const prepared = await tts.prepare(phrase)
      stage.setEmotion('happy', 4)
      await tts.play(prepared, (d) => stage.setMouth(d))
    } catch (e) {
      toast(`Voix : ${(e as Error).message}`)
    }
  },
  selectAvatar: (id) => void loadAvatar(id),
  async importAvatar(file) {
    const id = `file-${Date.now().toString(36)}`
    try {
      await saveAvatarFile(id, file)
    } catch (e) {
      toast(`Enregistrement impossible : ${(e as Error).message}`)
      return
    }
    settings.avatar.list.push({ id, name: file.name.replace(/\.vrm$/i, ''), url: `idb:${id}` })
    saveSettings(settings)
    await loadAvatar(id)
  },
  addAvatarUrl(name, url) {
    const id = `url-${Date.now().toString(36)}`
    settings.avatar.list.push({ id, name, url })
    saveSettings(settings)
    void loadAvatar(id)
  },
  async removeAvatar(id) {
    const entry = settings.avatar.list.find((a) => a.id === id)
    if (!entry || entry.builtin) return
    settings.avatar.list = settings.avatar.list.filter((a) => a.id !== id)
    if (entry.url.startsWith('idb:')) await deleteAvatarFile(entry.url.slice(4)).catch(() => {})
    saveSettings(settings)
    panel.render()
  },
  playGesture: (id) => void playGesture(id),
  async importAnimation(file) {
    const id = `anim-${Date.now().toString(36)}`
    const name = file.name.replace(/\.vrma$/i, '')
    try {
      await saveAvatarFile(id, file)
      const entry: AnimationEntry = {
        id,
        name,
        tag: slugify(name) || id,
        hint: name,
        url: `idb:${id}`,
        repeat: 1,
        fullBody: true,
      }
      await stage.gestures.load(await resolveAnimationUrl(entry)) // vérifie que le fichier est lisible
      settings.gestures.list.push(entry)
      saveSettings(settings)
      panel.render()
      void playGesture(id)
    } catch (e) {
      animationUrls.delete(id)
      await deleteAvatarFile(id).catch(() => {})
      toast(`Import impossible : ${(e as Error).message}`)
    }
  },
  async removeAnimation(id) {
    const entry = settings.gestures.list.find((a) => a.id === id)
    if (!entry || entry.builtin) return
    settings.gestures.list = settings.gestures.list.filter((a) => a.id !== id)
    if (entry.url.startsWith('idb:')) await deleteAvatarFile(entry.url.slice(4)).catch(() => {})
    const url = animationUrls.get(id)
    if (url) URL.revokeObjectURL(url)
    animationUrls.delete(id)
    saveSettings(settings)
    panel.render()
  },
  vaultCreate: () => vault.create(),
  async vaultLoad() {
    const file = (knownVault = await availableVault())
    if (file) vault.unlock(file, { remindLater: false })
    else
      toast(
        `Aucun coffre trouvé à l’adresse ${new URL('vault.json', location.href).href}. Vérifie que vault.json est bien dans le dossier « public » du dépôt de CE site, puis attends 1 à 2 minutes la mise en ligne.`,
        'info',
        12000,
      )
  },
  vaultAvailable: () => knownVault?.created ?? null,
  vaultForget() {
    if (!confirm('Désactiver le coffre ? Les clés qu’il a chargées seront effacées de cet appareil. Ta phrase secrète permettra de les recharger.')) return
    const n = forgetVaultKeys(settings)
    convo.reloadVoice()
    panel.render()
    updateKeysIndicator()
    toast(`🔓 Coffre désactivé : ${plural(n, 'clé')} ${n > 1 ? 'effacées' : 'effacée'} de cet appareil.`, 'info', 5000)
  },
  vaultRelease(path) {
    if (!confirm('Effacer cette clé du coffre pour en saisir une autre ?')) return
    releaseKey(settings, path)
    convo.reloadVoice()
    panel.render()
    updateKeysIndicator()
    panel.focusField(path)
  },
  async vaultImport(f) {
    const file = parseVault(await f.text())
    if (file) vault.unlock(file, { remindLater: false })
    else toast('Ce fichier n’est pas un coffre à clés.')
  },
  resetPersona() {
    if (!resetProfile(settings)) return
    personaChanged()
    panel.render()
    toast(`Personnage d\u2019origine de ${settings.persona.name} rétabli.`, 'info', 3000)
  },
  memory: () => memory,
  memoryAdd: (text) => memory.add(text),
  memoryRemove: (id) => memory.remove(id),
  memoryClear() {
    if (confirm(`Effacer tous les souvenirs ? ${settings.persona.name} oubliera tout ce qu’il sait de toi.`)) memory.clear()
  },
  async memoryFlush() {
    const n = await memory.flush()
    if (!n) toast('Rien de nouveau à retenir pour le moment.', 'info', 2500)
  },
  memoryExport() {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([memory.exportJSON()], { type: 'application/json' }))
    a.download = `avatar3d-memoire-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  },
  async memoryImport(file) {
    try {
      const n = memory.importJSON(await file.text())
      toast(`${n} souvenir${n > 1 ? 's' : ''} importé${n > 1 ? 's' : ''}.`, 'info', 3000)
    } catch (e) {
      toast(`Import impossible : ${(e as Error).message}`)
    }
  },
  clearHistory() {
    convo.clearHistory()
    userLine.textContent = ''
    aiLine.textContent = ''
    toast('Conversation effacée.', 'info', 2500)
  },
})

/* -------------------------- Réalité augmentée -------------------------- */

/** Pourquoi la réalité augmentée n'est pas disponible sur cet appareil, et quoi faire. */
function arUnavailableReason(): string {
  const ua = navigator.userAgent
  if (!window.isSecureContext) return 'La réalité augmentée exige une adresse en HTTPS.'
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1))
    return 'Sur iPhone et iPad, Safari ne gère pas encore la réalité augmentée du web (WebXR). Elle fonctionne sur Android avec Chrome, et sur les casques Meta Quest.'
  if (/Firefox|FxiOS/.test(ua)) return 'Firefox ne gère pas la réalité augmentée (WebXR). Sur Android, ouvre cette page dans Chrome.'
  if (/SamsungBrowser/.test(ua)) return 'Samsung Internet ne gère pas bien la réalité augmentée : ouvre cette page dans Chrome.'
  if (/Android/.test(ua))
    return 'La réalité augmentée n’est pas disponible : utilise Chrome à jour et installe « Services Google Play pour la RA » (ARCore) depuis le Play Store, puis recharge la page.'
  return 'Cet appareil ne gère pas la réalité augmentée. Elle fonctionne sur un téléphone Android avec Chrome, et sur les casques Meta Quest.'
}

const touchDevice = matchMedia('(pointer: coarse)').matches

void ARSession.isSupported().then((supported) => {
  const btn = $('ar-btn')
  if (!supported) {
    // Sur mobile, le bouton reste visible pour expliquer pourquoi la RA n'est pas possible ici.
    if (touchDevice) {
      btn.hidden = false
      btn.classList.add('unavailable')
      btn.addEventListener('click', () => toast(arUnavailableReason(), 'info', 10000))
    }
    return
  }
  btn.hidden = false
  ar = new ARSession(stage, {
    talk() {
      if (needsSetup()) {
        void arUnlock()
        return
      }
      if (sttEngineFor(settings) === 'unavailable') {
        ar?.showNotice('Ce navigateur ne reconnaît pas la voix lui-même : ajoute une clé OpenAI (⚙ → IA, ou ⚙ → Écoute → Whisper), hors du mode RA.', 8000)
        return
      }
      void convo.toggleListening()
    },
    interrupt() {
      convo.interrupt()
      stage.stopGesture()
    },
    keys: () => void arUnlock(),
    onScale(scale) {
      settings.avatar.arScale = scale
      saveSettings(settings)
      ar?.showNotice(`Taille : ${Math.round(scale * 100)} %`, 1500, true)
    },
    onStart() {
      document.body.classList.add('xr')
      btn.setAttribute('aria-pressed', 'true')
      panel.close()
      ar?.setState(convo.current)
      ar?.setUserText(userLine.textContent ?? '')
      ar?.setAssistantText(aiLine.textContent ?? '')
      updateKeysIndicator()
      if (needsSetup()) void arUnlock() // pas encore de clé : le clavier du coffre s'ouvre tout de suite
    },
    onEnd() {
      document.body.classList.remove('xr')
      stage.avatarRoot.scale.setScalar(1) // hors RA, l'avatar reprend sa taille normale
      btn.setAttribute('aria-pressed', 'false')
      stage.setFraming(settings.avatar.framing, true)
    },
  })
  btn.addEventListener('click', async () => {
    if (ar?.active) {
      void ar.stop() // au téléphone, le bouton reste visible et sert à quitter la RA
      return
    }
    await unlockAudio()
    // L'autorisation du micro s'affiche dans la page : on la demande avant d'entrer dans le casque.
    if (settings.stt.engine === 'whisper') {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        stream.getTracks().forEach((t) => t.stop())
      } catch {
        toast('Sans accès au micro, tu pourras seulement écouter l\u2019avatar.', 'info', 5000)
      }
    }
    try {
      ar?.setScale(settings.avatar.arScale)
      await ar?.start($('ui'))
    } catch (e) {
      toast(`Réalité augmentée impossible : ${(e as Error).message}`)
    }
  })
})

/* ------------------------------ Démarrage ------------------------------ */

$('persona-name').textContent = settings.persona.name
// Réaffiche le dernier échange de la conversation reprise.
{
  const last = convo.lastExchange
  if (last) {
    userLine.textContent = last.user
    aiLine.textContent = parseSegment(last.assistant, 'neutral').text
  }
}
$('subtitles').classList.toggle('hidden', !settings.ui.subtitles)
stage.followPointer = settings.avatar.followPointer
stage.setQuality(settings.ui.quality)
stage.setBackground(settings.ui.background)
void loadAvatar(settings.avatar.current).then(() => {
  stage.setFraming(settings.avatar.framing, true)
  // Précharge les gestes fournis pour qu'ils démarrent sans délai.
  for (const a of settings.gestures.list) if (a.builtin) void stage.gestures.load(a.url).catch(() => {})
})

// Accueil (mode kiosque) : les questions suggérées défilent une par une ; un appui pose la question
$('brand').textContent = EDITION.event
$('welcome-text').textContent = EDITION.welcome
$('privacy').textContent = EDITION.privacy
let suggestions = [...EDITION.suggestions]
let suggestionIndex = 0
let suggestionDots: HTMLElement[] = []
const suggestionText = $('suggestion-text')
const showSuggestion = (i: number) => {
  suggestionIndex = i
  suggestionText.textContent = suggestions[i]
  suggestionText.classList.remove('in')
  void suggestionText.offsetWidth // relance l'animation d'apparition
  suggestionText.classList.add('in')
  suggestionDots.forEach((d, j) => d.classList.toggle('on', j === i))
}
const setSuggestions = (list: string[]) => {
  suggestions = list
  suggestionDots = list.map(() => document.createElement('i'))
  $('suggestion-dots').replaceChildren(...suggestionDots)
  showSuggestion(0)
}
setSuggestions(suggestions)
// questions tirées des documents du serveur (voir server/suggestions.mjs), mêlées aux questions de base
fetch('/api/suggestions')
  .then((r) => (r.ok ? r.json() : null))
  .then((data: { questions?: string[] } | null) => {
    const fromDocs = (data?.questions ?? []).filter((q) => typeof q === 'string' && q.trim())
    if (!fromDocs.length) return
    // la première reste en tête ; les autres sont mêlées aux questions tirées des documents
    const [first, ...rest] = EDITION.suggestions
    const mixed = [...rest, ...fromDocs].filter((q, i, a) => a.indexOf(q) === i).sort(() => Math.random() - 0.5)
    setSuggestions([first, ...mixed.filter((q) => q !== first)].slice(0, 16))
  })
  .catch(() => {})
setInterval(() => {
  if (document.hidden || $('welcome').hidden || (document.body.dataset.state ?? 'idle') !== 'idle') return
  showSuggestion((suggestionIndex + 1) % suggestions.length)
}, 4500)
$('suggestion').addEventListener('click', () => {
  void unlockAudio()
  void convo.send(suggestions[suggestionIndex])
})
if (convo.lastExchange) $('welcome').hidden = true
void offerVault // le coffre à clés n'existe pas dans cette édition (aucune clé à saisir)

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => void navigator.serviceWorker.register('sw.js').catch(() => {}))
}

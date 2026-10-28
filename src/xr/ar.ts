import * as THREE from 'three'
import type { Activity, AvatarStage } from '../avatar/stage'
import { XRKeyboard, type KeyboardRequest } from './keyboard'

export interface ARHooks {
  /** Bouton micro (A/X, ou le bouton du panneau) : parler / terminer / interrompre. */
  talk(): void
  /** Bouton B/Y : couper la parole de l'avatar. */
  interrupt(): void
  /** Bouton cadenas du panneau : charger les clés du coffre (ou voir leur état). */
  keys(): void
  /** Taille de l'avatar changée à deux mains (ou deux doigts) : pour la mémoriser. */
  onScale?(scale: number): void
  onStart(): void
  onEnd(): void
}

const STATUS: Record<Activity, [string, string]> = {
  idle: ['En attente — A ou X pour parler', '#a7abc4'],
  listening: ['J’écoute…', '#4fd1a5'],
  thinking: ['Réfléchit…', '#ffc65c'],
  speaking: ['Parle — B ou Y pour l’interrompre', '#ff7eb6'],
}

/** État des clés API, affiché sur le panneau : chargées depuis le coffre, saisies à la main, absentes. */
export type KeysState = 'vault' | 'manual' | 'missing'

/** Distance maximale (m) à laquelle on peut viser le sol pour déplacer l'avatar. */
const MAX_REACH = 10
/** Vitesse de déplacement de l'avatar vers sa destination. */
const GLIDE = 6
/** Taille de l'avatar : de 30 % à 250 % de sa taille réelle. */
const MIN_SCALE = 0.3
const MAX_SCALE = 2.5

/**
 * Réalité augmentée (casque Meta Quest et autres appareils WebXR « immersive-ar ») :
 * l'avatar apparaît à taille réelle, posé sur le sol de la pièce, face à l'utilisateur.
 *
 * - Viser le sol avec une manette (ou la main) et appuyer sur la gâchette (ou pincer) : l'avatar
 *   s'y rend. En maintenant la gâchette ou la poignée, on le fait glisser.
 * - A / X (ou le bouton micro du panneau) : parler. B / Y : l'interrompre.
 * - Un panneau flottant à côté de l'avatar affiche l'état et les sous-titres.
 */
export class ARSession {
  private session: XRSession | null = null
  private readonly controllers: THREE.Group[] = []
  private readonly sources = new Map<THREE.Group, XRInputSource>()
  private readonly dragging = new Set<THREE.Group>()
  private readonly pressed = new Map<string, boolean>()
  private readonly reticle: THREE.Mesh
  private readonly shadow: THREE.Mesh
  private readonly panel: THREE.Mesh
  private readonly panelCanvas = document.createElement('canvas')
  private readonly panelTexture: THREE.CanvasTexture
  private readonly mic: THREE.Mesh
  private readonly micCanvas = document.createElement('canvas')
  private readonly micTexture: THREE.CanvasTexture
  private readonly lock: THREE.Mesh
  private readonly lockCanvas = document.createElement('canvas')
  private readonly lockTexture: THREE.CanvasTexture
  private readonly keyboard = new XRKeyboard()
  private placeKeyboard = false
  private readonly floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  private readonly raycaster = new THREE.Raycaster()
  private readonly target = new THREE.Vector3()
  private placed = false
  private yaw = 0
  /** Orientation voulue : l'avatar ne pivote plus tout seul pour suivre l'utilisateur. */
  private yawGoal = 0
  private avatarScale = 1
  /** Manettes, mains ou doigts dont la gâchette / le pincement / le contact est maintenu. */
  private readonly held = new Set<THREE.Group>()
  /** Geste à deux mains (ou deux doigts) en cours : agrandir / réduire et faire pivoter. */
  private pinch: { d0: number; s0: number; a0: number; y0: number } | null = null
  private beforePress = new THREE.Vector3()
  /** Deux doigts sur l'écran du téléphone (événements tactiles de la page affichée par-dessus la caméra). */
  private touchPinch: { d0: number; s0: number; a0: number; y0: number } | null = null
  private readonly onTouch = (e: TouchEvent) => this.handleTouch(e)
  /** Hauteur du sol dans le référentiel de la session (0 avec « local-floor », détectée sinon). */
  private floorY = 0
  private floorKnown = false
  private hitTest: XRHitTestSource | null = null
  /** Téléphone ou tablette : pas de manettes, on touche l'écran ; l'interface web reste visible. */
  private handheld = false
  /** L'interface web est affichée par-dessus la caméra (téléphone Android avec Chrome). */
  overlay = false
  private overlayRoot: HTMLElement | null = null

  private state: Activity = 'idle'
  private userText = ''
  private aiText = ''
  private notice = ''
  private noticeOk = false
  private noticeUntil = 0
  private keysState: KeysState = 'missing'

  /** Le navigateur sait-il afficher de la réalité augmentée ? (casque Quest : oui) */
  static async isSupported(): Promise<boolean> {
    try {
      return Boolean(await navigator.xr?.isSessionSupported('immersive-ar'))
    } catch {
      return false
    }
  }

  constructor(
    private readonly stage: AvatarStage,
    private readonly hooks: ARHooks,
  ) {
    const scene = stage.scene

    // Cercle au sol indiquant où l'avatar ira.
    this.reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.12, 0.16, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xff7eb6, transparent: true, opacity: 0.85, depthWrite: false }),
    )
    this.reticle.visible = false
    scene.add(this.reticle)

    // Ombre douce sous l'avatar : elle l'ancre visuellement sur le vrai sol.
    this.shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.4, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: radialTexture(), transparent: true, depthWrite: false }),
    )
    this.shadow.position.y = 0.003
    this.shadow.visible = false
    stage.avatarRoot.add(this.shadow)

    // Panneau de sous-titres et bouton micro, toujours tournés vers l'utilisateur.
    this.panelCanvas.width = 1024
    this.panelCanvas.height = 512
    this.panelTexture = new THREE.CanvasTexture(this.panelCanvas)
    this.panelTexture.colorSpace = THREE.SRGBColorSpace
    this.panel = new THREE.Mesh(
      new THREE.PlaneGeometry(0.8, 0.4),
      new THREE.MeshBasicMaterial({ map: this.panelTexture, transparent: true, depthWrite: false }),
    )
    this.panel.visible = false
    this.panel.renderOrder = 10
    scene.add(this.panel)

    this.micCanvas.width = this.micCanvas.height = 256
    this.micTexture = new THREE.CanvasTexture(this.micCanvas)
    this.micTexture.colorSpace = THREE.SRGBColorSpace
    this.mic = new THREE.Mesh(
      new THREE.CircleGeometry(0.07, 40),
      new THREE.MeshBasicMaterial({ map: this.micTexture, transparent: true, depthWrite: false }),
    )
    this.mic.position.set(0, -0.27, 0.001)
    this.mic.renderOrder = 11
    this.panel.add(this.mic)

    // Bouton cadenas : vert quand les clés sont chargées ; sinon il ouvre le clavier du coffre.
    this.lockCanvas.width = this.lockCanvas.height = 256
    this.lockTexture = new THREE.CanvasTexture(this.lockCanvas)
    this.lockTexture.colorSpace = THREE.SRGBColorSpace
    this.lock = new THREE.Mesh(
      new THREE.CircleGeometry(0.05, 40),
      new THREE.MeshBasicMaterial({ map: this.lockTexture, transparent: true, depthWrite: false }),
    )
    this.lock.position.set(-0.3, -0.27, 0.001)
    this.lock.renderOrder = 11
    this.panel.add(this.lock)
    scene.add(this.keyboard.mesh)
    this.redraw()

    // Manettes ou mains : un rayon par main pour viser.
    for (let i = 0; i < 2; i++) {
      const c = stage.renderer.xr.getController(i)
      c.add(rayLine())
      c.visible = false
      c.addEventListener('connected', (e) => {
        this.sources.set(c, (e as unknown as { data: XRInputSource }).data)
        c.visible = true
      })
      c.addEventListener('disconnected', () => {
        this.sources.delete(c)
        this.release(c)
        c.visible = false
      })
      c.addEventListener('selectstart', () => this.hold(c, 'select'))
      c.addEventListener('selectend', () => this.release(c))
      c.addEventListener('squeezestart', () => this.hold(c, 'squeeze'))
      c.addEventListener('squeezeend', () => this.release(c))
      scene.add(c)
      this.controllers.push(c)
    }
  }

  get active(): boolean {
    return this.session !== null
  }

  async start(overlayRoot?: HTMLElement): Promise<void> {
    if (this.session || !navigator.xr) return
    // Seul « immersive-ar » est indispensable : le sol, la détection des surfaces et l'interface
    // par-dessus la caméra sont utilisés quand l'appareil les propose (casque Quest, Chrome Android…).
    const session = await navigator.xr.requestSession('immersive-ar', {
      optionalFeatures: ['local-floor', 'hit-test', 'dom-overlay', 'hand-tracking', 'bounded-floor'],
      ...(overlayRoot ? { domOverlay: { root: overlayRoot } } : {}),
    })
    this.session = session
    this.placed = false
    this.handheld = /Android|iPhone|iPad/i.test(navigator.userAgent) && !/OculusBrowser|Quest|Pico/i.test(navigator.userAgent)
    this.overlay = Boolean((session as XRSession & { domOverlayState?: unknown }).domOverlayState)
    const hasFloor = await session.requestReferenceSpace('local-floor').then(
      () => true,
      () => false,
    )
    // Sans « local-floor » (téléphones), le sol est estimé ~1,4 m sous l'appareil puis détecté par la caméra.
    this.floorY = hasFloor ? 0 : -1.4
    this.floorKnown = hasFloor
    this.floor.constant = -this.floorY
    const xr = this.stage.renderer.xr
    xr.setReferenceSpaceType(hasFloor ? 'local-floor' : 'local')
    await xr.setSession(session)
    this.hitTest = null
    if (!hasFloor && session.requestHitTestSource) {
      session
        .requestReferenceSpace('viewer')
        .then((space) => session.requestHitTestSource!({ space }))
        .then((source) => (this.hitTest = source ?? null))
        .catch(() => {})
    }
    this.shadow.visible = true
    // Avec l'interface web par-dessus la caméra, le panneau flottant ferait doublon.
    this.panel.visible = !this.overlay
    if (overlayRoot && this.overlay) {
      this.overlayRoot = overlayRoot
      overlayRoot.classList.add('xr-overlay')
      overlayRoot.addEventListener('beforexrselect', blockSelectOnUI)
      this.attachTouch(overlayRoot)
    }
    this.stage.xrUpdate = (dt) => this.update(dt)
    session.addEventListener('end', () => this.cleanup())
    this.hooks.onStart()
  }

  async stop(): Promise<void> {
    await this.session?.end()
  }

  private cleanup(): void {
    this.keyboard.cancel()
    this.hitTest?.cancel()
    this.hitTest = null
    this.overlayRoot?.removeEventListener('beforexrselect', blockSelectOnUI)
    this.overlayRoot?.classList.remove('xr-overlay')
    if (this.overlayRoot) this.detachTouch(this.overlayRoot)
    this.overlayRoot = null
    this.touchPinch = null
    this.overlay = false
    this.session = null
    this.stage.xrUpdate = null
    this.reticle.visible = this.shadow.visible = this.panel.visible = false
    this.dragging.clear()
    this.held.clear()
    this.pinch = null
    this.hooks.onEnd()
  }

  /* ------------------------------ Affichage ------------------------------ */

  setState(state: Activity): void {
    this.state = state
    this.redraw()
  }

  setUserText(text: string): void {
    this.userText = text
    this.redraw()
  }

  setAssistantText(text: string): void {
    this.aiText = text
    this.redraw()
  }

  /** Message temporaire dans le panneau (erreur, conseil…), les toasts n'étant pas visibles en RA. */
  showNotice(text: string, ms = 6000, ok = false): void {
    this.notice = text
    this.noticeOk = ok
    this.noticeUntil = performance.now() + ms
    this.redraw()
  }

  get scale(): number {
    return this.avatarScale
  }

  setScale(scale: number): void {
    this.avatarScale = THREE.MathUtils.clamp(scale, MIN_SCALE, MAX_SCALE)
    this.stage.avatarRoot.scale.setScalar(this.avatarScale)
  }

  /** Niveau du micro (0 à 1) pendant l'écoute : le bouton micro du panneau « respire » avec la voix. */
  setLevel(level: number): void {
    this.mic.scale.setScalar(1 + Math.min(1, level) * 0.45)
  }

  setKeys(state: KeysState): void {
    this.keysState = state
    this.redraw()
  }

  /** Affiche le clavier virtuel devant l'utilisateur (saisie de la phrase secrète du coffre). */
  askText(request: KeyboardRequest): void {
    this.keyboard.open(request)
    this.placeKeyboard = true
  }

  get typing(): boolean {
    return this.keyboard.isOpen
  }



  private redraw(): void {
    const ctx = this.panelCanvas.getContext('2d')
    if (!ctx) return
    const W = this.panelCanvas.width
    const H = this.panelCanvas.height
    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = 'rgba(16, 17, 32, 0.82)'
    roundRect(ctx, 8, 8, W - 16, H - 96, 40)
    ctx.fill()

    const [label, color] = STATUS[this.state]
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.arc(64, 64, 14, 0, Math.PI * 2)
    ctx.fill()
    ctx.font = '600 36px system-ui, sans-serif'
    ctx.fillText(label, 96, 77)

    // État des clés, en haut à droite.
    const [keysLabel, keysColor] =
      this.keysState === 'vault' ? ['Clés du coffre ✓', '#4fd1a5'] : this.keysState === 'manual' ? ['Clés ✓', '#4fd1a5'] : ['Clés absentes', '#ffc65c']
    ctx.font = '600 26px system-ui, sans-serif'
    ctx.fillStyle = keysColor
    ctx.textAlign = 'right'
    ctx.fillText(keysLabel, W - 48, 42)
    ctx.textAlign = 'left'

    let y = 140
    const notice = performance.now() < this.noticeUntil ? this.notice : ''
    if (notice) {
      ctx.fillStyle = this.noticeOk ? '#7ff0c4' : '#ffb3b3'
      ctx.font = '32px system-ui, sans-serif'
      for (const line of wrap(ctx, notice, W - 96, 4)) {
        ctx.fillText(line, 48, y)
        y += 42
      }
    } else {
      if (this.userText) {
        ctx.fillStyle = '#b9aaff'
        ctx.font = 'italic 32px system-ui, sans-serif'
        for (const line of wrap(ctx, `« ${this.userText} »`, W - 96, 2)) {
          ctx.fillText(line, 48, y)
          y += 42
        }
        y += 8
      }
      ctx.fillStyle = '#f2f3fa'
      ctx.font = '34px system-ui, sans-serif'
      const lines = wrap(ctx, this.aiText, W - 96, 99)
      for (const line of lines.slice(-Math.max(1, Math.floor((H - 110 - y) / 44)))) {
        ctx.fillText(line, 48, y)
        y += 44
      }
    }
    this.panelTexture.needsUpdate = true

    // Bouton micro : vert quand il écoute, rose sinon, carré « stop » quand il parle.
    const m = this.micCanvas.getContext('2d')
    if (!m) return
    m.clearRect(0, 0, 256, 256)
    m.fillStyle = this.state === 'listening' ? '#4fd1a5' : this.state === 'idle' ? '#ff7eb6' : '#8f7bff'
    m.beginPath()
    m.arc(128, 128, 120, 0, Math.PI * 2)
    m.fill()
    m.fillStyle = '#ffffff'
    if (this.state === 'speaking' || this.state === 'thinking') {
      roundRect(m, 84, 84, 88, 88, 14)
      m.fill()
    } else {
      roundRect(m, 100, 52, 56, 100, 28)
      m.fill()
      m.strokeStyle = '#ffffff'
      m.lineWidth = 14
      m.beginPath()
      m.arc(128, 118, 52, 0.15 * Math.PI, 0.85 * Math.PI)
      m.stroke()
      m.fillRect(121, 170, 14, 34)
    }
    this.micTexture.needsUpdate = true

    // Cadenas : fermé et vert quand les clés sont chargées, ouvert et orange sinon.
    const l = this.lockCanvas.getContext('2d')
    if (!l) return
    const loaded = this.keysState !== 'missing'
    l.clearRect(0, 0, 256, 256)
    l.fillStyle = loaded ? '#4fd1a5' : '#ffc65c'
    l.beginPath()
    l.arc(128, 128, 120, 0, Math.PI * 2)
    l.fill()
    l.strokeStyle = l.fillStyle = '#1b1c2e'
    l.lineWidth = 18
    l.beginPath()
    if (loaded) l.arc(128, 112, 34, Math.PI, 0)
    else l.arc(128, 100, 34, Math.PI, -0.1 * Math.PI)
    l.stroke()
    if (loaded) {
      l.beginPath()
      l.moveTo(94, 112)
      l.lineTo(94, 130)
      l.moveTo(162, 112)
      l.lineTo(162, 130)
      l.stroke()
    } else {
      l.beginPath()
      l.moveTo(94, 100)
      l.lineTo(94, 130)
      l.stroke()
    }
    roundRect(l, 76, 124, 104, 80, 14)
    l.fill()
    this.lockTexture.needsUpdate = true
  }

  /* ------------------------------ Interaction ------------------------------ */

  private rayFrom(c: THREE.Group): THREE.Ray {
    const origin = c.getWorldPosition(new THREE.Vector3())
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(c.getWorldQuaternion(new THREE.Quaternion()))
    return new THREE.Ray(origin, dir)
  }

  private floorHit(c: THREE.Group): THREE.Vector3 | null {
    const ray = this.rayFrom(c)
    const hit = ray.intersectPlane(this.floor, new THREE.Vector3())
    return hit && hit.distanceTo(ray.origin) <= MAX_REACH ? hit : null
  }

  private pointsAt(c: THREE.Group, object: THREE.Object3D): boolean {
    const ray = this.rayFrom(c)
    this.raycaster.set(ray.origin, ray.direction)
    return this.raycaster.intersectObject(object, false).length > 0
  }

  /**
   * Chrome sur Android ne transmet à la réalité augmentée qu'un seul doigt à la fois : le geste à deux
   * doigts est donc lu sur les événements tactiles de l'interface affichée par-dessus la caméra.
   */
  attachTouch(el: HTMLElement): void {
    for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const) el.addEventListener(type, this.onTouch, { passive: false })
  }

  detachTouch(el: HTMLElement): void {
    for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const) el.removeEventListener(type, this.onTouch)
  }

  private handleTouch(e: TouchEvent): void {
    if (e.touches.length >= 2 && !this.keyboard.isOpen) {
      const [a, b] = [e.touches[0], e.touches[1]]
      const d = Math.max(Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY), 1)
      const angle = Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX)
      if (!this.touchPinch) {
        this.touchPinch = { d0: d, s0: this.avatarScale, a0: angle, y0: this.yawGoal }
        this.pinch = null
        this.dragging.clear()
        this.target.copy(this.beforePress) // annule le déplacement lancé par le premier doigt
      } else {
        this.setScale((this.touchPinch.s0 * d) / this.touchPinch.d0)
        let turn = angle - this.touchPinch.a0
        turn = Math.atan2(Math.sin(turn), Math.cos(turn))
        this.yawGoal = this.touchPinch.y0 - turn
      }
      e.preventDefault()
    } else if (this.touchPinch && e.touches.length < 2) {
      this.touchPinch = null
      this.dragging.clear()
      this.hooks.onScale?.(this.avatarScale)
    }
  }

  private hold(c: THREE.Group, kind: 'select' | 'squeeze'): void {
    if (this.touchPinch) return // geste à deux doigts en cours
    this.held.add(c)
    // Deuxième main (ou deuxième doigt) : on passe au geste « agrandir / pivoter ».
    if (this.held.size === 2 && !this.keyboard.isOpen) {
      const [a, b] = [...this.held]
      this.pinch = { d0: Math.max(this.handDistance(a, b), 1e-3), s0: this.avatarScale, a0: this.handAngle(a, b), y0: this.yawGoal }
      this.dragging.clear()
      this.target.copy(this.beforePress) // annule le déplacement lancé par la première main
      return
    }
    if (this.held.size > 1) return
    this.beforePress.copy(this.target)
    if (kind === 'select') this.onPress(c)
    else this.dragging.add(c)
  }

  private release(c: THREE.Group): void {
    if (!this.held.delete(c) && !this.dragging.has(c)) return
    if (this.pinch && this.held.size < 2) {
      this.pinch = null
      this.dragging.clear() // la main restante ne déplace pas l'avatar
      this.hooks.onScale?.(this.avatarScale)
      return
    }
    // Fin d'un déplacement : arrivé à destination, l'avatar se tourne vers l'utilisateur.
    if (this.dragging.delete(c)) this.faceUserAt(this.target)
  }

  private faceUserAt(p: THREE.Vector3): void {
    const head = this.stage.renderer.xr.getCamera().getWorldPosition(new THREE.Vector3())
    this.yawGoal = Math.atan2(head.x - p.x, head.z - p.z)
  }

  /** Position d'une main / d'un doigt : pour un doigt sur l'écran, dans le plan de l'écran. */
  private handPoint(c: THREE.Group): THREE.Vector3 {
    const p = c.getWorldPosition(new THREE.Vector3())
    if (this.sources.get(c)?.targetRayMode === 'screen') this.stage.renderer.xr.getCamera().worldToLocal(p)
    return p
  }

  private handDistance(a: THREE.Group, b: THREE.Group): number {
    return this.handPoint(a).distanceTo(this.handPoint(b))
  }

  /** Angle entre les deux mains vu du dessus (ou entre les deux doigts sur l'écran). */
  private handAngle(a: THREE.Group, b: THREE.Group): number {
    const v = this.handPoint(b).sub(this.handPoint(a))
    return this.sources.get(a)?.targetRayMode === 'screen' ? Math.atan2(v.y, v.x) : Math.atan2(v.x, v.z)
  }

  private onPress(c: THREE.Group): void {
    if (this.keyboard.isOpen) {
      const ray = this.rayFrom(c)
      const key = this.keyboard.hit(ray)
      if (key) this.keyboard.press(key)
      if (this.keyboard.covers(ray)) return
    } else if (this.panel.visible && this.pointsAt(c, this.mic)) {
      this.hooks.talk()
      return
    }
    if (this.panel.visible && this.pointsAt(c, this.lock)) {
      this.hooks.keys()
      return
    }
    const hit = this.floorHit(c)
    if (hit) {
      this.target.copy(hit)
      this.placed = true
      this.dragging.add(c) // tant que la gâchette est maintenue, l'avatar suit le rayon
    }
  }

  /** Boutons A/X (index 4) et B/Y (index 5) de la manette (profil « xr-standard »). */
  private pollButtons(): void {
    const typing = this.keyboard.isOpen // pas de micro pendant la saisie de la phrase secrète
    for (const [c, source] of this.sources) {
      const buttons = source.gamepad?.buttons
      if (!buttons) continue
      for (const [index, action] of [
        [4, () => this.hooks.talk()],
        [5, () => this.hooks.interrupt()],
      ] as const) {
        const key = `${c.uuid}:${index}`
        const down = Boolean(buttons[index]?.pressed)
        if (down && !this.pressed.get(key) && !typing) action()
        this.pressed.set(key, down)
      }
    }
  }

  /** Téléphone : la caméra détecte les surfaces ; la plus basse, horizontale, est le sol. */
  private detectFloor(head: THREE.Vector3): void {
    const xr = this.stage.renderer.xr
    const frame = xr.getFrame()
    const space = xr.getReferenceSpace()
    if (!this.hitTest || !frame || !space) return
    const pose = frame.getHitTestResults(this.hitTest)[0]?.getPose(space)
    if (!pose) return
    const o = pose.transform.orientation
    const normal = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(o.x, o.y, o.z, o.w))
    const y = pose.transform.position.y
    if (normal.y < 0.9 || y > head.y - 0.7) return // mur, table ou surface trop haute
    if (!this.floorKnown || y < this.floorY - 0.05) this.floorY = y
    else this.floorY += (y - this.floorY) * 0.05
    this.floorKnown = true
    this.floor.constant = -this.floorY
  }

  private update(dt: number): void {
    const camera = this.stage.renderer.xr.getCamera()
    const head = camera.getWorldPosition(new THREE.Vector3())
    const root = this.stage.avatarRoot
    if (this.hitTest) this.detectFloor(head)

    // Première image : l'avatar apparaît à 1,6 m devant l'utilisateur, face à lui.
    if (!this.placed && head.lengthSq() > 0) {
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion()))
      forward.y = 0
      if (forward.lengthSq() < 1e-4) forward.set(0, 0, -1)
      forward.normalize()
      // Au téléphone, un peu plus loin pour voir l'avatar en entier malgré l'angle de vue réduit.
      const distance = this.handheld ? 2.2 : 1.6
      this.target.set(head.x + forward.x * distance, this.floorY, head.z + forward.z * distance)
      root.position.copy(this.target)
      this.yaw = this.yawGoal = Math.atan2(head.x - this.target.x, head.z - this.target.z)
      this.placed = true
    }

    // Visée : cercle au sol sous le rayon de la manette qui pointe le sol.
    let aim: THREE.Vector3 | null = null
    for (const c of this.controllers) {
      if (!this.sources.has(c)) continue
      const hit = this.floorHit(c)
      if (hit && (!aim || this.dragging.has(c))) aim = hit
      if (hit && this.dragging.has(c)) this.target.copy(hit)
    }
    // Clavier : placé devant l'utilisateur à l'ouverture, un peu sous les yeux, incliné vers lui.
    if (this.keyboard.isOpen) {
      if (this.placeKeyboard && head.lengthSq() > 0) {
        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion()))
        forward.y = 0
        if (forward.lengthSq() < 1e-4) forward.set(0, 0, -1)
        forward.normalize()
        const kb = this.keyboard.mesh
        kb.position.set(head.x + forward.x * 0.6, head.y - 0.28, head.z + forward.z * 0.6)
        kb.lookAt(head)
        this.placeKeyboard = false
      }
      let hover = null
      for (const c of this.controllers) {
        if (!this.sources.has(c)) continue
        const ray = this.rayFrom(c)
        hover ??= this.keyboard.hit(ray)
        if (this.keyboard.covers(ray)) aim = null // pas de cercle au sol en visant le clavier
      }
      this.keyboard.setHover(hover)
    }
    this.reticle.visible = aim !== null
    if (aim) this.reticle.position.copy(aim).setY(this.floorY + 0.004)

    // Deux mains / deux doigts : écarter pour agrandir, rapprocher pour réduire, tourner pour pivoter.
    if (this.pinch && this.held.size === 2) {
      const [a, b] = [...this.held]
      this.setScale((this.pinch.s0 * this.handDistance(a, b)) / this.pinch.d0)
      let turn = this.handAngle(a, b) - this.pinch.a0
      turn = Math.atan2(Math.sin(turn), Math.cos(turn))
      this.yawGoal = this.pinch.y0 + turn
    }
    // Joystick gauche / droite : faire pivoter l'avatar sur lui-même.
    for (const source of this.sources.values()) {
      const x = source.gamepad?.axes[2] ?? 0
      if (Math.abs(x) > 0.25) this.yawGoal -= x * 1.8 * dt
    }

    // Déplacement fluide vers la destination. L'avatar garde son orientation : on peut tourner
    // autour de lui (sa tête et son regard suivent l'utilisateur).
    root.position.lerp(this.target, 1 - Math.exp(-GLIDE * dt))
    root.position.y = this.floorY
    let delta = this.yawGoal - this.yaw
    delta = Math.atan2(Math.sin(delta), Math.cos(delta))
    this.yaw += delta * (1 - Math.exp(-6 * dt))
    root.rotation.set(0, this.yaw, 0)

    // Panneau : sur le côté de l'avatar (vu depuis l'utilisateur), à hauteur des yeux de l'avatar.
    const toUser = new THREE.Vector3(head.x - root.position.x, 0, head.z - root.position.z).normalize()
    const side = new THREE.Vector3(toUser.z, 0, -toUser.x) // à droite de l'avatar vu par l'utilisateur
    const s = this.avatarScale
    const h = this.floorY + Math.min(Math.max(this.stage.height * s * 0.75, 0.9), 1.5)
    this.panel.position.copy(root.position).addScaledVector(side, -(0.45 + 0.3 * s)).addScaledVector(toUser, 0.15).setY(h)
    this.panel.lookAt(head.x, h, head.z)
    if (this.notice && performance.now() > this.noticeUntil) {
      this.notice = ''
      this.redraw()
    }

    this.pollButtons()
  }
}

/* ------------------------------ Utilitaires ------------------------------ */

/** Un toucher sur un bouton de l'interface web ne doit pas aussi déplacer l'avatar. */
function blockSelectOnUI(e: Event): void {
  if ((e.target as HTMLElement | null)?.closest?.('button, input, textarea, select, a, label, dialog, .panel, .controls, .topbar, .gesture-menu, .toast')) {
    e.preventDefault()
  }
}

function rayLine(): THREE.Line {
  const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)])
  const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 }))
  line.scale.z = 3
  return line
}

function radialTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const ctx = c.getContext('2d')!
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
  g.addColorStop(0, 'rgba(0,0,0,0.45)')
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 128, 128)
  return new THREE.CanvasTexture(c)
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/** Coupe un texte en lignes qui tiennent dans `width` pixels (au plus `max` lignes). */
export function wrap(ctx: { measureText(t: string): { width: number } }, text: string, width: number, max: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const test = line ? `${line} ${word}` : word
    if (ctx.measureText(test).width > width && line) {
      lines.push(line)
      line = word
    } else line = test
  }
  if (line) lines.push(line)
  if (lines.length > max) {
    const kept = lines.slice(0, max)
    kept[max - 1] = kept[max - 1].replace(/\s*\S*$/, '') + '…'
    return kept
  }
  return lines
}

import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_PROFILES, captureProfile, pickVoice, resetProfile, switchProfile } from '../src/profiles'
import { defaultSettings, type Settings } from '../src/settings'

// saveSettings écrit dans localStorage : une version en mémoire suffit pour les tests.
beforeEach(() => {
  const store = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  } as Storage
})

describe('profils par avatar', () => {
  it('charge le personnage du nouvel avatar et mémorise celui de l’ancien', () => {
    const s: Settings = defaultSettings()
    s.persona.prompt = 'Aiko personnalisée'
    expect(switchProfile(s, 'sample', 'leo')).toBe(true)
    expect(s.persona.name).toBe('Léo')
    expect(s.tts.voiceHint).toBe('male')
    expect(s.tts.openai.voice).toBe(DEFAULT_PROFILES.leo.openaiVoice)
    s.tts.pitch = 0.8 // retouche propre à Léo
    switchProfile(s, 'leo', 'sample')
    expect(s.persona.prompt).toBe('Aiko personnalisée')
    switchProfile(s, 'sample', 'leo')
    expect(s.tts.pitch).toBe(0.8)
  })

  it('garde le personnage actuel pour un avatar importé', () => {
    const s = defaultSettings()
    expect(switchProfile(s, 'sample', 'file-abc')).toBe(false)
    expect(s.persona.name).toBe('Aiko')
    expect(s.profiles.sample).toEqual(captureProfile(s))
  })

  it('rétablit le personnage d’origine', () => {
    const s = defaultSettings()
    switchProfile(s, 'sample', 'bip')
    s.avatar.current = 'bip'
    s.persona.name = 'Robert'
    s.profiles.bip = captureProfile(s)
    expect(resetProfile(s)).toBe(true)
    expect(s.persona.name).toBe('Bip')
    expect(s.profiles.bip).toBeUndefined()
  })
})

describe('pickVoice', () => {
  const voices = [
    { name: 'Google français', lang: 'fr-FR' },
    { name: 'Microsoft Denise Online (Natural) - French (France)', lang: 'fr-FR' },
    { name: 'Microsoft Henri Online (Natural) - French (France)', lang: 'fr-FR' },
    { name: 'Microsoft Paul - French (France)', lang: 'fr-FR' },
    { name: 'Google US English', lang: 'en-US' },
  ]
  it('choisit une voix masculine de qualité pour un personnage masculin', () => {
    expect(pickVoice(voices, 'fr-FR', 'male')?.name).toContain('Henri')
  })
  it('choisit une voix féminine pour un personnage féminin', () => {
    expect(pickVoice(voices, 'fr-FR', 'female')?.name).toMatch(/Google français|Denise/)
  })
  it('se rabat sur une voix de la langue quand le type demandé n’existe pas', () => {
    const onlyFemale = voices.filter((v) => !/Henri|Paul/.test(v.name))
    expect(pickVoice(onlyFemale, 'fr-FR', 'male')?.lang).toBe('fr-FR')
    expect(pickVoice([{ name: 'Thomas', lang: 'fr_FR' }], 'fr-FR', 'male')?.name).toBe('Thomas')
    expect(pickVoice([], 'fr-FR', 'any')).toBeNull()
  })
  it('sur Mac, préfère une voix féminine d’une autre région à Thomas', () => {
    const mac = [
      { name: 'Thomas', lang: 'fr-FR' },
      { name: 'Jacques', lang: 'fr-FR' },
      { name: 'Flo (français (France))', lang: 'fr-FR' },
      { name: 'Amélie', lang: 'fr-CA' },
    ]
    expect(pickVoice(mac, 'fr-FR', 'female')?.name).toBe('Amélie')
    expect(pickVoice(mac.slice(0, 3), 'fr-FR', 'female')?.name).toMatch(/^Flo/)
    expect(pickVoice([...mac, { name: 'Audrey (Premium)', lang: 'fr-FR' }], 'fr-FR', 'female')?.name).toBe('Audrey (Premium)')
  })
})

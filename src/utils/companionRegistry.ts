import {
  type Live2DAdapterProfile,
  NENE_BUILTIN_PROFILE,
  NATSUME_BUILTIN_PROFILE,
  validateAdapterProfile,
} from '../live2d/adapterProfile.ts'
import {
  CHARACTERS,
  DEFAULT_LIVE2D_OUTFIT,
  DEFAULT_NATSUME_OUTFIT,
  LIVE2D_OUTFITS,
  NATSUME_OUTFITS,
  type CharacterConfig,
} from '../config/characters.ts'

export const DEFAULT_COMPANION_CHARACTER_ID = 'nene'

export interface CompanionOutfitDefinition {
  id: string
  label: string
  expression?: string
}

export interface CompanionCharacterDefinition {
  id: string
  name: string
  shortName: string
  defaultAvatarId: string
  presentation?: CharacterConfig
  emotionProfileId?: string
  personaPrompt?: string
  voiceId?: string
  tags?: string[]
}

export interface CompanionAvatarDefinition {
  id: string
  characterId: string
  name: string
  modelPath: string
  version: string
  profileId: string
  defaultOutfitId?: string
  outfits?: readonly CompanionOutfitDefinition[]
  expressions?: readonly { id: string; label: string; parameterIds?: readonly string[] }[]
  thumbnailUrl?: string
  license?: {
    author?: string
    terms?: string
  }
}

export interface CompanionUserState {
  characterId: string
  selectedAvatarId: string
  affection: number
  lastSessionAt?: number
  draftMessage?: string
  bubblePosition?: { x: number; y: number }
}

const characters = new Map<string, CompanionCharacterDefinition>()
const avatars = new Map<string, CompanionAvatarDefinition>()
const profiles = new Map<string, Live2DAdapterProfile>()

function initBuiltins(): void {
  const nene = CHARACTERS.nene
  characters.set('nene', {
    id: nene.id,
    name: nene.name,
    shortName: '宁宁',
    defaultAvatarId: 'avatar-nene-default',
    presentation: nene,
    emotionProfileId: 'nene',
    voiceId: nene.voice,
    tags: ['studio', 'protagonist'],
  })
  avatars.set('avatar-nene-default', {
    id: 'avatar-nene-default',
    characterId: 'nene',
    name: '默认立绘',
    modelPath: '/assets/live2d-current/nene/nene.model3.json',
    version: '1.0.0',
    profileId: NENE_BUILTIN_PROFILE.profileId,
    defaultOutfitId: DEFAULT_LIVE2D_OUTFIT,
    outfits: LIVE2D_OUTFITS,
  })
  profiles.set(NENE_BUILTIN_PROFILE.profileId, NENE_BUILTIN_PROFILE)

  const natsume = CHARACTERS.natsume
  characters.set('natsume', {
    id: natsume.id,
    name: natsume.name,
    shortName: '夏目',
    defaultAvatarId: 'avatar-natsume-default',
    presentation: natsume,
    emotionProfileId: 'natsume',
    voiceId: natsume.voice,
    tags: ['studio', 'protagonist'],
  })
  avatars.set('avatar-natsume-default', {
    id: 'avatar-natsume-default',
    characterId: 'natsume',
    name: '默认立绘',
    modelPath: '/assets/live2d-current/natsume/natsume.model3.json',
    version: '1.0.0',
    profileId: NATSUME_BUILTIN_PROFILE.profileId,
    defaultOutfitId: DEFAULT_NATSUME_OUTFIT,
    outfits: NATSUME_OUTFITS,
  })
  profiles.set(NATSUME_BUILTIN_PROFILE.profileId, NATSUME_BUILTIN_PROFILE)
}

initBuiltins()

export function getCompanionCharacter(id: string): CompanionCharacterDefinition | undefined {
  return characters.get(id)
}

export function listCompanionCharacters(): CompanionCharacterDefinition[] {
  return Array.from(characters.values())
}

/** Characters that have enough presentation metadata to appear in production UI. */
export function listCompanionUiCharacters(): CompanionCharacterDefinition[] {
  return listCompanionCharacters().filter(character => Boolean(character.presentation))
}

export function listCompanionCharacterIds(): string[] {
  return listCompanionUiCharacters().map(character => character.id)
}

export function isCompanionCharacterId(value: unknown): value is string {
  return typeof value === 'string' && characters.has(value)
}

export function getCompanionCharacterConfig(id: string): CharacterConfig | undefined {
  return characters.get(id)?.presentation
}

export function registerCompanionCharacter(character: CompanionCharacterDefinition): void {
  if (!character.id || typeof character.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(character.id)) {
    throw new Error('Invalid companion character ID')
  }
  if (!character.name || typeof character.name !== 'string') {
    throw new Error('Invalid companion character name')
  }
  if (!character.shortName || typeof character.shortName !== 'string') {
    throw new Error('shortName is required')
  }
  if (!character.defaultAvatarId || typeof character.defaultAvatarId !== 'string') {
    throw new Error('defaultAvatarId is required')
  }
  if (character.presentation && (character.presentation.id !== character.id
    || character.presentation.name !== character.name
    || (character.voiceId && character.presentation.voice !== character.voiceId))) {
    throw new Error('Companion presentation identity must match its registry definition')
  }
  characters.set(character.id, character)
}

export function getCompanionAvatar(avatarId: string): CompanionAvatarDefinition | undefined {
  return avatars.get(avatarId)
}

export function listCompanionAvatars(characterId?: string): CompanionAvatarDefinition[] {
  const all = Array.from(avatars.values())
  return characterId ? all.filter(a => a.characterId === characterId) : all
}

export function registerCompanionAvatar(
  avatar: CompanionAvatarDefinition,
  profile?: Live2DAdapterProfile,
): void {
  if (!avatar.id || typeof avatar.id !== 'string') {
    throw new Error('Invalid companion avatar ID')
  }
  if (!avatar.characterId || !characters.has(avatar.characterId)) {
    throw new Error(`Companion avatar references unknown characterId: "${avatar.characterId}"`)
  }
  if (!avatar.profileId || typeof avatar.profileId !== 'string') {
    throw new Error('profileId is required on avatar')
  }
  const targetProfile = profile || profiles.get(avatar.profileId)
  if (!targetProfile) {
    throw new Error(`Companion avatar references unknown profileId: "${avatar.profileId}"`)
  }
  if (targetProfile.profileId !== avatar.profileId || targetProfile.avatarId !== avatar.id) {
    throw new Error('Adapter profile identity must match its avatar')
  }
  if (profile) {
    const { valid, errors } = validateAdapterProfile(profile)
    if (!valid) {
      throw new Error(`Invalid adapter profile: ${errors.join(', ')}`)
    }
    profiles.set(profile.profileId, profile)
  }
  avatars.set(avatar.id, avatar)
}

export function getCompanionProfile(profileId: string): Live2DAdapterProfile | undefined {
  return profiles.get(profileId)
}

export function registerCompanionProfile(profile: Live2DAdapterProfile): void {
  const { valid, errors } = validateAdapterProfile(profile)
  if (!valid) {
    throw new Error(`Invalid adapter profile: ${errors.join(', ')}`)
  }
  const avatar = avatars.get(profile.avatarId)
  if (!avatar || avatar.profileId !== profile.profileId) {
    throw new Error('Adapter profile must reference its registered avatar')
  }
  profiles.set(profile.profileId, profile)
}

export function resolveCompanionAvatar(
  characterId: string,
  avatarId?: string,
): { character: CompanionCharacterDefinition; avatar: CompanionAvatarDefinition; profile: Live2DAdapterProfile } | null {
  const character = characters.get(characterId)
  if (!character) return null

  const targetAvatarId = avatarId || character.defaultAvatarId
  const avatar = avatars.get(targetAvatarId)
  if (!avatar || avatar.characterId !== characterId) return null

  const profile = profiles.get(avatar.profileId)
  if (!profile || profile.avatarId !== avatar.id) return null

  return { character, avatar, profile }
}

export function getCompanionDefaultOutfit(characterId: string): string {
  const resolved = resolveCompanionAvatar(characterId)
  return resolved?.avatar.defaultOutfitId || ''
}

export function listCompanionOutfits(characterId: string): readonly CompanionOutfitDefinition[] {
  return resolveCompanionAvatar(characterId)?.avatar.outfits || []
}

export function normalizeCompanionOutfit(characterId: string, value: unknown): string {
  const outfits = listCompanionOutfits(characterId)
  const candidate = typeof value === 'string' ? value.trim() : ''
  return outfits.some(outfit => outfit.id === candidate)
    ? candidate
    : getCompanionDefaultOutfit(characterId)
}

/** Reset helper for test isolation */
export function resetCompanionRegistryForTesting(): void {
  characters.clear()
  avatars.clear()
  profiles.clear()
  initBuiltins()
}

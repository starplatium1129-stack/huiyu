import {
  type Live2DAdapterProfile,
  NENE_BUILTIN_PROFILE,
  NATSUME_BUILTIN_PROFILE,
  validateAdapterProfile,
} from '@/live2d/adapterProfile'

export interface CompanionCharacterDefinition {
  id: string
  name: string
  defaultAvatarId: string
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
  characters.set('nene', {
    id: 'nene',
    name: '绫地宁宁',
    defaultAvatarId: 'avatar-nene-default',
    tags: ['studio', 'protagonist'],
  })
  avatars.set('avatar-nene-default', {
    id: 'avatar-nene-default',
    characterId: 'nene',
    name: '默认立绘',
    modelPath: '/live2d/nene/nene.model3.json',
    version: '1.0.0',
    profileId: NENE_BUILTIN_PROFILE.profileId,
  })
  profiles.set(NENE_BUILTIN_PROFILE.profileId, NENE_BUILTIN_PROFILE)

  characters.set('natsume', {
    id: 'natsume',
    name: '四季夏目',
    defaultAvatarId: 'avatar-natsume-default',
    tags: ['studio', 'protagonist'],
  })
  avatars.set('avatar-natsume-default', {
    id: 'avatar-natsume-default',
    characterId: 'natsume',
    name: '默认立绘',
    modelPath: '/live2d/natsume/natsume.model3.json',
    version: '1.0.0',
    profileId: NATSUME_BUILTIN_PROFILE.profileId,
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

export function registerCompanionCharacter(character: CompanionCharacterDefinition): void {
  if (!character.id || typeof character.id !== 'string') {
    throw new Error('Invalid companion character ID')
  }
  if (!character.name || typeof character.name !== 'string') {
    throw new Error('Invalid companion character name')
  }
  if (!character.defaultAvatarId || typeof character.defaultAvatarId !== 'string') {
    throw new Error('defaultAvatarId is required')
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
  if (!profile) return null

  return { character, avatar, profile }
}

/** Reset helper for test isolation */
export function resetCompanionRegistryForTesting(): void {
  characters.clear()
  avatars.clear()
  profiles.clear()
  initBuiltins()
}

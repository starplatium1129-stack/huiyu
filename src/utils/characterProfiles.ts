import type { CharacterIdentity, CharacterPortrait, CharacterLora, CharacterProfile, CharacterScene } from '../types/character'
export type { CharacterIdentity, CharacterPortrait, CharacterLora, CharacterProfile, CharacterScene } from '../types/character'

import type { Scene } from '@/stores/sceneStore'
export { popularPortraitSrc, isPopularPortraitPending } from './popularPortraitSource.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function parseIdentity(value: unknown): CharacterIdentity | undefined {
  if (typeof value === 'string') return value.trim() ? { role: value.trim() } : undefined
  if (!isRecord(value)) return undefined
  const identity = {
    role: optionalString(value.role),
    age: optionalString(value.age),
    occupation: optionalString(value.occupation),
    faction: optionalString(value.faction),
  }
  return Object.values(identity).some(Boolean) ? identity : undefined
}

function parsePortrait(value: unknown): CharacterPortrait | undefined {
  if (!isRecord(value)) return undefined
  const portrait = {
    image: optionalString(value.image),
    alt: optionalString(value.alt),
  }
  return portrait.image || portrait.alt ? portrait : undefined
}

function parseLora(value: unknown): CharacterLora | undefined {
  if (!isRecord(value)) return undefined
  const triggerWords = stringList(value.trigger_words)
  const recommendedScenes = stringList(value.recommended_scene)
  const name = optionalString(value.name)
  if (!name && !triggerWords.length && !recommendedScenes.length) return undefined
  return {
    name,
    trigger_words: triggerWords,
    recommended_scene: recommendedScenes,
  }
}

export function parseCharacterProfiles(value: unknown): CharacterProfile[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.flatMap((item): CharacterProfile[] => {
    if (!isRecord(item)) return []
    const id = optionalString(item.id)
    const name = optionalString(item.name)
    if (!id || !name || seen.has(id)) return []
    seen.add(id)
    return [{
      id,
      name,
      type: optionalString(item.type),
      icon: optionalString(item.icon) ?? '',
      source: optionalString(item.source) ?? '',
      alias: stringList(item.alias),
      voice: optionalString(item.voice) ?? optionalString(item.speech) ?? '',
      tags: stringList(item.tags),
      bg_story: optionalString(item.bg_story) ?? '',
      personality: stringList(item.personality),
      likes: stringList(item.likes),
      identity: parseIdentity(item.identity),
      portrait: parsePortrait(item.portrait),
      lora: parseLora(item.lora),
    }]
  })
}

export function parseCharacterScenes(value: Scene[]): CharacterScene[] {
  return value.flatMap((scene): CharacterScene[] => {
    if (
      typeof scene.id !== 'string'
      || typeof scene.title !== 'string'
      || typeof scene.char !== 'string'
    ) return []
    return [{
      id: scene.id,
      title: scene.title,
      story: typeof scene.story === 'string' ? scene.story : '',
      char: scene.char,
    }]
  })
}

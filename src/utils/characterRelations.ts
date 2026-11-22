import type { CharacterRelation, CharacterRelationGraph, RelationPerson } from '@/types/characterRelations'
import type { CharacterProfile } from '@/types/character'
import { franchiseKey } from './franchiseLabel'

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
const normalizeName = (value: string) => value.normalize('NFKC').replace(/[\s·・]+/g, '').toLowerCase()
function evidence(value: unknown): value is CharacterRelation['evidence'] {
  if (!object(value) || !text(value.title) || !text(value.url)) return false
  try { return new URL(value.url).protocol === 'https:' } catch { return false }
}

/** Reject the entire malformed graph rather than silently presenting incomplete relationships. */
export function parseCharacterRelationGraph(value: unknown): CharacterRelationGraph | null {
  if (!object(value) || value.version !== 1 || !text(value.work) || !Array.isArray(value.people) || !Array.isArray(value.relations)) return null
  const people: RelationPerson[] = [], relations: CharacterRelation[] = [], ids = new Set<string>()
  for (const person of value.people) {
    if (!object(person) || !text(person.id) || !text(person.name) || ids.has(person.id)
      || !Array.isArray(person.aliases) || !person.aliases.every(text)
      || (person.characterId !== undefined && !text(person.characterId))
      || (person.role !== undefined && !text(person.role))
      || (person.summary !== undefined && !text(person.summary))
      || (person.avatar !== undefined && !text(person.avatar))) return null
    ids.add(person.id)
    people.push({ id: person.id, name: person.name, aliases: [...person.aliases], characterId: person.characterId as string | undefined,
      role: person.role as string | undefined, summary: person.summary as string | undefined, avatar: person.avatar as string | undefined })
  }
  const relationIds = new Set<string>()
  for (const relation of value.relations) {
    if (!object(relation) || !text(relation.id) || relationIds.has(relation.id)
      || !text(relation.source) || !text(relation.target) || !ids.has(relation.source) || !ids.has(relation.target) || relation.source === relation.target
      || !text(relation.label) || !text(relation.description) || !text(relation.stage)
      || typeof relation.directed !== 'boolean' || typeof relation.spoiler !== 'boolean' || !evidence(relation.evidence)) return null
    relationIds.add(relation.id)
    relations.push({ id: relation.id, source: relation.source, target: relation.target, label: relation.label,
      description: relation.description, stage: relation.stage, directed: relation.directed, spoiler: relation.spoiler,
      evidence: { ...relation.evidence } })
  }
  return { version: 1, work: value.work, people, relations }
}

export function indexRelationProfiles(profiles: CharacterProfile[]) {
  const ids = new Map<string, CharacterProfile>()
  const works = new Map<string, Map<string, number>>()
  profiles.forEach((profile, index) => {
    ids.set(profile.id, profile)
    const work = franchiseKey(profile.source)
    let names = works.get(work)
    if (!names) { names = new Map(); works.set(work, names) }
    for (const name of [profile.name, ...profile.alias]) {
      const key = normalizeName(name)
      if (!names.has(key)) names.set(key, index)
    }
  })
  return (person: RelationPerson, work: string): CharacterProfile | undefined => {
    const bound = ids.get(person.characterId || person.id)
    if (bound) return bound
    const names = works.get(franchiseKey(work))
    if (!names) return undefined
    // Older unbound people match the first catalog profile sharing a name in this work.
    let first = profiles.length
    for (const name of [person.name, ...person.aliases]) first = Math.min(first, names.get(normalizeName(name)) ?? first)
    return profiles[first]
  }
}

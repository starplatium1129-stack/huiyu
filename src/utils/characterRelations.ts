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
      || (person.characterId !== undefined && !text(person.characterId))) return null
    ids.add(person.id)
    people.push({ id: person.id, name: person.name, aliases: [...person.aliases], characterId: person.characterId as string | undefined })
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

export function relationProfile(person: RelationPerson, work: string, profiles: CharacterProfile[]): CharacterProfile | undefined {
  const bound = profiles.find(profile => profile.id === (person.characterId || person.id))
  if (bound) return bound
  // A future profile can resolve a placeholder by its exact original name within the same work.
  const names = new Set([person.name, ...person.aliases].map(normalizeName))
  return profiles.find(profile => franchiseKey(profile.source) === franchiseKey(work)
    && [profile.name, ...profile.alias].some(name => names.has(normalizeName(name))))
}

export interface RelationPerson {
  id: string
  name: string
  aliases: string[]
  characterId?: string
}

export interface CharacterRelation {
  id: string
  source: string
  target: string
  label: string
  description: string
  directed: boolean
  spoiler: boolean
  stage: string
  evidence: { title: string; url: string }
}

/** One work's graph is owned by one catalog profile; participants retain stable IDs without profiles. */
export interface CharacterRelationGraph {
  version: 1
  work: string
  people: RelationPerson[]
  relations: CharacterRelation[]
}

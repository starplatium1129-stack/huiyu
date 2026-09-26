import type { ArtworkRecord } from '@/types/artwork'
import type { HistoryEntry } from '@/types/promptHistory'
const text = (value: unknown) => typeof value === 'string' ? value : ''
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0
const nullable = (value: unknown) => typeof value === 'string' && value ? value : null
const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

/** Complete the existing history view contract without changing string artwork IDs. */
export function taskResultHistory(record: ArtworkRecord): HistoryEntry & ArtworkRecord {
  return { ...record, id: record.id, timestamp: typeof record.timestamp === 'number' ? record.timestamp : Date.parse(String(record.timestamp)) || 0,
    character: text(record.character), scene: nullable(record.scene), sceneTitle: nullable(record.sceneTitle),
    story: text(record.story), prompt: text(record.prompt), negative: text(record.negative), seed: number(record.seed),
    emotion: strings(record.emotion), shot: nullable(record.shot), lighting: nullable(record.lighting), composition: nullable(record.composition), colorMood: nullable(record.colorMood),
    manual_tags: strings(record.manual_tags), lora: nullable(record.lora), cfg: typeof record.cfg === 'string' ? record.cfg : number(record.cfg),
    steps: typeof record.steps === 'string' ? record.steps : number(record.steps), sampler: text(record.sampler), scheduler: text(record.scheduler),
    checkpoint: text(record.checkpoint), size: text(record.size), width: number(record.width) || null, height: number(record.height) || null,
    engine: record.engine === 'anima' || record.engine === 'krea2' ? record.engine : 'sd',
    subject: record.subject === 'popular' ? 'popular' : 'studio',
    rating: Object.fromEntries(Object.entries(record.rating || {}).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]))),
    favorite: record.favorite === true, notes: text(record.notes), image_id: text(record.image_id), image_url: text(record.image_url),
    version: number(record.version) || 1, parent_id: typeof record.parent_id === 'string' || typeof record.parent_id === 'number' ? record.parent_id : null, project: text(record.project),
  }
}

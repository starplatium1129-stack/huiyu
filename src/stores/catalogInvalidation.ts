import type { CatalogReceipt } from '../api/catalogApi'

export function catalogInvalidation(diffs: CatalogReceipt['diffs']) {
  const metadata = new Set<string>(), shards = new Set<'nene' | 'natsume' | 'shared' | 'core'>(), blueprints = new Set<string>()
  for (const diff of diffs) {
    if (diff.kind === 'character') {
      metadata.add('characters.json'); metadata.add('popular-characters.json')
    } else if (diff.kind === 'outfit') metadata.add('popular-characters.json')
    else if (diff.kind === 'blueprint') {
      for (const record of [diff.before, diff.after]) {
        const id = record && !Array.isArray(record.data) ? record.data.characterId : undefined
        if (typeof id === 'string') blueprints.add(id)
      }
    } else if (diff.kind === 'scene') {
      shards.add('core')
      for (const record of [diff.before, diff.after]) {
        const id = record && !Array.isArray(record.data) ? record.data.char : undefined
        if (id === 'nene' || id === 'natsume') shards.add(id)
        else if (record) shards.add('shared')
      }
    } else if (diff.kind === 'document') {
      metadata.add(diff.id + '.json')
      if (diff.id === 'curation') shards.add('core')
    }
  }
  return { metadata, shards, blueprints }
}

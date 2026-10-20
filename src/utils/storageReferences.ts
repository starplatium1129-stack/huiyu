import type { collectLiveLocalSettings } from './storageKeys.ts'

/** Conservatively protect every stored image ID mentioned by persisted drafts, projects or trash. */
export function collectImageReferences(values: unknown[]): Set<string> {
  const references = new Set<string>()
  const visit = (value: unknown) => {
    if (typeof value === 'string') references.add(value)
    else if (Array.isArray(value)) value.forEach(visit)
    else if (value && typeof value === 'object') Object.values(value).forEach(visit)
  }
  values.forEach(visit)
  return references
}

/** Load only during cleanup, retaining the caller's lock and source guard. */
export async function readBrowserImageReferences(storage: Parameters<typeof collectLiveLocalSettings>[0], session: Pick<Storage, 'getItem'>, check: () => void): Promise<unknown[]> {
  check()
  const reader = await import('./localImageReferences.ts')
  check()
  return [...reader.readLocalImageReferences(storage), ...reader.readSessionImageReferences(session)]
}

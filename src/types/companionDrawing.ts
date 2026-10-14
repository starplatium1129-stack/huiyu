export interface CompanionDrawingDraft {
  path: string
  character: string
  description: string
}

export function isCompanionDrawingPath(value: unknown): value is string {
  return typeof value === 'string' && /^generated-images\/companion_[\w%!'()*~-]{1,100}_\d{10,17}\.json$/.test(value)
}

/** Persist references, never raw model output or executable paths. */
export function parseCompanionDrawingDraft(value: unknown): CompanionDrawingDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  if (!isCompanionDrawingPath(item.path)
    || typeof item.character !== 'string' || !item.character.trim() || item.character.length > 80
    || typeof item.description !== 'string' || !item.description.trim() || item.description.length > 1200) return null
  return { path: item.path, character: item.character, description: item.description }
}

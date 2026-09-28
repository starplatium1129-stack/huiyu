/** Recommendation input never needs image bytes, recipes or prompt text. */
export function preferenceHistoryRows(value: unknown): unknown[] {
  if (!Array.isArray(value)) return []
  return value.filter(entry => entry && typeof entry === 'object')
    .map(({ id, scene, character, favorite, timestamp }) => structuredClone({ id, scene, character, favorite, timestamp }))
}

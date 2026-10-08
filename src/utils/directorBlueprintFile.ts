import { downloadBlob } from './downloadBlob'

/** Shared by normal export and the unsaved-draft recovery action. */
export function exportDirectorBlueprint(data: Record<string, unknown>): void {
  const payload = { ...data, schema: 'aics-director-blueprint-v1', exportedAt: Date.now() }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16)
  downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }), `aics-blueprint-${stamp}.json`)
}

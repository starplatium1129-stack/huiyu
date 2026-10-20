import type { DirectorControlKey, DirectorControlSources, DirectorControlValues } from '../types/promptDirector.ts'

export const DIRECTOR_CONTROL_KEYS = ['shot', 'lighting', 'composition', 'colorMood'] as const

/** Explicit ownership wins even when a user selected the inherited value or cleared it. */
export function isManualDirectorValue(
  sources: Readonly<DirectorControlSources> | null | undefined,
  key: DirectorControlKey,
  value: string | null | undefined,
  inheritedValue: string | null | undefined,
): boolean {
  const source = sources?.[key]
  if (source) return source === 'manual'
  return Boolean(value && value !== inheritedValue)
}

/** Validate persisted input and detach it from the caller's mutable object. */
export function normalizeDirectorSources(value: unknown): DirectorControlSources {
  const result: DirectorControlSources = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  const input = value as Record<string, unknown>
  for (const key of DIRECTOR_CONTROL_KEYS) {
    const source = input[key]
    if (source === 'scene' || source === 'manual') result[key] = source
  }
  return result
}

export function sceneDirectorSources(): DirectorControlSources {
  return { shot: 'scene', lighting: 'scene', composition: 'scene', colorMood: 'scene' }
}

/** Old drafts/history infer ownership once on restore; live state always keeps explicit sources. */
export function restoreDirectorSources(
  sources: unknown,
  values: DirectorControlValues,
  inherited: DirectorControlValues = {},
): DirectorControlSources {
  const result = normalizeDirectorSources(sources)
  for (const key of DIRECTOR_CONTROL_KEYS) {
    result[key] = isManualDirectorValue(result, key, values[key], inherited[key]) ? 'manual' : 'scene'
  }
  return result
}

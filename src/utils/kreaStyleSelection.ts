import type { KreaStyleLoraSelection } from '@/types/generation'
import type { AnimaGenerationState } from '@/types/anima'
import { kreaStyleLoraLabel } from '../config/kreaStyleLoraLabels.ts'

type StyleForm = Pick<AnimaGenerationState, 'styleLoraId' | 'styleLoraStrength' | 'secondaryStyleLoraId' | 'secondaryStyleLoraStrength'>

function style(id: unknown, strength: unknown): KreaStyleLoraSelection | null {
  if (typeof id !== 'string' || !id.trim()) return null
  const weight = strength ?? 1
  return typeof weight === 'number' && Number.isFinite(weight) && weight >= -2 && weight <= 2 ? { id, strength: weight } : null
}

/** Old recipes stored only the first ID. An explicit empty list means no styles. */
export function readKreaStyles(value: unknown): KreaStyleLoraSelection[] {
  if (!value || typeof value !== 'object') return []
  const fields = value as Record<string, unknown>
  if (!Array.isArray(fields.styleLoras)) {
    const first = style(fields.styleLoraId, fields.styleLoraStrength)
    return first ? [first] : []
  }
  const rows: KreaStyleLoraSelection[] = []
  for (const item of fields.styleLoras.slice(0, 2)) {
    const row = item && typeof item === 'object' ? style(item.id, item.strength) : null
    if (row && !rows.some(other => other.id === row.id)) rows.push(row)
  }
  return rows
}

export function kreaStylesFromState(state: Partial<StyleForm>): KreaStyleLoraSelection[] {
  const first = style(state.styleLoraId, state.styleLoraStrength)
  if (!first) return []
  const second = style(state.secondaryStyleLoraId, state.secondaryStyleLoraStrength)
  return second && second.id !== first.id ? [first, second] : [first]
}

export function kreaStyleState(rows: readonly KreaStyleLoraSelection[]): StyleForm {
  return { styleLoraId: rows[0]?.id ?? '', styleLoraStrength: rows[0]?.strength ?? 1,
    secondaryStyleLoraId: rows[1]?.id ?? '', secondaryStyleLoraStrength: rows[1]?.strength ?? 1 }
}

export function kreaStyleFields(rows: KreaStyleLoraSelection[]) {
  const first = rows[0]
  return first ? { styleLoraId: first.id, styleLoraStrength: first.strength, styleLoras: rows } : {}
}

export function kreaStyleSnapshot(value: unknown) {
  const rows = readKreaStyles(value)
  return { styleLoraId: rows[0]?.id ?? null, ...(rows.length ? { styleLoraStrength: rows[0].strength } : {}), styleLoras: rows }
}

export function describeKreaStyles(rows: readonly KreaStyleLoraSelection[]): string {
  return rows.map(row => `${kreaStyleLoraLabel(row.id)} × ${row.strength}`).join(' ＋ ')
}

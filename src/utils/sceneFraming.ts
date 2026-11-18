import { WIDE_TOKENS, CLOSE_TOKENS, MID_TOKENS } from './promptFramingTokens.ts'
import { normalizeKey, splitBreaks, tokenize } from './promptPrimitives.ts'
import type { PromptPart } from './promptPolicyTypes.ts'

export interface PromptScene {
  compositionIntent?: import('../types/sceneBlueprint').BlueprintCompositionIntent
  char?: string
  prompt?: string
  tags?: string[]
  lora?: string
  category?: string
  rating?: string
  mature?: boolean
  negative?: string
  camera?: unknown
}

/** POV/俯仰角与景别可并存；角度不能使明确的近景/全身约束失效。 */
export function framingShot(shot: string | null | undefined, camera: unknown): string | null | undefined {
  if (!shot || ['close', 'detail', 'medium', 'wide'].includes(shot)) return shot
  const text = String(camera || '').toLowerCase()
  if (/特写|近景|close[-_ ]?up|portrait/.test(text)) return 'close'
  if (/全身|远景|wide[-_ ]?shot|full[-_ ]?body/.test(text)) return 'wide'
  if (/半身|中景|medium[-_ ]?shot/.test(text)) return 'medium'
  return shot
}

export function resolveFramingMode(shot?: string | null, manualTags: string[] = []): '' | 'wide' | 'close' | 'mid' {
  if (shot === 'wide') return 'wide'
  if (shot === 'close' || shot === 'detail') return 'close'
  if (shot === 'medium') return 'mid'
  if (shot) return ''
  const keys = manualTags.map(normalizeKey)
  if (keys.some(k => WIDE_TOKENS.has(k))) return 'wide'
  if (keys.some(k => CLOSE_TOKENS.has(k))) return 'close'
  if (keys.some(k => MID_TOKENS.has(k))) return 'mid'
  return ''
}

/** 同一 prompt 里不能既 close_up 又 full_body：保留当前镜头，剔除冲突项 */
export function filterFraming(text: string, shot?: string | null): string {
  const mode = resolveFramingMode(shot)
  if (!mode) return text
  const drop = mode === 'wide'
    ? new Set([...CLOSE_TOKENS, ...MID_TOKENS])
    : mode === 'close'
      ? new Set([...WIDE_TOKENS, ...MID_TOKENS])
      : new Set([...WIDE_TOKENS, ...CLOSE_TOKENS])
  return splitBreaks(text)
    .map(section => tokenize(section).filter(token => !drop.has(normalizeKey(token))).join(', '))
    .filter(Boolean)
    .join(' BREAK ')
}

export function applyFraming(parts: PromptPart[], shot?: string | null): PromptPart[] {
  const mode = resolveFramingMode(shot)
  if (!mode) return parts
  return parts.map(part => {
    if (part.cls === 'n' || part.cls === 'l') return part
    return { ...part, text: filterFraming(part.text, shot) }
  }).filter(part => part.text.trim())
}

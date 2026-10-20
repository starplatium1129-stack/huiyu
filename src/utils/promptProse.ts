/** Shared text cleanup; model-specific token conversion stays in its renderer. */
export function cleanPromptProse(value: string): string {
  return value.replace(/<lora:[^>]+>/gi, '').replace(/\bBREAK\b/g, ', ').replace(/\s+/g, ' ').trim()
}

export function promptSentence(value: string): string {
  const text = cleanPromptProse(value)
  if (!text) return ''
  const body = text.replace(/[.!?]+$/, '')
  return `${body.charAt(0).toUpperCase()}${body.slice(1)}.`
}

/** Current input contract accepts ASCII visual descriptions; this is not a model language claim. */
export function plainEnglish(value: unknown): string {
  const text = String(value || '').trim()
  return text && /^[\x20-\x7e]+$/.test(text) ? text : ''
}

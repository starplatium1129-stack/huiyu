/** Shared token and rating operations; no policy, diagnostics or platform dependencies. */
export function normalizeKey(token: string): string {
  return String(token || '')
    .replace(/^\s*\[NEG\]\s*/i, '')
    .replace(/^\s*<lora:|>\s*$/gi, '')
    .replace(/^\s*\(+|\)+\s*$/g, '')
    .replace(/:\s*-?\d+(?:\.\d+)?\s*$/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s\-/]+/g, '_')
}

export function tokenize(text: string): string[] {
  return String(text || '').split(',').map(token => token.trim()).filter(Boolean)
}

export function splitBreaks(text: string): string[] {
  return String(text || '')
    .replace(/\s*,?\s*\bBREAK\b\s*,?\s*/g, '\u0000BREAK\u0000')
    .split('\u0000BREAK\u0000')
    .map(section => section.trim())
}

export function sceneRating(scene: unknown): 'R18' | 'R15' | 'ALL' {
  const s = (scene ?? {}) as { rating?: unknown; mature?: unknown }
  const rating = String(s.rating || '').toUpperCase()
  if (rating === 'R18' || s.mature) return 'R18'
  if (rating === 'R15') return 'R15'
  return 'ALL'
}

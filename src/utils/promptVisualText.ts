import { QUALITY_WORDS } from './promptDiagnostics.ts'

/** Remove literal fire metaphors while preserving the authored body part. */
export function sanitizeVisualArtifacts(text: string): string {
  return text
    .replace(/\b(?:ears?\s+(?:burn(?:ing)?|flam(?:ing)?)(?:\s+completely)?(?:\s+bright)?(?:\s+red)?|(?:burn(?:ing)?|flam(?:ing)?)\s+(?:bright\s+)?red\s+ears?)\b/gi, 'flushed ears')
    .replace(/\bburning_red_ears\b/gi, 'red ears')
    .replace(/\bburning\s+(?:face|cheeks?)\b/gi, 'flushed cheeks')
}

const KREA_BANNED_WORDS_RE = new RegExp(`\\b(?:${QUALITY_WORDS.map(word => word.replace(/_/g, '[ _-]+')).join('|')}|score[ _-]*\\d+)\\b`, 'gi')

/** All Krea text, including tag-derived fragments, passes this compiler boundary. */
export function sanitizeKreaProse(value: string): string {
  return sanitizeVisualArtifacts(String(value || '')
    .replace(/<lora:[^>]+>/gi, '')
    .replace(/\bBREAK\b/g, ', ')
    .replace(/\(([^()\n]*[a-z][^()\n]*):\s*-?\d+(?:\.\d+)?\s*\)/gi, '$1')
    .replace(/\\([()])/g, '$1')
    .replace(KREA_BANNED_WORDS_RE, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim())
}

export function sanitizeKreaTokens(tokens: readonly string[]): string[] {
  return tokens.map(sanitizeKreaProse).filter(Boolean)
}

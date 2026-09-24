/** Literal tag names are not prompt weighting syntax. Only registered names are escaped. */
const LITERAL_SUFFIX = /^[^()[\]<>\n,]+[ _]\([^()\n,]+\)(?:[ _]\([^()\n,]+\))*$/
const NUMERIC_WEIGHT = /:\s*-?\d+(?:\.\d+)?\s*\)/

function rawLiteralTag(value: string): string {
  const raw = value.trim().replace(/\\([()])/g, '$1')
  return LITERAL_SUFFIX.test(raw) && !NUMERIC_WEIGHT.test(raw) ? raw : ''
}

/** Idempotent on already escaped parentheses; never call this on an entire free-form prompt. */
export function escapeLiteralTagParentheses(tag: string): string {
  let result = ''
  let backslashes = 0
  for (const character of tag) {
    if ((character === '(' || character === ')') && backslashes % 2 === 0) result += '\\'
    result += character
    backslashes = character === '\\' ? backslashes + 1 : 0
  }
  return result
}

/** Preserve existing exact-token spelling when an already escaped prompt is compiled again. */
export function escapedLiteralExactTokens(tokens: readonly string[]): string[] {
  return [...new Set(tokens.map(rawLiteralTag).filter(Boolean).map(escapeLiteralTagParentheses))]
}

function matchLiteralTag(tag: string): string {
  return [...tag].map(character => {
    // Accept either raw or already escaped literal parentheses, without accepting a double escape.
    if (character === '(' || character === ')') return `(?:\\\\)?\\${character}`
    return character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }).join('')
}

/**
 * Escape known character names after engine spelling/weight processing. Both source underscore
 * tags and Anima's space spelling are accepted. Unregistered parentheses, outer (tag:weight),
 * BREAK, scores and prose are not interpreted or rewritten here.
 */
export function escapeKnownLiteralTags(text: string, literalTags: readonly string[]): string {
  const variants = [...new Set(literalTags.map(rawLiteralTag).filter(Boolean)
    .flatMap(tag => [tag, tag.replace(/_/g, ' ').replace(/\s+/g, ' ')]))]
    .sort((a, b) => b.length - a.length)
  let result = text
  for (const tag of variants) {
    const pattern = new RegExp(`(^|[^A-Za-z0-9_\\\\])(${matchLiteralTag(tag)})(?=$|[^A-Za-z0-9_])`, 'g')
    result = result.replace(pattern, (_match, prefix: string, name: string) =>
      prefix + escapeLiteralTagParentheses(name))
  }
  return result
}

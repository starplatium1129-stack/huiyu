// MIAOKA's BASE v1.0 recipe, Civitai version 3422319 (2026-10-22).
export const MOSS_QUALITY = 'masterpiece, best quality, very aesthetic, ultra-detailed, high contrast'
export const MOSS_NEGATIVE = 'extra toes, lowres, (bad), text, error, fewer, extra, missing, worst quality, jpeg artifacts, low quality, watermark, unfinished, displeasing, oldest, early, signature, artistic error, username, bad feet, scan, [abstract], english text, shiny hair'

export function compileMossPrompt(prompt: string, negative: string) {
  const text = prompt.trim()
  if (text.startsWith('{')) {
    let layout: unknown
    try { layout = JSON.parse(text) } catch { throw new Error('布局 JSON 无法解析，请检查引号、逗号和括号') }
    if (!layout || typeof layout !== 'object' || Array.isArray(layout)) throw new Error('布局须为 JSON 对象')
    // Layout is one intact input. Never prepend tags or rewrite coordinates.
    // Author-default text exclusions yield to an explicitly authored text item.
    const items = 'items' in layout ? layout.items : undefined
    const hasText = Array.isArray(items) && items.some(item => item && typeof item.text === 'string' && item.text.trim())
    const exclude = hasText && negative === MOSS_NEGATIVE
      ? negative.split(',').map(token => token.trim()).filter(token => token !== 'text' && token !== 'english text').join(', ')
      : negative
    return { prompt: text, negative: exclude.trim() }
  }
  const authored = new Set(text.split(',').map(token => token.trim().toLowerCase()))
  const quality = MOSS_QUALITY.split(', ').filter(token => !authored.has(token))
  return { prompt: [...quality, text].filter(Boolean).join(', '), negative: negative.trim() }
}

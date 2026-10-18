/** Only the frozen facts needed to observe and archive a retired SD job. */
export interface LegacySdResultInput {
  prompt: string
  lora?: string | string[]
  steps?: number
  hr_fix?: boolean
  hr_second_pass_steps?: number
}

/** Reconstruct the historical result label; no generation request is built. */
export function legacySdResultFacts(input: LegacySdResultInput) {
  let prompt = String(input.prompt || '')
  const names = input.lora ? (Array.isArray(input.lora) ? input.lora : String(input.lora).split(',')) : []
  const parsed = names.map(raw => {
    const value = String(raw || '').trim().replace(/^<lora:/i, '').replace(/>$/, '')
    const [name = '', rawWeight] = value.split(':')
    const weight = Number(rawWeight)
    return { name: name.trim(), weight: Number.isFinite(weight) ? weight : null }
  }).filter(item => item.name)
  const dual = parsed.length > 1 || (prompt.includes('ayachi_nene') && prompt.includes('shiki_natsume'))
  const tags = parsed.filter(item => !prompt.includes(`<lora:${item.name}`))
    .map(item => `<lora:${item.name}:${item.weight ?? (dual ? 0.62 : 0.8)}>`)
  if (tags.length) {
    const sections = prompt.replace(/\s*,?\s*\bBREAK\b\s*,?\s*/gi, '\u001e').split('\u001e')
      .map(section => section.trim().replace(/^,\s*|,\s*$/g, '')).filter(Boolean)
    if (sections.length < 2) prompt = [prompt, ...tags].filter(Boolean).join(', ')
    else {
      sections[0] = [sections[0], ...tags].filter(Boolean).join(', ')
      prompt = sections.join(' BREAK ')
    }
  }
  const loras = names.map(raw => {
    const match = String(raw).replace(/^<lora:/i, '').replace(/>$/, '').split(':')
    const name = match[0].trim()
    const id = name === 'ayachi_nene_v18_wd14' ? 'L_NENE_V18_WD14' : name === 'shiki_natsume_v18_wd14' ? 'L_NAT_V18_WD14' : ''
    const strength = match[1]?.trim() ? Number(match[1]) : undefined
    return id ? { id, strength: typeof strength === 'number' && Number.isFinite(strength) ? strength : 0.8 } : null
  }).filter((value): value is { id: string; strength: number } => Boolean(value))
  return { prompt, loras }
}

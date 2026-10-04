interface BlueprintLightSource {
  lighting?: string
  sceneTags?: readonly string[]
}

const IDS = new Set(['golden', 'window', 'back', 'moon', 'lantern', 'overcast'])
const TAG_LIGHTS: Record<string, string> = {
  'golden hour': 'golden', 'window light': 'window',
  backlight: 'back', backlighting: 'back', moonlight: 'moon',
  'warm light': 'lantern', 'warm lighting': 'lantern', overcast: 'overcast',
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Match authored light sources without replacing lamps, fire or daylight with a different source. */
export function inferBlueprintLighting(source: BlueprintLightSource): string | null {
  const light = normalize(source.lighting || '')
  // The saved selection ID remains stable; its prompt now means warm light only.
  if (IDS.has(light)) return light
  if (/\bmoon(?:light|lit)\b|月光|月色|冷月/.test(light)) return 'moon'
  if (/\bgolden hour\b|\bsunset\b|\bdusk\b|夕阳|夕照|落日|晚霞|黄昏|黄金时刻/.test(light)) return 'golden'
  if (/\bovercast\b|阴天|阴雨|阴云/.test(light)) return 'overcast'
  if (/\bbacklight(?:ing)?\b|\bbacklit\b|逆光|背光/.test(light)) return 'back'
  if (/\bwindow light\b|窗光|侧窗光/.test(light)) return 'window'
  if (TAG_LIGHTS[light]) return TAG_LIGHTS[light]
  if (light) return null
  for (const tag of source.sceneTags || []) {
    const id = TAG_LIGHTS[normalize(tag)]
    if (id) return id
  }
  return null
}

import type { SceneBlueprint } from '../types/sceneBlueprint'
import { existingBlueprintDecisions, inferBlueprintLighting } from './blueprintLighting.ts'

export interface PopularBlueprintDecision {
  shot: string | null
  lighting: string | null
  composition: string | null
  colorMood: string | null
  size: string
  /** 情绪摄影语法（v2）：按蓝图 mood 匹配的镜头语言（Anima 附加标签 + Krea 散文）。 */
  moodGrammar?: { tokens: string[]; prose: string }
}

const CAMERA_TO_SHOT: Record<string, string> = {
  closeup: 'close', 'close-up': 'close', close_up: 'close', close: 'close',
  'medium shot': 'medium', half_body: 'medium', medium: 'medium',
  'cowboy shot': 'medium', cowboy_shot: 'medium', cowboy: 'medium',
  'wide shot': 'wide', wide_shot: 'wide', full_body: 'wide', wide: 'wide',
  pov: 'pov', 'high angle': 'high', from_above: 'high', 'low angle': 'low',
  from_below: 'low', 'side view': 'side', looking_back: 'turn',
}

/** 蓝图 camera 字段漏网短语补映射。 */
const EXTRA_CAMERA_TO_SHOT: ReadonlyArray<readonly [RegExp, string]> = [
  [/cowboy (?:shot)?|cowboy_shot/, 'medium'],
  [/dynamic action (?:shot|angle)|action shot/, 'wide'],
  [/full body/, 'wide'],
  [/couch level|low level/, 'low'],
  [/three quarter/, 'medium'],
  [/upper body/, 'medium'],
  [/intimate (?:dramatic )?angle|dramatic intimate angle/, 'medium'],
  [/back[_ ](?:view|shot)/, 'medium'],
  [/front[_ ]view/, 'medium'],
]

/** 角度词优先于取景词，避免长景别短语覆盖刻意的高低机位。 */
const BLUEPRINT_ANGLE_RE: ReadonlyArray<readonly [RegExp, string]> = [
  [/low angle|from below/, 'low'],
  [/high angle|from above|overhead/, 'high'],
  [/\bpov\b|first-person|first person|主观/, 'pov'],
]

const MOOD_TO_COLOR: Record<string, string> = {
  warm: 'warmth', cozy: 'warmth', tender: 'warmth',
  calm: 'calm', serene: 'calm', quiet: 'calm', tranquil: 'calm',
  nostalgic: 'calm', wistful: 'calm',
  mystical: 'tension', mysterious: 'tension', melancholic: 'sad', sad: 'sad',
  lively: 'joy', hopeful: 'joy', lighthearted: 'joy',
}

const MOOD_CAMERA_GRAMMAR: ReadonlyArray<readonly [RegExp, { tokens: string[]; prose: string }]> = [
  [/温柔|治愈|暖|甜|tender|warm|healing|cozy/i,
    { tokens: ['soft_focus', 'blurred_background'],
      prose: 'Shot with an 85mm lens at shallow depth of field, a soft warm glow wrapping the subject.' }],
  [/孤独|寂|落寞|怅|lonely|solitary|melancho/i,
    { tokens: ['negative_space', 'scenery'],
      prose: 'Generous negative space and compressed distance emphasize her quiet solitude.' }],
  [/压迫|威压|凛|傲|凌厉|oppressive|domin|intimidat/i,
    { tokens: ['foreshortening', 'dutch_angle'],
      prose: 'A low aggressive angle with strong foreshortening bears down on the viewer.' }],
  [/神秘|幻|梦|妖|myst|dream|etherea/i,
    { tokens: ['lens_flare', 'light_particles'],
      prose: 'Ethereal lens flares and drifting light particles veil the scene in mystery.' }],
]

function blueprintAngleShot(cameraText: string): string | null {
  const text = String(cameraText || '').toLowerCase()
  if (!text) return null
  return BLUEPRINT_ANGLE_RE.find(([pattern]) => pattern.test(text))?.[1] ?? null
}

function matchMoodGrammar(mood: string): { tokens: string[]; prose: string } | undefined {
  const text = String(mood || '')
  if (!text) return undefined
  return MOOD_CAMERA_GRAMMAR.find(([pattern]) => pattern.test(text))?.[1]
}

function matchFirst(text: string, table: Record<string, string>): string | null {
  const lower = text.toLowerCase()
  const keys = Object.keys(table).sort((a, b) => b.length - a.length)
  for (const key of keys) {
    if (lower.includes(key)) return table[key]
  }
  return null
}

export function inferBlueprintDecisions(blueprint: SceneBlueprint | null): PopularBlueprintDecision {
  if (!blueprint) return { shot: null, lighting: null, composition: 'rule3', colorMood: null, size: '832x1216' }
  const hay = [blueprint.camera, blueprint.lighting, blueprint.mood, blueprint.promptProse, blueprint.sceneTags.join(', ')].join(' ').toLowerCase()
  const angleShot = blueprintAngleShot(blueprint.camera)
  const cameraText = String(blueprint.camera || '').toLowerCase()
  const prior = blueprint.adult ? existingBlueprintDecisions(blueprint) : null
  const shot = prior ? prior.shot : angleShot ?? matchFirst(cameraText, CAMERA_TO_SHOT)
    ?? EXTRA_CAMERA_TO_SHOT.find(([pattern]) => pattern.test(cameraText))?.[1]
    ?? matchFirst(hay, CAMERA_TO_SHOT)
  const lighting = prior ? prior.lighting : inferBlueprintLighting(blueprint)
  const colorMood = matchFirst(hay, MOOD_TO_COLOR)
  const moodGrammar = matchMoodGrammar(blueprint.mood)
  return {
    shot,
    lighting,
    composition: 'rule3',
    colorMood,
    size: blueprint.recommendedSize || '832x1216',
    moodGrammar,
  }
}

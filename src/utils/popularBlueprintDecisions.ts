import type { SceneBlueprint } from '../types/sceneBlueprint'
import { inferBlueprintLighting } from './blueprintLighting.ts'

export interface PopularBlueprintDecision {
  shot: string | null
  lighting: string | null
  composition: string | null
  colorMood: string | null
  size: string
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
  [/\bfull[ -]body\b/, 'wide'],
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

function blueprintAngleShot(cameraText: string): string | null {
  const text = String(cameraText || '').toLowerCase()
  if (!text) return null
  return BLUEPRINT_ANGLE_RE.find(([pattern]) => pattern.test(text))?.[1] ?? null
}

function matchFirst(text: string, table: Record<string, string>): string | null {
  const lower = text.toLowerCase()
  const keys = Object.keys(table).sort((a, b) => b.length - a.length)
  for (const key of keys) {
    // Underscores delimit camera tags, while letters in "closed" must not match "close".
    if (new RegExp(`(?:^|[^a-z0-9])${key}(?=$|[^a-z0-9])`).test(lower)) return table[key]
  }
  return null
}

export function inferBlueprintDecisions(blueprint: SceneBlueprint | null): PopularBlueprintDecision {
  if (!blueprint) return { shot: null, lighting: null, composition: null, colorMood: null, size: '832x1216' }
  const angleShot = blueprintAngleShot(blueprint.camera)
  const cameraText = String(blueprint.camera || '').toLowerCase()
  const shot = angleShot ?? matchFirst(cameraText, CAMERA_TO_SHOT)
    ?? EXTRA_CAMERA_TO_SHOT.find(([pattern]) => pattern.test(cameraText))?.[1]
    ?? null
  return {
    shot,
    lighting: inferBlueprintLighting(blueprint),
    composition: /\bsymmetrical[ _-]composition\b/.test(cameraText) ? 'center'
      : /\brule[ _-]of[ _-]thirds?\b/.test(cameraText) ? 'rule3' : null,
    colorMood: null,
    size: blueprint.recommendedSize || '832x1216',
  }
}

interface BlueprintLightSource {
  lighting?: string
  timeOfDay?: string
  sceneTags?: readonly string[]
}

const IDS = new Set(['golden', 'window', 'back', 'moon', 'lantern', 'overcast'])
const TAG_LIGHTS: Record<string, string> = {
  'golden hour': 'golden', sunset: 'golden', dusk: 'golden',
  'window light': 'window', backlight: 'back', backlighting: 'back',
  'rim light': 'back', moonlight: 'moon', 'full moon': 'moon',
  lantern: 'lantern', candlelight: 'lantern', overcast: 'overcast',
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Only authored lighting and exact light tags describe a light source.
 * Camera position, character colors, prose titles and the mere fact of night
 * must not inject sunset, daylight or a moon into the finished prompt.
 */
export function inferBlueprintLighting(source: BlueprintLightSource): string | null {
  const light = normalize(source.lighting || '')
  const night = /\b(?:night|nighttime|midnight)\b|夜/.test(normalize(source.timeOfDay || ''))
  const day = /\b(?:day|morning|noon|afternoon)\b|日间|白天|清晨|上午|正午|午后/.test(normalize(source.timeOfDay || ''))
  const artificial = /\b(?:neon|screen|led|hologram|monitor|fluorescent|studio|stage|laser|magic|energy)\b|霓虹|屏幕|荧光灯|全息|显示屏|魔法|元素|鬼火|激光/.test(light)
  if (IDS.has(light)) return light === 'window' && night ? null : light
  if (/\bmoon(?:light|lit)?\b|月光|月色|冷月/.test(light)) return 'moon'
  if (/\b(?:lanterns?|candle(?:light)?|streetlamps?|lamps?|lamplight|spotlight|firelight)\b|灯笼|霄灯|烛光|烛火|炉火|柴火|台灯|吊灯|路灯|檐灯|聚光灯/.test(light)) return 'lantern'
  if (/\bgolden hour\b|\bsunset\b|\bdusk\b|夕阳|夕照|落日|晚霞|黄昏|余晖|黄金时刻/.test(light)) return 'golden'
  if (/\bovercast\b|阴天|阴雨|阴云|云层漫射/.test(light)) return 'overcast'
  if (/\bbacklight(?:ing)?\b|\bbacklit\b|\brim light\b|逆光|轮廓光|边缘光/.test(light)) return 'back'
  if (/\bwindow(?: light)?\b|窗/.test(light) && !night && !artificial) return 'window'
  // Keep the existing warm-daylight recipe when the lighting field itself
  // calls for it. A color in prose or an artificial emitter cannot trigger it.
  const noon = /\b(?:noon|midday)\b|正午|中午/.test(normalize(source.timeOfDay || '') + ' ' + light)
  if (!night && !noon && !artificial && !/\b(?:hair|eyes)\b|发色|眼睛|瞳/.test(light)
    && /\b(?:golden|morning|sunlight|autumn|sunrise|dawn)\b|阳光|晨曦|朝阳|曙光|秋光|晨光/.test(light)) return 'golden'
  // An unsupported explicit source (for example a blue monitor) remains in
  // the authored scene. Do not replace it with an unrelated lighting preset.
  if (light && (artificial || !/^(?:(?:soft|warm|cool|dim|diffuse|natural|ambient|cinematic|lighting|light)\s*)+$|^[柔和温暖冷暗自然氛围光线照明]+$/.test(light))) return null
  for (const tag of source.sceneTags || []) {
    const id = TAG_LIGHTS[normalize(tag)]
    if (id && !(night && (id === 'window' || id === 'golden')) && !(day && id === 'moon')) return id
  }
  return null
}

// Preserve the existing decision path outside the SFW audit scope.
const CAMERA_TO_SHOT: Record<string, string> = {
  closeup: 'close', 'close-up': 'close', close_up: 'close', close: 'close',
  'medium shot': 'medium', half_body: 'medium', medium: 'medium',
  'cowboy shot': 'medium', cowboy_shot: 'medium', cowboy: 'medium',
  'wide shot': 'wide', wide_shot: 'wide', full_body: 'wide', wide: 'wide',
  pov: 'pov', 'high angle': 'high', from_above: 'high', 'low angle': 'low',
  from_below: 'low', 'side view': 'side', looking_back: 'turn',
}
/** 蓝图 camera 字段漏网短语补映射（2026-08-24 全量审计：23 例 shot=null）。 */
const EXTRA_CAMERA_TO_SHOT: ReadonlyArray<readonly [RegExp, string]> = [
  [/cowboy (?:shot)?|cowboy_shot/, 'medium'],
  [/dynamic action (?:shot|angle)|action shot/, 'wide'],
  [/full body/, 'wide'],
  [/couch level|low level/, 'low'],
  [/three quarter/, 'medium'],
  [/upper body/, 'medium'],
  [/intimate (?:dramatic )?angle|dramatic intimate angle/, 'medium'],
  // back_view/back shot：ShotId 枚举无「背面」槽位，取中景为中性框架，
  // 背面视角语义由蓝图 promptProse 自由文本兜底。
  [/back[_ ](?:view|shot)/, 'medium'],
  [/front[_ ]view/, 'medium'],
]
/**
 * 角度词优先预扫：低/高机位是比取景景别更罕见的作者意图信号。
 * 2026-08-24 审计：matchFirst 按子串长度取胜，`cinematic low angle medium shot`
 * 命中更长的 `medium shot`，把刻意低机位覆盖成平拍（≥10 例）。角度词先于
 * 取景表裁决；`medium shot, slight low angle` 这类双写以机位为准（取景信息
 * 通常仍由 promptProse 自由文本兜底）。
 */
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
const LIGHTING_TO_ID: Record<string, string> = {
  golden: 'golden', 'golden hour': 'golden', sunset: 'golden', dusk: 'golden',
  // 2026-08-24 全量审计补映射：晨光/日光/秋光/余晖是蓝图 lighting 字段高频
  // 作者意图，此前 105/438 蓝图连补偿命中都拿不到，AMBIENCE 光影词包不附加。
  morning: 'golden', sunlight: 'golden', autumn: 'golden', 余晖: 'golden',
  柴火: 'lantern', 炉火: 'lantern',
  // 2026-08-24 B1 试点审计：舞台/柜台聚光灯误命中 prose 里的 night -> 月光；
  // spotlight 归入 lantern 暖光族（5 处全量影响均为语义改善）。
  spotlight: 'lantern',
  window: 'window', 'window light': 'window', backlight: 'back', backlit: 'back',
  'rim light': 'back', moonlight: 'moon', moon: 'moon', night: 'moon',
  lantern: 'lantern', candlelight: 'lantern', candle: 'lantern', lamp: 'lantern', overcast: 'overcast',
}
function matchFirst(text: string, table: Record<string, string>): string | null {
  const lower = text.toLowerCase()
  const keys = Object.keys(table).sort((a, b) => b.length - a.length)
  for (const key of keys) {
    if (lower.includes(key)) return table[key]
  }
  return null
}

export function existingBlueprintDecisions(blueprint: { camera: string; lighting: string; mood: string; promptProse: string; sceneTags: string[] }): {shot: string | null; lighting: string | null} {
  const hay = [blueprint.camera, blueprint.lighting, blueprint.mood, blueprint.promptProse, blueprint.sceneTags.join(', ')].join(' ').toLowerCase()
  const cameraText = String(blueprint.camera || '').toLowerCase()
  let shot = blueprintAngleShot(blueprint.camera) ?? matchFirst(cameraText, CAMERA_TO_SHOT)
  if (!shot) shot = EXTRA_CAMERA_TO_SHOT.find(([pattern]) => pattern.test(cameraText))?.[1] ?? null
  if (!shot) shot = matchFirst(hay, CAMERA_TO_SHOT)
  return { shot, lighting: matchFirst(hay, LIGHTING_TO_ID) }
}

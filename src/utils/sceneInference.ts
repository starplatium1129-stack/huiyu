// 场景智能推断：从迁移前 pb_sceneinfer.js + pb_composition.js 移植
// 选场景时自动预填光照/镜头/构图/色彩情调/推荐尺寸。
// 标签使用精确规范化匹配；中文只解析专门的 camera / lighting 结构化字段，
// 绝不扫描故事或检索标签，避免叙事文本里的宽泛词误改导演决策。

export const SHOT_IDS = ['close', 'medium', 'wide', 'pov', 'low', 'high', 'side', 'turn', 'over', 'detail'] as const
export type ShotId = typeof SHOT_IDS[number]

export const LIGHTING_IDS = ['golden', 'window', 'back', 'moon', 'lantern', 'overcast'] as const
export type LightingId = typeof LIGHTING_IDS[number]

export const MOOD_IDS = ['joy', 'love', 'calm', 'sad', 'tension', 'warmth'] as const
export type MoodId = typeof MOOD_IDS[number]

export const COMPOSITION_IDS = ['center', 'rule3', 'left', 'right', 'foreground', 'frame', 'bywindow'] as const
export type CompositionId = typeof COMPOSITION_IDS[number]

/** 归一化标签：小写、去权重括号、空格/连字符转下划线。 */
export function normalizeTag(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^\(+/, '')
    .replace(/\)+$/, '')
    .replace(/:\s*-?\d+(?:\.\d+)?\s*$/, '')
    .replace(/[\s-]+/g, '_')
    .replace(/_+/g, '_')
}

/** 精确规范化标签 → 镜头。镜头语义与 promptPolicy resolveFramingMode 对齐。 */
const TAG_TO_SHOT: Record<string, ShotId> = {
  close_up: 'close', closeup: 'close', bust: 'close', portrait: 'close', face_focus: 'close',
  medium_shot: 'medium', half_body: 'medium', upper_body: 'medium', cowboy_shot: 'medium', waist_up: 'medium',
  wide_shot: 'wide', full_body: 'wide', long_shot: 'wide', full_body_shot: 'wide', establishing_shot: 'wide',
  pov: 'pov', first_person: 'pov', pov_shot: 'pov',
  high_angle: 'high', from_above: 'high', overhead: 'high', bird_eye_view: 'high',
  low_angle: 'low', from_below: 'low', worm_eye_view: 'low',
  side_view: 'side', side_profile: 'side',
  looking_back: 'turn', turn_back: 'turn', turned_back: 'turn',
  selfie: 'over',
  macro: 'detail', close_up_detail: 'detail', extreme_close_up: 'detail',
}

/** 镜头优先级：出现多个镜头标签时按此顺序取第一个命中的（取景类优先于姿态类）。 */
const SHOT_PRIORITY: readonly ShotId[] = ['pov', 'detail', 'close', 'medium', 'wide', 'high', 'low', 'side', 'turn', 'over']

function explicitCameraShot(value: unknown): ShotId | null {
  const text = String(value ?? '').trim().toLowerCase()
  if (!text) return null
  const normalized = normalizeTag(text)
  if (SHOT_IDS.includes(normalized as ShotId)) return normalized as ShotId
  if (/主观|第一人称|男友视角|\bpov\b/.test(text)) return 'pov'
  if (/手部|局部|细节/.test(text)) return 'detail'
  if (/近景|特写|面部/.test(text)) return 'close'
  if (/半身|中景|上半身/.test(text)) return 'medium'
  if (/全身|远景|全景/.test(text)) return 'wide'
  if (/俯视|俯瞰/.test(text)) return 'high'
  if (/仰视|微仰/.test(text)) return 'low'
  if (/侧面|侧方|侧身|侧脸/.test(text)) return 'side'
  if (/回眸|回头/.test(text)) return 'turn'
  return null
}

/** 精确规范化标签 → 光照。 */
const TAG_TO_LIGHTING: Record<string, LightingId> = {
  golden_hour: 'golden', golden_hour_lighting: 'golden', golden_light: 'golden',
  window_light: 'window',
  backlit: 'back', backlight: 'back', backlighting: 'back', rim_light: 'back',
  moonlight: 'moon',
  warm_light: 'lantern', warm_lighting: 'lantern',
  overcast: 'overcast', overcast_sky: 'overcast',
}

function explicitLighting(value: unknown): LightingId | null {
  const text = String(value ?? '').trim().toLowerCase()
  if (!text) return null
  const normalized = normalizeTag(text)
  if (LIGHTING_IDS.includes(normalized as LightingId)) return normalized as LightingId
  if (TAG_TO_LIGHTING[normalized]) return TAG_TO_LIGHTING[normalized]
  if (/黄金|夕阳|黄昏|落日|夕照/.test(text)) return 'golden'
  if (/窗光|侧窗光/.test(text)) return 'window'
  if (/逆光|背光/.test(text)) return 'back'
  if (/月光|明月/.test(text)) return 'moon'
  if (/暖光|暖灯光/.test(text)) return 'lantern'
  if (/阴天|阴雨/.test(text)) return 'overcast'
  return null
}

export function sceneLighting(scene: { tags?: string[]; lighting?: unknown } | null): LightingId | null {
  const explicit = explicitLighting(scene?.lighting)
  if (explicit) return explicit
  if (String(scene?.lighting ?? '').trim()) return null
  const tags = (scene?.tags || []).map(normalizeTag)
  for (const tag of tags) {
    const hit = TAG_TO_LIGHTING[tag]
    if (hit) return hit
  }
  return null
}

export function sceneShot(scene: { tags?: string[]; camera?: unknown } | null): ShotId | null {
  const explicit = explicitCameraShot(scene?.camera)
  if (explicit) return explicit
  const tags = (scene?.tags || []).map(normalizeTag)
  for (const shotId of SHOT_PRIORITY) {
    const matched = tags.find(tag => TAG_TO_SHOT[tag] === shotId)
    if (matched) return shotId
  }
  return null
}

export function sceneColorMood(scene: { tags?: string[]; colorMood?: unknown } | null): MoodId | null {
  const explicit = String(scene?.colorMood ?? '') as MoodId
  return MOOD_IDS.includes(explicit) ? explicit : null
}

export function sceneComposition(scene: unknown): CompositionId | null {
  const raw = (scene as { composition?: unknown } | null)?.composition
  if (typeof raw === 'string') {
    const candidate = normalizeTag(raw) as CompositionId
    if (COMPOSITION_IDS.includes(candidate)) return candidate
  }
  return null
}

const PORTRAIT_TAGS = new Set(['vertical', 'portrait', '竖图', '手机壁纸', '手机'])
const LANDSCAPE_TAGS = new Set(['landscape', 'wide', 'widescreen', 'panorama', '横图', '横幅'])
const SQUARE_TAGS = new Set(['square', '方图'])

/**
 * 画幅优先读场景显式 recommendedSize 字段；没有时才按精确标签判断。
 * 标签只认整个标签，不做子串匹配（wide_shot 是取景范围不是画幅）。
 */
export function sceneRecommendedSize(scene: { tags?: string[]; recommendedSize?: unknown }): string {
  const explicit = String(scene?.recommendedSize ?? '').replace(/×/g, 'x').trim()
  if (/^\d{2,4}x\d{2,4}$/.test(explicit)) return explicit
  const tags = (scene?.tags || []).map(normalizeTag)
  if (tags.some(tag => PORTRAIT_TAGS.has(tag))) return '768x1344'
  if (tags.some(tag => LANDSCAPE_TAGS.has(tag))) return '1344x768'
  if (tags.some(tag => SQUARE_TAGS.has(tag))) return '896x896'
  return '832x1216'
}

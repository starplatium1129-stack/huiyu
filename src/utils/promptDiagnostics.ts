import { WIDE_TOKENS, CLOSE_TOKENS, MID_TOKENS } from './promptFramingTokens.ts'
import { normalizeKey, tokenize, splitBreaks } from './promptPolicy.ts'
import { resolveDrawCapabilities } from './drawCapabilities.ts'
import type { PromptPart, PromptEngine } from './promptPolicyTypes.ts'
export const BANNED_TAGS = [
  'neon', 'glowing', 'oversaturated', 'vivid colors', 'vivid', 'rainbow',
  'high contrast', 'harsh lighting', 'extremely detailed', 'ultra detailed',
]

export function checkArtDirection(text: string): string[] {
  const lower = String(text || '').toLowerCase()
  return BANNED_TAGS.filter(t =>
    lower.includes(t.toLowerCase()) || lower.includes(t.toLowerCase().replace(/\s/g, '_')),
  )
}

/** 质量词唯一权威清单（Danbooru 下划线形式）。
 *  三处消费方共用一份，禁止各自维护副本（2026-08-15 审计）：
 *  QUALITY_TOKENS（堆叠计数）与 QUALITY_OR_SCORE_RE（Anima 剥离）均由本清单派生；
 *  UI 分类（PromptHealthPanel）用空格形式派生；Krea 散文净化（promptCompiler）复用。 */
export const QUALITY_WORDS = [
  'masterpiece', 'best_quality', 'amazing_quality', 'very_aesthetic',
  'absurdres', 'newest', 'highres', 'highly_detailed',
] as const

/** 质量词堆叠：WAI0731 官方建议正向只用 3 个左右质量词，
 * 过多或过长的负面会降低成图质量（官方原话）。 */
export const QUALITY_TOKENS: ReadonlySet<string> = new Set(QUALITY_WORDS)

/** 质量词 + score 评分词（Anima 正层剥离用）。 */
export const QUALITY_OR_SCORE_RE = new RegExp(`^(?:${QUALITY_WORDS.join('|')}|score_\\d+)$`, 'i')

/** 同一画面里出现两个以上服装族系会互相打架（校服 vs 泳装 vs 浴衣…） */
const OUTFIT_FAMILIES: Array<{ name: string; tokens: string[] }> = [
  { name: '校服/水手服', tokens: ['school_uniform', 'sailor_uniform', 'blazer', 'serafuku', 'sailor_shirt', 'pleated_skirt', 'plaid_skirt'] },
  { name: '泳装/水着', tokens: ['swimsuit', 'school_swimsuit', 'one-piece_swimsuit', 'wet_swimsuit', 'tight_swimsuit', 'bikini', 'triangle_bikini', 'front-tie_bikini', 'bandeau_bikini', 'criss-cross_bikini', 'micro_bikini', 'string_bikini', 'competitive_swimsuit', 'competition_swimsuit', 'white_competition_swimsuit', 'highleg_swimsuit', 'monokini', 'halterneck_swimsuit', 'wet_white_shirt', 'bikini_under_clothes'] },
  { name: '和服/旗袍', tokens: ['kimono', 'yukata', 'furisode', 'hakama', 'japanese_clothes', 'cheongsam', 'qipao', 'china_dress', 'hanbok'] },
  { name: '睡衣/薄纱私密', tokens: ['pajamas', 'nightgown', 'sleepwear', 'roomwear', 'sheer_babydoll', 'open-front_negligee', 'silk_slip'] },
  { name: '女仆/侍应', tokens: ['maid', 'maid_apron', 'maid_headdress', 'waitress', 'cafe_uniform'] },
  { name: '毛衣/针织战袍', tokens: ['virgin_killer_sweater', 'backless_sweater', 'turtleneck_sweater', 'ribbed_sweater', 'oversized_sweater', 'off_shoulder_sweater', 'keyhole_sweater', 'sleeveless_turtleneck', 'cleavage_opening'] },
  { name: '兔女郎/紧身连体衣', tokens: ['bunny_suit', 'sheer_bunny_suit', 'reverse_bunny_suit', 'bodysuit', 'sleeveless_bodysuit', 'latex_catsuit', 'skin-tight', 'backless_bodysuit'] },
  { name: '男友风/运动球衣', tokens: ['oversized_shirt', 'boyfriend_shirt', 'oversized_jersey', 'basketball_jersey', 'sleeveless_jersey'] },
  { name: '节日/角色扮演', tokens: ['santa_costume', 'santa_capelet', 'succubus_costume'] },
  { name: '浴巾/半裸围裙', tokens: ['naked_apron', 'apron_only', 'bath_towel', 'towel_around_body', 'slipping_towel'] },
]

/** 时间段互斥：夜间场景不该同时出现日间词 */
const TIME_GROUPS: Array<{ name: string; tokens: string[] }> = [
  { name: '日间', tokens: ['morning', 'day', 'daylight', 'daytime', 'noon'] },
  { name: '傍晚/午后', tokens: ['afternoon', 'evening', 'sunset', 'dusk', 'golden_hour', 'golden hour'] },
  { name: '夜间', tokens: ['night', 'midnight', 'nighttime', 'moonlight', 'night_sky', 'city_lights'] },
]

/** 天气互斥：下雨 vs 晴天 vs 下雪 */
const WEATHER_GROUPS: Array<{ name: string; tokens: string[] }> = [
  { name: '雨天', tokens: ['rain', 'rainy', 'raining', 'rainy_day', 'rainy_night', 'rain_storm'] },
  { name: '雪天', tokens: ['snow', 'snowing', 'snowy', 'snowstorm'] },
  { name: '晴天', tokens: ['clear_sky', 'sunny', 'sunshine', 'clear_weather'] },
]

/** 主体姿势互斥：站姿 vs 坐姿 vs 躺姿 vs 跪姿 vs 蹲姿 */
export const POSE_GROUPS: Array<{ name: string; tokens: string[] }> = [
  { name: '站姿', tokens: ['standing', 'standing_up', 'standing_split'] },
  { name: '坐姿', tokens: ['sitting', 'sitting_on_chair', 'sitting_on_bed', 'sitting_on_floor', 'sitting_on_ground', 'seiza', 'lotus_position', 'cross-legged'] },
  { name: '躺姿', tokens: ['lying', 'lying_on_back', 'lying_on_side', 'lying_on_stomach'] },
  { name: '跪姿', tokens: ['kneeling', 'all_fours'] },
  { name: '蹲姿', tokens: ['squatting'] },
]

/** 视角朝向互斥：正面 vs 背面 vs 侧面 */
export const VIEWPOINT_GROUPS: Array<{ name: string; tokens: string[] }> = [
  { name: '正面视角', tokens: ['front_view', 'straight-on'] },
  { name: '背面视角', tokens: ['back_view', 'from_behind', 'turned_back', 'looking_back'] },
  { name: '侧面视角', tokens: ['profile', 'from_side'] },
]

/** 拍摄角度互斥：俯拍 vs 仰拍 */
export const ANGLE_GROUPS: Array<{ name: string; tokens: string[] }> = [
  { name: '俯拍视角', tokens: ['from_above', 'high_angle'] },
  { name: '仰拍视角', tokens: ['from_below', 'low_angle'] },
]

/** 空间环境互斥：室内 vs 室外 */
export const ENVIRONMENT_GROUPS: Array<{ name: string; tokens: string[] }> = [
  { name: '室内', tokens: ['indoors', 'indoor'] },
  { name: '室外', tokens: ['outdoors', 'outdoor'] },
]

export const FACE_CLOSEUP_TOKENS: ReadonlySet<string> = new Set([
  'face_focus', 'extreme_close_up', 'close_up_detail', 'macro', 'upper_face', 'close_up',
])

export const FOOTWEAR_AND_LEG_TOKENS: ReadonlySet<string> = new Set([
  'boots', 'shoes', 'sneakers', 'heels', 'sandals', 'socks', 'stockings',
  'thighhighs', 'thigh_highs', 'over_knee_socks', 'knee_socks', 'tights',
  'pantyhose', 'leggings', 'footwear', 'barefoot', 'bare_feet', 'feet',
  'high_heels', 'loafers', 'slippers',
])

export const SHOE_TOKENS: ReadonlySet<string> = new Set([
  'boots', 'shoes', 'sneakers', 'heels', 'sandals', 'high_heels', 'loafers', 'slippers',
])

export const BAREFOOT_TOKENS: ReadonlySet<string> = new Set([
  'barefoot', 'bare_feet',
])

export const CLOSED_EYES_TOKENS: ReadonlySet<string> = new Set([
  'closed_eyes', 'eyes_closed', 'sleeping',
])

export const GAZE_AND_EYE_DETAIL_TOKENS: ReadonlySet<string> = new Set([
  'looking_at_viewer', 'looking_away', 'sparkling_eyes', 'detailed_eyes',
  'glowing_eyes', 'wide_eyes', 'dilated_pupils', 'sparkling_pupils', 'staring',
])

function conflictGroups(groups: Array<{ name: string; tokens: string[] }>, tags: string[]): string[] {
  const hit = groups.filter(group => group.tokens.some(token => tags.includes(token)))
  return hit.length > 1 ? hit.map(group => group.name) : []
}

/** 词条目录级互斥：服装 / 时段 / 天气 / 姿势 / 视角 / 角度 / 环境。 */
const MUTUAL_EXCLUSION_GROUPS = [
  ...OUTFIT_FAMILIES,
  ...TIME_GROUPS,
  ...WEATHER_GROUPS,
  ...POSE_GROUPS,
  ...VIEWPOINT_GROUPS,
  ...ANGLE_GROUPS,
  ...ENVIRONMENT_GROUPS,
]

/** 返回 tag 命中的互斥组名（无则 null） */
export function mutualGroupOf(tag: string): string | null {
  const key = normalizeKey(tag)
  const group = MUTUAL_EXCLUSION_GROUPS.find(g => g.tokens.some(t => normalizeKey(t) === key))
  return group ? group.name : null
}

/** 互斥组类别。 */
export type MutualGroupCategory = 'outfit' | 'time' | 'weather' | 'pose' | 'viewpoint' | 'angle' | 'environment'

const CATEGORY_LABEL: Record<MutualGroupCategory, string> = {
  outfit: '服装',
  time: '时段',
  weather: '天气',
  pose: '姿势',
  viewpoint: '视角',
  angle: '拍摄角度',
  environment: '空间环境',
}

const MUTUAL_CATEGORY_BY_GROUP: Map<string, MutualGroupCategory> = new Map([
  ...OUTFIT_FAMILIES.map(g => [g.name, 'outfit'] as [string, MutualGroupCategory]),
  ...TIME_GROUPS.map(g => [g.name, 'time'] as [string, MutualGroupCategory]),
  ...WEATHER_GROUPS.map(g => [g.name, 'weather'] as [string, MutualGroupCategory]),
  ...POSE_GROUPS.map(g => [g.name, 'pose'] as [string, MutualGroupCategory]),
  ...VIEWPOINT_GROUPS.map(g => [g.name, 'viewpoint'] as [string, MutualGroupCategory]),
  ...ANGLE_GROUPS.map(g => [g.name, 'angle'] as [string, MutualGroupCategory]),
  ...ENVIRONMENT_GROUPS.map(g => [g.name, 'environment'] as [string, MutualGroupCategory]),
])

export interface MutualGroupHit {
  /** 组名（'泳装' / '夜间' / '雨天' …）。 */
  group: string
  category: MutualGroupCategory
  /** 类别中文标签（'服装' / '时段' / '天气'）。 */
  label: string
}

/**
 * 返回 tag 命中的互斥组及其类别（无则 null）。
 *
 * 与 analyzeParts 的冲突警告共用 MUTUAL_EXCLUSION_GROUPS 同一真相源 —— 反推合并
 * 用它做「写入前消解」，analyzeParts 做「最终兜底警告」，两处判定不会漂移。
 *
 * 注意语义与身份域相反：身份域是**域内互斥**（发色 pink vs blonde 不能共存），
 * 互斥组是**组间互斥**（校服 vs 泳装不能共存），同组内可叠加
 * （school_uniform + pleated_skirt 同属「校服/水手服」，叠加不冲突）。
 */
export function mutualGroupWithCategory(tag: string): MutualGroupHit | null {
  const group = mutualGroupOf(tag)
  if (!group) return null
  const category = MUTUAL_CATEGORY_BY_GROUP.get(group) ?? 'outfit'
  return { group, category, label: CATEGORY_LABEL[category] }
}

/** 返回 tags 中属于 groupName 互斥组的成员 */
export function membersOfMutualGroup(groupName: string, tags: string[]): string[] {
  const group = MUTUAL_EXCLUSION_GROUPS.find(g => g.name === groupName)
  if (!group) return []
  return tags.filter(t => group.tokens.some(gt => normalizeKey(gt) === normalizeKey(t)))
}

export interface PromptReport {
  positiveCount: number
  negativeCount: number
  level: 'ok' | 'warn' | 'over'
  label: string
  warnings: string[]
}

/** 逗号标签数统计（不冒充具体模型 tokenizer）。
 *  engine 可选：传入非 SD 家族时启用引擎契约违规检测（Krea 权重语法/下划线/
 *  score 质量词/负面恒空、Anima 与 Krea 的非 ASCII 混入、负面 token 重复）。 */
export function analyzeParts(parts: PromptPart[], engine?: PromptEngine): PromptReport {
  const capabilities = resolveDrawCapabilities(engine || 'sd')
  const isNaturalLanguage = capabilities.promptFormat === 'natural-language'
  const positive: string[] = []
  const negative: string[] = []
  let hasBreak = false
  const warnings: string[] = []
  parts.forEach(part => {
    if (/\bBREAK\b/i.test(part.text)) hasBreak = true
    if (part.cls === 'l') return
    const target = part.cls === 'n' ? negative : positive
    splitBreaks(part.text.replace(/^\s*\[NEG\]\s*/i, '')).forEach(section => {
      tokenize(section).forEach(token => {
        if (!/^<lora:/i.test(token)) target.push(normalizeKey(token))
      })
    })
  })
  const framingFamilies = new Set(positive.map(token =>
    WIDE_TOKENS.has(token) ? 'wide' : CLOSE_TOKENS.has(token) ? 'close' : MID_TOKENS.has(token) ? 'mid' : '',
  ).filter(Boolean))
  if (framingFamilies.size > 1) warnings.push('镜头景别相互竞争')
  if (!hasBreak && positive.includes('closed_eyes') && positive.includes('looking_at_viewer')) warnings.push('闭眼与直视镜头冲突')
  if (!hasBreak && ['standing', 'sitting', 'lying', 'kneeling'].filter(pose => positive.includes(pose)).length > 1) {
    warnings.push('主体姿势相互冲突')
  }
  // ── 镜头可见性与硬冲突（2026-08-30 K2 引擎 §10.1/§10.3 落地）───────────
  // 先确定构图，再删除镜头看不到的细节：特写不写鞋、背面不写正面胸饰、
  // 遮眼不写瞳孔、赤脚与穿鞋互斥、俯拍与仰拍互斥、正面与背面互斥。
  const positiveSet = new Set(positive)
  const FACE_CLOSEUP = new Set(['face_focus', 'extreme_close_up', 'close_up_detail', 'macro', 'upper_face'])
  const FOOTWEAR = new Set(['boots', 'shoes', 'sneakers', 'heels', 'sandals', 'socks', 'stockings', 'thighhighs', 'thigh_highs', 'over_knee_socks', 'knee_socks', 'tights', 'pantyhose', 'leggings', 'footwear', 'barefoot', 'bare_feet', 'feet'])
  const FRONT_CHEST = new Set(['cleavage', 'breasts', 'bare_breasts', 'chest', 'necklace', 'neck_tie', 'breast_hold', 'breast_between_cheeks'])
  const BACK_VIEWS = new Set(['back_view', 'turned_back', 'from_behind', 'looking_back'])
  if ([...FACE_CLOSEUP].some(t => positiveSet.has(t)) && [...FOOTWEAR].some(t => positiveSet.has(t))) {
    warnings.push('特写镜头下鞋子/脚部不可见（镜头可见性）：面颊特写不写鞋')
  }
  if ([...BACK_VIEWS].some(t => positiveSet.has(t)) && [...FRONT_CHEST].some(t => positiveSet.has(t))) {
    warnings.push('背面镜头下前胸/领饰不可见（镜头可见性）：背面不写正面胸饰')
  }
  if (positiveSet.has('closed_eyes') && [...positiveSet].some(t =>
    /^(?:sparkling_eyes|detailed_eyes|glowing_eyes|wide_eyes|dilated_pupils|sparkling_pupils)$/.test(t),
  )) {
    warnings.push('闭眼状态下瞳孔/眼神细节不可见（镜头可见性）')
  }
  if (positiveSet.has('barefoot') && ['boots', 'shoes', 'sneakers', 'heels', 'sandals'].some(t => positiveSet.has(t))) {
    warnings.push('赤脚与穿鞋互斥（硬冲突）：barefoot 与鞋子不能同屏')
  }
  if (positiveSet.has('from_above') && positiveSet.has('from_below')) warnings.push('俯拍与仰拍互斥（硬冲突）')
  if (positiveSet.has('front_view') && positiveSet.has('back_view')) warnings.push('正面与背面视角互斥（硬冲突）')
  const qualityCount = positive.filter(token => QUALITY_TOKENS.has(token)).length
  if (qualityCount > 5) {
    warnings.push(`质量词过多（${qualityCount} 个）：模型作者建议不要堆叠质量标签，多了反而降质变糊`)
  }
  const outfitConflict = conflictGroups(OUTFIT_FAMILIES, positive)
  if (outfitConflict.length > 1) {
    warnings.push('服装相互冲突：' + outfitConflict.join('、') + ' 同时出现，模型会随机挑一套')
  }
  const timeConflict = conflictGroups(TIME_GROUPS, positive)
  if (timeConflict.length > 1) {
    warnings.push('时段相互冲突：' + timeConflict.join('、') + ' 同时出现')
  }
  const weatherConflict = conflictGroups(WEATHER_GROUPS, positive)
  if (weatherConflict.length > 1) {
    warnings.push('天气相互冲突：' + weatherConflict.join('、') + ' 同时出现')
  }
  const negativeSet = new Set(negative)
  const overlap = [...new Set(positive.filter(tag => negativeSet.has(tag)))]
  if (overlap.length) warnings.push('正负词冲突：' + overlap.slice(0, 3).join('、'))

  // ── 引擎契约违规检测（2026-08-15 审计新增）──────────────────────────────
  // 输入必须是真实下发文本：usePromptAssembly / usePopularPromptAssembly 的
  // 非 SD 家族已把渲染结果作为单个 part 传入，SD 家族仍传分块 parts。
  const rawPositiveText = parts.filter(part => part.cls !== 'n').map(part => part.text).join('\n')
  if (isNaturalLanguage) {
    const weights = rawPositiveText.match(/\(([^()\n]*[a-z][^()\n]*):\s*-?\d+(?:\.\d+)?\s*\)/gi) || []
    if (weights.length) warnings.push(`Krea 自然描述中残留权重语法（模型不识别）：${[...new Set(weights)].slice(0, 3).join('、')}`)
    const underscored = rawPositiveText.match(/[a-z0-9]+_[a-z0-9_]+/gi) || []
    if (underscored.length) warnings.push(`Krea 自然描述中混入带下划线的标签词：${[...new Set(underscored)].slice(0, 3).join('、')}`)
    const scoreQuality = rawPositiveText.match(new RegExp(`\\b(?:${QUALITY_WORDS.join('|')}|score_\\d+)\\b`, 'gi')) || []
    if (scoreQuality.length) warnings.push(`Krea 自然描述中混入打分/质量词（建议移除）：${[...new Set(scoreQuality)].slice(0, 3).join('、')}`)
    if (negative.length && !capabilities.negative) warnings.push('Krea 自然语言引擎无需负面词，生成时将自动忽略')
  }
  if (capabilities.promptFormat !== 'danbooru') {
    // 换行是标签流/散文的可审计边界（renderPromptPlan anima 分支），不算非 ASCII 混入。
    if (/[^\x20-\x7e\n\r]/.test(rawPositiveText)) warnings.push('提示词混入非英文字符（绘图模型无法直接理解，生成时已自动过滤）')
  }
  const duplicateNegatives = [...new Set(negative.filter((token, index) => negative.indexOf(token) !== index))]
  if (duplicateNegatives.length) warnings.push(`负面词重复：${duplicateNegatives.slice(0, 3).join('、')}`)

  let level: 'ok' | 'warn' | 'over' = 'ok'
  let label = '结构均衡'
  // Krea 是纯散文：逗号切分出的「片段数」不是 token 数，跳过数量阈值，避免误报信息偏少/过载。
  if (!isNaturalLanguage) {
    if (positive.length > 90) { level = 'over'; label = '标签过载'; warnings.push('正向标签超过 90 个，模型容易忽略后段。') }
    else if (positive.length > 72) { level = 'warn'; label = '偏长'; warnings.push('正向标签超过 72 个，建议精简。') }
    else if (positive.length < 8) { level = 'warn'; label = '信息偏少'; warnings.push('正向标签过少，画面可能缺少细节。') }
  }
  const violations = checkArtDirection(parts.map(p => p.text).join(', '))
  if (violations.length) warnings.push('违反美术规范：' + violations.join(', '))
  if (warnings.length && level === 'ok') { level = 'warn'; label = warnings[0] }
  if (warnings.length > 2) level = 'over'
  return { positiveCount: positive.length, negativeCount: negative.length, level, label, warnings }
}

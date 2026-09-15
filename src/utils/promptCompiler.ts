import type { PromptFamily, PromptSceneContext, PromptPlan } from '../types/prompt'
export type { PromptFamily, PromptSceneContext, PromptPlan } from '../types/prompt'

import {
  formatPromptForEngine,
  QUALITY_OR_SCORE_RE,
  QUALITY_WORDS,
  tokenize,
  type ModelProfile,
} from './promptPolicy.ts'
import { resolveDrawCapabilities } from './drawCapabilities.ts'
import { sceneLighting, sceneShot } from './sceneInference.ts'
import { proseToken, normalizeProseKey, actionPhrase, outfitPhrase, moodPhrase, compactMood, cameraPhrase, lightPhrase, environmentPhrase } from './promptPhraseTables.ts'

export interface PromptCompilerInput {
  profile?: ModelProfile | null; identity?: string; controls?: string[]; scenePrompt?: string
  artists?: string[]; artistProse?: string
  exactTokens?: string[]
  emotion?: string[]; camera?: string[]; lighting?: string[]; composition?: string[]
  manual?: string[]; negative?: string; rating?: string; visualDescription?: string
  style?: string[]; medium?: string; subjectProse?: string; outfitProse?: string; sceneProse?: string
  scene?: PromptSceneContext | null
}

const split = (value: string | undefined): string[] => tokenize(value || '').filter(Boolean)
const clean = (value: string): string => value.replace(/<lora:[^>]+>/gi, '').replace(/\bBREAK\b/gi, ', ').replace(/\s+/g, ' ').trim()
const capFirst = (value: string): string => value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : ''
const sentence = (value: string): string => { const text = clean(value); return text ? `${capFirst(text.replace(/[.!?]+$/, ''))}.` : '' }
const proseList = (values: string[]): string => [...new Set(values.map(proseToken).filter(Boolean))].join(', ').replace(/(?:,\s*){2,}/g, ', ')

const KREA_META_KEYS = new Set([
  '1girl', 'solo', '2girls', 'official_cg', 'visual_audited', 'landscape', 'portrait',
  'general', 'sensitive', 'safe', 'explicit', 'adult', 'visual_novel_event_cg',
])
const KREA_CAMERA_KEYS = new Set([
  'close_up', 'extreme_close_up', 'close_up_detail', 'medium_shot', 'upper_body',
  'half_body', 'waist_up', 'cowboy_shot', 'wide_shot', 'long_shot', 'full_body',
  'pov', 'pov_shot', 'high_angle', 'low_angle', 'from_above', 'from_below',
  'side_view', 'profile', 'dutch_angle', 'cinematic_16_9_clockwise_dutch_angle',
  'waist_up_close_shot', 'portrait_shot', 'establishing_shot', 'face_focus',
  'three_quarter_view', 'over_the_shoulder', 'selfie',
])
const KREA_LIGHT_KEYS = new Set([
  'window_light', 'golden_hour', 'golden_light', 'backlight', 'backlit', 'rim_light',
  'moonlight', 'lantern_light', 'overcast', 'soft_light', 'soft_lighting',
  'warm_light', 'warm_lighting', 'cinematic_lighting', 'volumetric_lighting',
])
const KREA_IDENTITY_KEYS = new Set([
  'ayachi_nene', 'shiki_natsume', 'nene', 'natsume', 'white_hair', 'black_hair',
  'very_long_hair', 'very_long_black_hair', 'low_twintails', 'purple_eyes',
  'golden_yellow_eyes', 'yellow_eyes', 'ahoge', 'pink_hair_ribbons', 'hair_ribbon',
  'two_red_hairclips', 'two_red_hairclips_only', 'mole_under_eye', 'no_hair_ribbon',
])
const KREA_ENVIRONMENT_RE = /(?:^|_)(?:background|classroom|clubroom|cafe|coffee|beach|ocean|sea|forest|street|station|bedroom|bathroom|shrine|park|garden|rooftop|city|library|kitchen|palace|ruins|bridge|river|theater|cinema|safehouse|hotel|balcony|pool|tatami|office|elevator|train|vehicle|apartment|living_room|studio|gallery|store|shop|festival|bookshelf|blackboard|desk|window|wall|rack|indoors|outdoors|interior)(?:_|$)/
const KREA_OUTFIT_RE = /(?:^|_)(?:clothes|clothing|outfit|uniform|shirt|blouse|skirt|dress|apron|lingerie|underwear|panties|bra|bikini|swimsuit|pantyhose|thighhighs|stockings|coat|sweater|cardigan|pajamas|sleepwear|nightgown|towel|yukata|kimono|qipao|cheongsam|robe|jacket|blazer|collar|sleeves|gloves|boots|shoes|bow|ribbon|maid|serafuku|tactical_gear|office_lady)(?:_|$)/
const KREA_BODY_DETAIL_RE = /^(?:nude|naked|fully_nude|bare_|cleavage|sideboob|underboob|no_bra|no_panties|panties_aside|pulling_down_panties|unbuttoned|unzipped|open_shirt|off_shoulder|high_slit|midriff|collarbone|navel|slender_thighs|nipples|areola|pussy|cameltoe|breasts_out|topless|bottomless|lifted_skirt|legs_apart|spread_legs|parted_lips|open_mouth|ahegao|closed_eyes|half_closed_eyes|averting_gaze|blushing|deep_blush|heavy_blush|heavy_breathing|drooling|wet_skin|wet_hair|wet_clothes|sweat|sweaty_skin|see_through|translucent|hugging_pillow|sex|intercourse|vaginal|anal|oral|fellatio|blowjob|deepthroat|cunnilingus|paizuri|titfuck|handjob|fingering|masturbation|female_masturbation|missionary|doggystyle|cowgirl_position|mating_press|spooning|grinding|penetration|cum|cum_on_face|cum_in_mouth|cum_on_breasts|cum_on_body|internal_cumshot|creampie|excessive_cum|after_sex|panty_pull|skirt_lift|grabbed_breasts|groping)/
const KREA_ACTION_RE = /^(?:holding|carrying|standing|sitting|lying|waiting|leaning|kneeling|straddling|clinging|swimming|walking|running|reaching|undressing|looking|turning|adjusting|one_hand|both_hands|propped|cross_legged|legs_apart|skirt_lift|neck_kiss|eye_contact|close_distance)/
const KREA_MOOD_RE = /(?:^|_)(?:smile|blush|shy|happy|calm|relaxed|serious|sad|melancholic|nervous|expectant|panicked|embarrassed|tears|tearful|teary|tsundere|sensual|intimate|romantic|seductive|passionate|expressionless|in_love|soft_eyes|bright_eyes|red_ears|heavy_breathing)(?:_|$)/

function naturalList(values: string[]): string {
  const unique = [...new Set(values.map(value => value.trim()).filter(Boolean))]
  if (!unique.length) return ''
  if (unique.length === 1) return unique[0]
  if (unique.length === 2) return `${unique[0]} and ${unique[1]}`
  return `${unique.slice(0, -1).join(', ')}, and ${unique[unique.length - 1]}`
}

function isEnvironmentKey(key: string): boolean {
  return KREA_ENVIRONMENT_RE.test(key)
}

function inferredKreaStyle(plan: PromptPlan): string {
  const explicit = plan.style.map(sentence).find(Boolean)
  if (explicit) return plan.artistProse
    ? sentence(`${explicit.replace(/[.!?]+$/, '')}, ${plan.artistProse}`)
    : explicit
  const scene = plan.scene
  const tags = new Set((scene?.tags || []).map(normalizeProseKey))
  const category = String(scene?.category || '').toLowerCase()
  const usage = (scene?.usage || []).join(' ').toLowerCase()
  const landscape = tags.has('landscape') || /官方cg|展示图/.test(`${category} ${usage}`)
  const mature = String(scene?.rating || '').toUpperCase() === 'R18'
  // 2026-08-30 Krea2 默认偏厚涂/半写实质感，'polished' 词又引导光泽——
  // 加 cel shading/flat colors/crisp line art 二次元限定，把模型拉回赛璐璐。
  // 实验 D 句（cel+flat+line art）效果明显优于原句"polished anime wallpaper illustration"。
  const base = mature
    ? 'A polished 2D mature anime visual novel wallpaper with clean cel shading, flat colors and crisp line art'
    : landscape
      ? 'A cinematic 2D anime wallpaper composed like a polished visual novel event CG with cel shading, flat colors and crisp line art'
      : 'A polished 2D anime illustration with clean cel shading, flat colors and crisp line art'
  return sentence(plan.artistProse ? `${base}, ${plan.artistProse}` : base)
}

const KREA_CANONICAL_OUTFITS: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ['nene_witch_canonical', 'her canonical black witch costume with a cape, hat, pink accents, and asymmetrical striped legwear'],
  ['nene_school_uniform', 'her navy school uniform with a blazer, yellow bow tie, pleated plaid skirt, and black thigh-highs'],
  ['nene_sailor_uniform', 'her dark sailor school uniform with a gray sailor collar'],
  ['nene_red_cardigan_uniform', 'her school uniform with a burgundy cardigan, white shirt, pleated black skirt, and white socks'],
  ['nene_blue_pajamas', 'her blue cat-print button-up pajamas'],
  ['nene_green_sleepwear', 'her mint-green polka-dot sleepwear'],
  ['nene_bat_dress', 'her black bat-themed dress with garter straps and black thigh-highs'],
  ['nene_black_dress', 'her black dress with garter straps and thigh-highs'],
  ['natsume_official_qipao', 'her official red floral qipao with a side slit, black thigh-highs, and floral hair ornaments'],
  ['natsume_cafe_uniform', 'her cafe uniform with a white collared shirt, suspenders, a brown skirt, and a purple ribbon'],
  ['natsume_pink_cafe_uniform', 'her pink cafe uniform with a frilled white waist apron'],
  ['natsume_maid_uniform', 'her dark cafe maid uniform with a white apron, frills, and a maid headdress'],
  ['natsume_winter_coat', 'her fur-trimmed winter coat with floral hair ornaments'],
  ['natsume_sleepwear', 'her pale blue sleepwear'],
])

function outfitPhrases(plan: PromptPlan): string[] {
  if (plan.outfitProse) return [clean(plan.outfitProse)]
  const keys = new Set(plan.exactControls.map(normalizeProseKey))
  const canonical = KREA_CANONICAL_OUTFITS.find(([key]) => keys.has(key))
  if (canonical) return [canonical[1]]
  // 角色主词（preserveTokens = exactTokens）是**身份**不是服装。outfitProse 为空时
  // 这条回退会把 controls 里剩下的东西当服装描述渲染；热门角色基础提示词瘦身后
  // controls 只剩主词，于是渲染出 "She wears mika (blue archive" 这类病句
  // （2026-08-29 实测）。回退推断必须先排除主词。
  const identityKeys = new Set(plan.preserveTokens.map(normalizeProseKey))
  return plan.exactControls
    .filter(token => {
      const key = normalizeProseKey(token)
      if (!key || identityKeys.has(key)) return false
      return !KREA_META_KEYS.has(key) && !KREA_IDENTITY_KEYS.has(key) && !/^(?:nene|natsume)_r18$/.test(key)
    })
    .map(proseToken)
    .filter(Boolean)
}

/** 纯英文门控：非 ASCII 输入直接丢弃（Anima/Krea 是英文模型）。
 *  2026-08-15 审计：自由输入的 visualDescription 必须过此门控，禁止中文直入英文模型；
 *  健康面板（composables）用同一函数提示用户描述被丢弃。 */
export function plainEnglish(value: unknown): string {
  const text = String(value || '').trim()
  return text && /^[\x20-\x7e]+$/.test(text) ? text : ''
}

function mappedPhrases(value: unknown, mappings: ReadonlyArray<readonly [RegExp, string]>): string[] {
  const text = String(value || '').trim()
  if (!text) return []
  const english = plainEnglish(text)
  if (english) return [english]
  return mappings.filter(([pattern]) => pattern.test(text)).map(([, phrase]) => phrase)
}

const LOCATION_PHRASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/卧室|主卧|床榻|大床|被窝|宿舍/, 'inside a bedroom'],
  [/咖啡馆|咖啡厅|café|咖啡吧台|猫咖啡/i, 'inside a cafe'],
  [/浴室|洗手台|温泉|风吕|汤池/, 'inside a bathroom'],
  [/客厅|家庭影音室/, 'inside a living room'],
  [/教室|课桌/, 'inside a classroom'],
  [/厨房|料理台|后厨/, 'inside a kitchen'],
  [/图书馆|图书室|书库|书店/, 'inside a library'],
  [/海边|海滨|海岸|沙滩/, 'on a beach'],
  [/神社|古寺/, 'at a shrine'],
  [/天台|屋顶/, 'on a rooftop'],
  [/街头|街道|放学路|回家路|路口|步道/, 'on a street'],
  [/室内场景/, 'indoors'],
]

const WEATHER_PHRASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/暴雨|骤雨|大雨|雷雨/, 'during a rainstorm'],
  [/阴天|阴雨/, 'under an overcast sky'],
  [/雨/, 'in the rain'],
  [/雪/, 'in falling snow'],
  [/晴/, 'beneath a clear sky'],
  [/雾|氤氲/, 'in soft mist'],
  [/风/, 'in a light breeze'],
]

const SHOT_FIELD_PHRASE = {
  pov: 'a first-person point of view', detail: 'a detail close-up', close: 'a close-up',
  medium: 'a medium shot', wide: 'a full-body wide shot', high: 'a high angle',
  low: 'a low angle', side: 'a side view', turn: 'looking back over her shoulder', over: 'a selfie',
} as const
const LIGHT_FIELD_PHRASE = {
  golden: 'golden-hour light', window: 'window light', back: 'backlighting',
  moon: 'moonlight', lantern: 'lantern light', overcast: 'diffused overcast light',
} as const

function sceneFieldPhrases(scene: PromptSceneContext | null): string[] {
  if (!scene) return []
  const phrases: string[] = []
  phrases.push(...mappedPhrases(scene.location, LOCATION_PHRASES))
  const time = plainEnglish(scene.timeOfDay) || plainEnglish(scene.time)
  if (time) phrases.push(environmentPhrase(time))
  phrases.push(...mappedPhrases(scene.weather, WEATHER_PHRASES))
  return phrases
}

function sceneCameraPhrases(scene: PromptSceneContext | null): string[] {
  if (!scene) return []
  const shot = sceneShot(scene)
  return [shot ? SHOT_FIELD_PHRASE[shot] : '', /三分之四/.test(String(scene.camera || '')) ? 'a three-quarter view' : ''].filter(Boolean)
}

function sceneLightingPhrases(scene: PromptSceneContext | null): string[] {
  if (!scene) return []
  const text = String(scene.lighting || '')
  const lighting = sceneLighting(scene)
  return [
    lighting ? LIGHT_FIELD_PHRASE[lighting] : '',
    /轮廓光|边缘光/.test(text) ? 'soft rim light' : '',
    /暖光|暖灯|暖色|暖黄|橙光/.test(text) ? 'warm lighting' : '',
    /柔和|柔光/.test(text) ? 'soft lighting' : '',
  ].filter(Boolean)
}

function buildStructuredKreaDescription(plan: PromptPlan): string {
  const style = inferredKreaStyle(plan)
  const subject = clean(plan.subjectProse || proseList(plan.identity))
    .replace(/[.!?]+\s*/g, '; ')
    .replace(/;\s*$/, '')
  const exactKeys = new Set(plan.exactControls.map(normalizeProseKey))
  const outfit = outfitPhrases(plan)
  const hasCanonicalOutfit = Boolean(plan.outfitProse)
    || KREA_CANONICAL_OUTFITS.some(([key]) => exactKeys.has(key))

  const action: string[] = []
  const mood: string[] = [...plan.emotion.map(moodPhrase).filter(Boolean)]
  const environment: string[] = []
  const camera: string[] = [...plan.camera.map(cameraPhrase).filter(Boolean), ...sceneCameraPhrases(plan.scene)]
  const lighting: string[] = [...plan.lighting.map(lightPhrase).filter(Boolean), ...sceneLightingPhrases(plan.scene)]
  for (const token of [...plan.sceneVisualFragments, ...plan.manual]) {
    const key = normalizeProseKey(token)
    if (!key || KREA_META_KEYS.has(key) || KREA_IDENTITY_KEYS.has(key) || exactKeys.has(key)) continue
    if (KREA_ACTION_RE.test(key) || KREA_BODY_DETAIL_RE.test(key)) { action.push(actionPhrase(token)); continue }
    if (/(?:^|_)(?:hairclips?|hair_ribbons?|hair_ornaments?)(?:_|$)/.test(key)) continue
    if (KREA_CAMERA_KEYS.has(key)) { camera.push(cameraPhrase(token)); continue }
    if (KREA_LIGHT_KEYS.has(key) || /(?:light|lighting|shadow|shadows|backlit)$/.test(key)) { lighting.push(lightPhrase(token)); continue }
    if (KREA_OUTFIT_RE.test(key)) {
      if (hasCanonicalOutfit) continue
      if (key === 'apron_only' && outfit.some(item => /only .*apron/i.test(item))) continue
      outfit.push(outfitPhrase(token))
      continue
    }
    if (KREA_MOOD_RE.test(key)) { mood.push(moodPhrase(token)); continue }
    if (isEnvironmentKey(key) || /^(?:morning|afternoon|evening|night|late_night|dawn|sunset|clear_sky|starry_sky|rain|snow|snowfall)$/.test(key)) {
      environment.push(environmentPhrase(token))
      continue
    }
    action.push(actionPhrase(token))
  }
  environment.unshift(...sceneFieldPhrases(plan.scene))
  if (environment.some(item => /inside|indoors/.test(item))) {
    for (let index = environment.length - 1; index >= 0; index -= 1) {
      if (/beneath a (?:clear|starry) sky/.test(environment[index])) environment.splice(index, 1)
    }
  }
  if (environment.includes('late at night')) {
    const nightIndex = environment.indexOf('at night')
    if (nightIndex >= 0) environment.splice(nightIndex, 1)
  }

  const parts = [style]
  // 2026-08-30：身份保护句（防止 Krea 散文扩写将热门角色泛化为通用动漫）。
  // 调研 + 样图对照：别人在 prompt 开头明确 "Preserve <Name>'s iconic recognizable
  // character identity, existing appearance and original design logic..." 锁定
  // 角色视觉指纹；项目 5 桶拼接把 identityProse 淹没在散文中，没有"保护"指令，
  // Krea 内部扩写倾向把 IP 角色泛化（出图不认角色）。提取 subjectProse 头部
  // 角色名（兼容 "Name from Series" / "Name, the role" / "Alias, Name from" /
  // "Name (Alias) from" 四种常见身份散文开头），注入保护句。
  if (subject) {
    // 兼容 "Name from Series" / "Name, the role" / "Alias, Name from" /
    // "Name (Alias) from"（括号别名如 Reze (Bomb Devil)；连词如 Jeanne d'Arc）。
    // 取「从开头到大写单词序列结束」为止的名字：遇到 ", " / " (" / " from " 即停。
    const nameMatch = subject.match(/^([A-Z][A-Za-z'-]*(?:\s+(?!from\s)[A-Za-z][A-Za-z'-]*)*)(?=\s+from\s+|,|\s*\()/)
    const ipName = nameMatch ? nameMatch[1].trim() : null
    if (ipName) {
      parts.push(sentence(
        `Preserve ${ipName}'s iconic recognizable character identity, her established appearance, and her original design logic. Do not substitute the character with a generic anime girl.`,
      ))
    }
  }
  const outfitText = naturalList(outfit)
  if (subject) parts.push(sentence(outfitText ? `${subject}, wearing ${outfitText}` : subject))
  const actionText = naturalList(action.map(proseClause))
  const moodText = naturalList(compactMood(mood))
  const portrayal: string[] = []
  if (actionText) portrayal.push(`She is ${actionText}`)
  if (moodText) portrayal.push(`${actionText ? 'her' : 'Her'} expression is ${moodText}`)
  if (plan.visualDescription) portrayal.push(clean(plan.visualDescription).replace(/[.!?]+\s*/g, '; ').replace(/;\s*$/, ''))
  if (portrayal.length) parts.push(sentence(portrayal.join(actionText && moodText ? ', while ' : ', ')))
  const environmentText = plan.sceneProse
    ? clean(plan.sceneProse).replace(/[.!?]+\s*/g, '; ').replace(/;\s*$/, '')
    : naturalList(environment)
  // 2026-08-30 调研 §七/§八：Krea 见「室内/场景」就爱画人，官方推荐空场景
  // 在正句追加 "no characters, no people, no figures"（本地 Turbo 负面失效的
  // 替代通道）。判定：散文里确实没有主体（无 subject 描述、环境句也不含
  // 人物代词）时追加——热门角色恒有 subjectProse 不会误伤；纯背景/风景
  // 场景（studio 背景图）自动兜底。
  const emptySceneGuard = !subject && !outfitText && Boolean(environmentText)
    && !/no characters|no people|no figures/i.test(environmentText)
    && !/\b(?:she|her|girl|woman|figure|character|person)\b/i.test(environmentText)
  if (environmentText) {
    parts.push(sentence(
      `${plan.sceneProse ? environmentText : `The scene takes place ${environmentText}`}${emptySceneGuard ? '; no characters, no people, no figures' : ''}`,
    ))
  }
  const direction = naturalList([...camera, ...plan.composition.map(cameraPhrase).filter(Boolean)])
  const atmosphere = naturalList(lighting)
  if (direction || atmosphere) {
    const clauses: string[] = []
    if (direction) clauses.push(`The composition uses ${direction}`)
    if (atmosphere) clauses.push(`the scene is lit by ${atmosphere}`)
    parts.push(sentence(clauses.join(', while ')))
  }
  // 2026-08-30 调研 §四/§五.2：媒介词（medium）放散文末尾收尾——官方
  // 「命名工作室收尾」让模型承诺特定完成度（polished X style/finish）。
  // 此前 medium 被 sanitize 但从未织入渲染输出（审计发现），这里补上；
  // lead 已含同一媒介短语时跳过，避免 "visual novel event CG" 重复两遍。
  const medium = sanitizeKreaProse(plan.medium)
  if (medium && !style.toLowerCase().includes(medium.toLowerCase())) {
    parts.push(sentence(`polished ${medium} finish`))
  }
  const assembled = parts.filter(Boolean).join(' ')
  const sentences = assembled.split(/(?<=\.)\s/).filter(Boolean)
  if (sentences.length > 5) {
    const head = sentences.slice(0, 4).join(' ')
    const tail = sentences.slice(4).join('; ')
    return `${head} ${tail}`
  }
  return assembled
}

const ANIMA_RELATION_RE = /^(?:holding|carrying|standing|sitting|lying|waiting|leaning|kneeling|straddling|clinging|swimming|walking|running|reaching|undressing|looking|turning|adjusting|hug|hugging|back_hug|kiss|kissing|touch|touching|press|pressed|hands?|one_hand|both_hands|playing|reading|writing|drinking|eating|cooking|dancing|sleeping|crying|smiling|eye_contact|close_distance|interlocked_fingers|bare_|nude|naked|cleavage|sideboob|no_bra|no_panties|wet_skin|wet_clothes|see_through|translucent|unbuttoned|unzipped|open_shirt|off_shoulder|high_slit|midriff|collarbone)/

function proseClause(value: string): string {
  return clean(value)
    .replace(/[.!?]+\s*/g, '; ')
    .replace(/(?:;\s*)+$/g, '')
    .trim()
}

function compactPhrases(values: string[], limit: number): string[] {
  return [...new Set(values.map(value => clean(value)).filter(Boolean))].slice(0, limit)
}

function actionPriority(value: string): number {
  const text = value.toLowerCase()
  if (/holding|carrying|adjusting|hands?|wrapper|cup|letter|papers|sandals/.test(text)) return 0
  if (/looking|eye contact|turning/.test(text)) return 1
  return 2
}

function compactActions(values: string[], limit: number): string[] {
  return [...new Set(values.map(value => clean(value)).filter(Boolean))]
    .map((value, index) => ({ value, index, priority: actionPriority(value) }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .slice(0, limit)
    .map(item => item.value)
}

/**
 * 全局视觉瑕疵防御过滤器：
 * 阻断将「耳红/害羞」误译为 burning ears / flaming red 的病态词导致模型画出物理火苗/耳朵冒火。
 */
export function sanitizeVisualArtifacts(text: string): string {
  if (!text) return ''
  return text
    .replace(/\b(?:ears?\s+(?:burn(?:ing)?|flam(?:ing)?)(?:\s+completely)?(?:\s+bright)?(?:\s+red)?|(?:burn(?:ing)?|flam(?:ing)?)\s+(?:bright\s+)?red\s+ears?)\b/gi, 'flushed cheeks')
    .replace(/\b(?:flaming|burning)\s+red\s+ears?\b/gi, 'flushed cheeks')
    .replace(/\bburning_red_ears\b/gi, 'blush')
    .replace(/\bburning\s+(?:face|cheeks?)\b/gi, 'flushed cheeks')
    .replace(/\b(?:red|blushing|crimson)\s+ears?\b/gi, 'flushed cheeks')
    .replace(/\bears?\s+(?:flushed\s+crimson|flush\s+(?:bright\s+)?crimson)\b/gi, 'flushed cheeks')
}

function buildStudioAnimaCaption(plan: PromptPlan): string {
  const explicit = sanitizeVisualArtifacts(proseClause(String(plan.scene?.animaCaption || '')))
  if (explicit) return sentence(explicit)

  const identityKeys = new Set(plan.identity.map(normalizeProseKey))
  const exactKeys = new Set(plan.exactControls.map(normalizeProseKey))
  const actions: string[] = []
  const environment: string[] = []
  const camera: string[] = [...plan.camera.map(cameraPhrase).filter(Boolean), ...sceneCameraPhrases(plan.scene)]
  const lighting: string[] = [...plan.lighting.map(lightPhrase).filter(Boolean), ...sceneLightingPhrases(plan.scene)]
  for (const token of [...plan.sceneVisualFragments, ...plan.manual]) {
    const key = normalizeProseKey(token)
    if (!key || KREA_META_KEYS.has(key) || identityKeys.has(key) || exactKeys.has(key)) continue
    if (QUALITY_OR_SCORE_RE.test(key) || /^(?:general|sensitive|safe|nsfw)$/.test(key)) continue
    if (ANIMA_RELATION_RE.test(key)) { actions.push(actionPhrase(token)); continue }
    if (KREA_CAMERA_KEYS.has(key)) { camera.push(cameraPhrase(token)); continue }
    if (KREA_LIGHT_KEYS.has(key) || /(?:light|lighting|shadow|shadows|backlit)$/.test(key)) { lighting.push(lightPhrase(token)); continue }
    if (isEnvironmentKey(key) || /^(?:morning|afternoon|evening|night|late_night|dawn|sunset|rain|snow|snowfall)$/.test(key)) {
      environment.push(environmentPhrase(token))
    }
  }
  environment.push(...sceneFieldPhrases(plan.scene))

  const clauses: string[] = []
  if (plan.visualDescription) clauses.push(proseClause(plan.visualDescription))
  const actionText = naturalList(compactActions(actions, 2))
  if (actionText) clauses.push(`She is ${actionText}`)
  const environmentText = naturalList(compactPhrases(environment, 2))
  if (environmentText) clauses.push(`the scene is ${environmentText}`)
  const direction = naturalList(compactPhrases([...camera, ...plan.composition.map(cameraPhrase).filter(Boolean)], 2))
  if (direction) clauses.push(`framed with ${direction}`)
  const atmosphere = naturalList(compactPhrases(lighting, 3))
  if (atmosphere) clauses.push(`lit by ${atmosphere}`)
  return sentence(clauses.join('; '))
}

/**
 * Anima keeps its model-native tag stream for LoRA control. Studio scenes add
 * one short caption for spatial/prop relationships; popular no-LoRA subjects
 * retain the fuller identity/outfit/blueprint description. Only PromptPlan visual fields are read;
 * title, story, dialogue, search metadata, and audit metadata never enter here.
 */
function buildAnimaVisualDirection(plan: PromptPlan): string {
  const structured = Boolean(plan.subjectProse || plan.outfitProse || plan.sceneProse || plan.scene)
  if (!structured) return sentence(plan.visualDescription)
  if (plan.scene) return buildStudioAnimaCaption(plan)

  const identityKeys = new Set(plan.identity.map(normalizeProseKey))
  const exactKeys = new Set(plan.exactControls.map(normalizeProseKey))
  const authoredDetails: string[] = []
  const actions: string[] = []
  const mood: string[] = [...plan.emotion.map(moodPhrase).filter(Boolean)]
  const environment: string[] = []
  const camera: string[] = [...plan.camera.map(cameraPhrase).filter(Boolean), ...sceneCameraPhrases(plan.scene)]
  const lighting: string[] = [...plan.lighting.map(lightPhrase).filter(Boolean), ...sceneLightingPhrases(plan.scene)]

  for (const token of [...plan.sceneVisualFragments, ...plan.manual]) {
    const key = normalizeProseKey(token)
    if (!key || KREA_META_KEYS.has(key) || identityKeys.has(key) || exactKeys.has(key)) continue
    if (QUALITY_OR_SCORE_RE.test(key) || /^(?:general|sensitive|safe|nsfw)$/.test(key)) continue
    if (ANIMA_RELATION_RE.test(key)) { actions.push(actionPhrase(token)); continue }
    if (/(?:^|_)(?:hairclips?|hair_ribbons?|hair_ornaments?)(?:_|$)/.test(key)) continue
    if (KREA_CAMERA_KEYS.has(key)) { camera.push(cameraPhrase(token)); continue }
    if (KREA_LIGHT_KEYS.has(key) || /(?:light|lighting|shadow|shadows|backlit)$/.test(key)) { lighting.push(lightPhrase(token)); continue }
    // Composite actions can contain outfit nouns (for example adjusting a hair ribbon).
    // Classify the action before the outfit/environment buckets so it is not discarded.
    if (KREA_OUTFIT_RE.test(key)) continue
    if (KREA_MOOD_RE.test(key)) { mood.push(moodPhrase(token)); continue }
    if (isEnvironmentKey(key) || /^(?:morning|afternoon|evening|night|late_night|dawn|sunset|clear_sky|starry_sky|rain|snow|snowfall)$/.test(key)) {
      environment.push(environmentPhrase(token))
      continue
    }
    if (/[.!?]/.test(token) || token.trim().split(/\s+/).length >= 8) {
      authoredDetails.push(proseClause(token))
      continue
    }
  }

  environment.unshift(...sceneFieldPhrases(plan.scene))
  if (environment.some(item => /inside|indoors/.test(item))) {
    for (let index = environment.length - 1; index >= 0; index -= 1) {
      if (/beneath a (?:clear|starry) sky/.test(environment[index])) environment.splice(index, 1)
    }
  }

  const subject = proseClause(plan.subjectProse || proseList(plan.identity))
  const outfit = outfitPhrases(plan)[0]
  const portrayal: string[] = []
  if (subject) portrayal.push(subject)
  if (outfit) portrayal.push(`She wears ${proseClause(outfit)}`)
  const authoredText = compactPhrases(authoredDetails, 2).join(', ')
  if (authoredText) portrayal.push(authoredText)
  const actionText = naturalList(compactPhrases(actions, 4))
  if (actionText) portrayal.push(`She is shown ${actionText}`)
  const moodText = naturalList(compactMood(compactPhrases(mood, 2)))
  if (moodText) portrayal.push(`Her expression is ${moodText}`)
  if (plan.visualDescription) portrayal.push(proseClause(plan.visualDescription))

  const setting: string[] = []
  if (plan.sceneProse) setting.push(proseClause(plan.sceneProse))
  else {
    const environmentText = naturalList(compactPhrases(environment, 3))
    if (environmentText) setting.push(`The scene takes place ${environmentText}`)
  }
  const direction = naturalList(compactPhrases([
    ...camera,
    ...plan.composition.map(cameraPhrase).filter(Boolean),
  ], 2))
  if (direction) setting.push(`Frame it with ${direction}`)
  const atmosphere = naturalList(compactPhrases(lighting, 2))
  if (atmosphere) setting.push(`Light it with ${atmosphere}`)
  setting.push('Compose it as a finished anime wallpaper with a clear focal subject, layered background depth, and cinematic atmosphere')

  return [sentence(portrayal.join('; ')), sentence(setting.join('; '))].filter(Boolean).join(' ')
}

export function createPromptPlan(input: PromptCompilerInput): PromptPlan {
  return {
    quality: split(input.profile?.quality_prefix), rating: input.rating ? [input.rating] : [],
    identity: split(input.identity), exactControls: [...new Set(input.controls || [])],
    artists: [...new Set(input.artists || [])],
    preserveTokens: [...new Set(input.exactTokens || [])],
    sceneVisualFragments: split(input.scenePrompt), emotion: [...(input.emotion || [])],
    camera: [...(input.camera || [])], lighting: [...(input.lighting || [])],
    composition: [...(input.composition || [])], manual: [...(input.manual || [])],
    negative: split(input.negative), visualDescription: plainEnglish(input.visualDescription),
    style: [...new Set(input.style || [])],
    medium: String(input.medium || '').trim(),
    subjectProse: String(input.subjectProse || '').trim(),
    outfitProse: String(input.outfitProse || '').trim(),
    sceneProse: String(input.sceneProse || '').trim(),
    scene: input.scene ?? null,
    artistProse: String(input.artistProse || '').trim(),
  }
}

function allTags(plan: PromptPlan, includeStyle = true): string[] {
  const raw = [ ...plan.quality, ...plan.rating, ...plan.identity, ...plan.exactControls, ...plan.artists,
    ...(includeStyle ? plan.style : []), ...plan.sceneVisualFragments, ...plan.emotion, ...plan.camera, ...plan.lighting,
    ...plan.composition, ...plan.manual ].filter(Boolean)
  return raw.map(tag => {
    const k = normalizeProseKey(tag)
    if (k === 'burning_red_ears' || k === 'blushing_ears' || k === 'red_ears') return 'blush'
    return tag
  })
}

/** Krea 散文禁词（score/质量词），由 promptPolicy.QUALITY_WORDS 单一清单派生。 */
const KREA_BANNED_WORDS_RE = new RegExp(`\\b(?:${QUALITY_WORDS.join('|')}|score_\\d+)\\b`, 'gi')

/**
 * Krea 2 散文统一净化 —— krea2 渲染分支入口的唯一强制点（与「负面恒空」并列）。
 * 三条铁律：禁 (tag:1.5) 权重语法、禁下划线 token、禁 score/质量词。
 * subjectProse/outfitProse/sceneProse/visualDescription/artistProse/style/medium
 * 全部先过这里，禁止在调用方各自擦除（2026-08-15 审计：此前 sceneProse 等只过
 * clean()，场景模板里的 (xxx:1.5) 会以字面文本进入 Krea）。
 */
function sanitizeKreaProse(value: string): string {
  return sanitizeVisualArtifacts(String(value || '')
    .replace(/<lora:[^>]+>/gi, '')
    .replace(/\bBREAK\b/gi, ', ')
    .replace(/\(([^()\n]*[a-z][^()\n]*):\s*-?\d+(?:\.\d+)?\s*\)/gi, '$1')
    .replace(KREA_BANNED_WORDS_RE, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim())
}

export function renderPromptPlan(plan: PromptPlan, family: PromptFamily, profile?: ModelProfile | null): { prompt: string; negative: string } {
  const capabilities = resolveDrawCapabilities(family, profile)
  if (capabilities.promptFormat === 'natural-language') {
    const proseSafe: PromptPlan = {
      ...plan,
      subjectProse: sanitizeKreaProse(plan.subjectProse),
      outfitProse: sanitizeKreaProse(plan.outfitProse),
      sceneProse: sanitizeKreaProse(plan.sceneProse),
      visualDescription: sanitizeKreaProse(plan.visualDescription),
      artistProse: sanitizeKreaProse(plan.artistProse),
      style: plan.style.map(sanitizeKreaProse).filter(Boolean),
      medium: sanitizeKreaProse(plan.medium),
    }
    return { prompt: buildStructuredKreaDescription(proseSafe), negative: '' }
  }
  let tags = allTags(plan)
  if (capabilities.promptFormat === 'anima-tags') {
    // Anima Aesthetic：正层全部去掉质量词与 score 词。
    if (profile?.strip_quality_tokens === true) {
      tags = tags.filter(token => !QUALITY_OR_SCORE_RE.test(String(token || '').trim()))
    }
    const formatted = formatPromptForEngine(
      tags.join(', '),
      'anima',
      plan.preserveTokens.concat(profile?.exact_tokens || []),
      profile?.exact_prefixes || [],
    )
    const direction = buildAnimaVisualDirection(plan)
    // 换行是可审计的标签/散文边界，不参与模型 token 去重或精确 LoRA 控制。
    return { prompt: [formatted, direction].filter(Boolean).join('\n'), negative: '' }
  }
  return { prompt: tags.join(', '), negative: plan.negative.join(', ') }
}

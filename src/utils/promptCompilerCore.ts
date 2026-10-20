import type { PromptFamily, PromptSceneContext, PromptPlan } from '../types/prompt'
export type { PromptFamily, PromptSceneContext, PromptPlan } from '../types/prompt'

import {
  formatPromptForEngine,
  normalizeKey,
  tokenize,
  type ModelProfile,
} from './promptPolicy.ts'
import { resolveDrawCapabilities } from './drawCapabilities.ts'
import { sceneLighting, sceneShot } from './sceneInference.ts'
import { authoredSceneCaption } from './promptCaption.ts'
import { lightingOverride, lightingTokenId } from './promptLighting.ts'
import { sanitizeKreaProse, sanitizeKreaTokens, sanitizeVisualArtifacts } from './promptVisualText.ts'
import { orderedAnimaTags } from './animaPromptOrder.ts'
import { cameraTokensFromText, mergeCameraControls, resolveCameraTags } from './promptCamera.ts'
import { compositionIntent, compositionTokens } from './blueprintComposition.ts'
import { SHOT, LIGHTING } from '../config/promptConstants.ts'
import { proseToken, normalizeProseKey, actionPhrase, outfitPhrase, moodPhrase, compactMood, cameraPhrase, lightPhrase, environmentPhrase, isEnvironmentKey, removeIndoorSkyPhrases } from './promptPhraseTables.ts'

export interface PromptCompilerInput {
  freeSubject?: boolean
  profile?: ModelProfile | null; identity?: string; controls?: string[]; scenePrompt?: string
  characterTokens?: string[]; copyrightTokens?: string[]
  artists?: string[]; artistProse?: string
  exactTokens?: string[]
  emotion?: string[]; camera?: string[]; lighting?: string[]; palette?: string[]; composition?: string[]
  authoredLighting?: string
  manual?: string[]; negative?: string; rating?: string; visualDescription?: string
  style?: string[]; medium?: string; subjectProse?: string; outfitProse?: string; sceneProse?: string
  scene?: PromptSceneContext | null
}

const split = (value: string | undefined): string[] => tokenize(value || '').filter(Boolean)
const clean = (value: string): string => value.replace(/<lora:[^>]+>/gi, '').replace(/\bBREAK\b/g, ', ').replace(/\s+/g, ' ').trim()
const capFirst = (value: string): string => value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : ''
const sentence = (value: string): string => { const text = clean(value); return text ? `${capFirst(text.replace(/[.!?]+$/, ''))}.` : '' }
const proseList = (values: string[]): string => [...new Set(values.map(proseToken).filter(Boolean))].join(', ').replace(/(?:,\s*){2,}/g, ', ')

function conflictsWithFairSkin(value: string): boolean {
  const text = normalizeKey(value).replace(/_/g, ' ')
  if (/^(?:tan|tanned|dark skinned (?:female|male))$/.test(text)) return true
  // Ignore negated skin descriptions; unrelated hair, eye and clothing colors do not match.
  const positive = text.replace(/\b(?:no|not|without|avoid|don't|doesn't|isn't|aren't)\s+(?:\w+\s+){0,3}skin(?:ned)?\b/g, '')
  return /\b(?:dark|tan|tanned|brown|black|olive|bronze|colored|blue|green|purple|red|gray|grey|orange|yellow|pink)\s+skin(?:ned)?\b/.test(positive)
}

const KREA_META_KEYS = new Set([
  '1girl', 'solo', '2girls', 'official_cg', 'visual_audited', 'landscape', 'portrait',
  'general', 'sensitive', 'safe', 'explicit', 'adult', 'visual_novel_event_cg',
  'nene_r18', 'natsume_r18', 'adult_after_story', 'official_visual_novel_cg_framing',
])
const KREA_CAMERA_KEYS = new Set([
  'close_up', 'extreme_close_up', 'close_up_detail', 'medium_shot', 'upper_body',
  'half_body', 'waist_up', 'cowboy_shot', 'wide_shot', 'long_shot', 'full_body',
  'pov', 'pov_shot', 'high_angle', 'low_angle', 'from_above', 'from_below',
  'side_view', 'from_side', 'front_view', 'back_view', 'from_behind', 'profile', 'dutch_angle', 'cinematic_16_9_clockwise_dutch_angle',
  'waist_up_close_shot', 'portrait_shot', 'establishing_shot', 'face_focus',
  'three_quarter_view', 'over_the_shoulder', 'selfie', 'eye_level',
  'front_three_quarter_view', 'rear_three_quarter_view', 'back_three_quarter_view', 'side_three_quarter_view',
])
const KREA_LIGHT_KEYS = new Set([
  'window_light', 'golden_hour', 'golden_light', 'backlight', 'backlit', 'rim_light',
  'moonlight', 'lantern_light', 'overcast', 'soft_light', 'soft_lighting',
  'warm_light', 'warm_lighting', 'cinematic_lighting', 'volumetric_lighting',
])
const KREA_OUTFIT_RE = /(?:^|_)(?:clothes|clothing|outfit|uniform|shirt|blouse|skirt|miniskirt|dress|apron|lingerie|underwear|panties|bra|bikini|swimsuit|pantyhose|thighhighs|stockings|tights|socks|scarf|tabi|geta|coat|sweater|cardigan|pajamas|sleepwear|nightgown|towel|yukata|kimono|furisode|obi|qipao|cheongsam|robe|jacket|blazer|collar|sleeves|gloves|boots|shoes|bow|ribbon|maid|serafuku|tactical_gear|office_lady)(?:_|$)/
const KREA_BODY_DETAIL_RE = /^(?:nude|naked|fully_nude|bare_|cleavage|sideboob|underboob|no_bra|no_panties|panties_aside|pulling_down_panties|unbuttoned|unzipped|open_shirt|off_shoulder|high_slit|midriff|collarbone|navel|slender_thighs|nipples|areola|pussy|cameltoe|breasts_out|topless|bottomless|lifted_skirt|legs_apart|spread_legs|parted_lips|open_mouth|ahegao|closed_eyes|half_closed_eyes|averting_gaze|blushing|deep_blush|heavy_blush|heavy_breathing|drooling|wet_skin|wet_hair|wet_clothes|sweat|sweaty_skin|see_through|translucent|hugging_pillow|sex|intercourse|vaginal|anal|oral|fellatio|blowjob|deepthroat|cunnilingus|paizuri|titfuck|handjob|fingering|masturbation|female_masturbation|missionary|doggystyle|cowgirl_position|mating_press|spooning|grinding|penetration|cum|cum_on_face|cum_in_mouth|cum_on_breasts|cum_on_body|internal_cumshot|creampie|excessive_cum|after_sex|panty_pull|skirt_lift|grabbed_breasts|groping)/
const KREA_ACTION_RE = /^(?:holding|carrying|standing|sitting|lying|waiting|leaning|kneeling|straddling|clinging|swimming|walking|running|reaching|undressing|looking|turning|adjusting|sweeping|tripping|squeezing|hand_gripping|skirt_hem_caught|one_hand|both_hands|propped|cross_legged|legs_apart|skirt_lift|neck_kiss|eye_contact|close_distance)(?:_|$)/
const KREA_MOOD_RE = /(?:^|_)(?:smile|blush|shy|happy|calm|relaxed|serious|sad|melancholic|nervous|expectant|panicked|embarrassed|tears|tearful|teary|tsundere|sensual|intimate|romantic|seductive|passionate|expressionless|in_love|soft_eyes|bright_eyes|red_ears|heavy_breathing)(?:_|$)/

function naturalList(values: string[]): string {
  const seen = new Set<string>()
  const unique = values.map(value => value.trim()).filter(value => {
    const key = value.toLowerCase().replace(/[_\s]+/g, ' ')
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (!unique.length) return ''
  if (unique.length === 1) return unique[0]
  if (unique.length === 2) return `${unique[0]} and ${unique[1]}`
  return `${unique.slice(0, -1).join(', ')}, and ${unique[unique.length - 1]}`
}

function inferredKreaStyle(plan: PromptPlan): string {
  const explicit = plan.style.map(sentence).find(Boolean)
  if (explicit) return plan.artistProse
    ? sentence(`${explicit.replace(/[.!?]+$/, '')}, ${plan.artistProse}`)
    : explicit
  const scene = plan.scene
  if (!scene && !plan.sceneProse) return sentence(plan.artistProse)
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
  const keys = new Set([...plan.exactControls, ...plan.sceneVisualFragments].map(normalizeProseKey))
  const canonical = KREA_CANONICAL_OUTFITS.find(([key]) => keys.has(key))
  if (canonical) return [canonical[1]]
  // 角色主词（preserveTokens = exactTokens）是**身份**不是服装。outfitProse 为空时
  // 这条回退会把 controls 里剩下的东西当服装描述渲染；热门成人蓝图的 controls
  // 还可能包含 kneeling / on_back / completely_nude 等动作与身体状态，不能生成
  // "She wears kneeling" 这类病句。只允许服装词进入回退；动作、镜头、身体状态
  // 仍由 sceneVisualFragments / sceneProse 分别承载。
  const identityKeys = new Set(plan.preserveTokens.map(normalizeProseKey))
  return plan.exactControls
    .filter(token => {
      const key = normalizeProseKey(token)
      if (!key || identityKeys.has(key)) return false
      return KREA_OUTFIT_RE.test(key)
        && !KREA_META_KEYS.has(key)
        && !/^(?:nene|natsume)_r18$/.test(key)
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
  [/浴室|洗手台/, 'inside a bathroom'],
  [/温泉|风吕|汤池/, 'at a bathing pool'],
  [/露天|户外/, 'outdoors'],
  [/客厅|家庭影音室/, 'inside a living room'],
  [/教室|课桌/, 'inside a classroom'],
  [/厨房|料理台|后厨/, 'inside a kitchen'],
  [/图书馆|图书室|书库/, 'inside a library'],
  [/书店/, 'inside a bookstore'],
  [/玄关|门厅/, 'inside an entrance hall'],
  [/礼堂|颁奖台/, 'inside an auditorium'],
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

function sceneFieldPhrases(scene: PromptSceneContext | null): string[] {
  if (!scene) return []
  const phrases: string[] = []
  phrases.push(...mappedPhrases(scene.location, LOCATION_PHRASES))
  const time = plainEnglish(scene.timeOfDay) || plainEnglish(scene.time)
  if (time) phrases.push(environmentPhrase(time))
  phrases.push(...mappedPhrases(scene.weather, WEATHER_PHRASES))
  return phrases
}

function sceneCameraTokens(scene: PromptSceneContext | null): string[] {
  if (!scene) return []
  const shot = sceneShot(scene)
  return [SHOT.find(option => option.id === shot)?.prompt || '', /三分之四/.test(String(scene.camera || '')) ? 'three-quarter view' : ''].filter(Boolean)
}

function sceneLightingPhrases(scene: PromptSceneContext | null, replacedSource?: string): string[] {
  if (!scene) return []
  const text = String(scene.lighting || '')
  const lighting = sceneLighting(scene)
  return [
    lighting && !replacedSource ? lightPhrase(LIGHTING.find(option => option.id === lighting)?.prompt || '') : '',
    /轮廓光|边缘光/.test(text) ? 'soft rim light' : '',
    replacedSource !== 'lantern' && /暖光|暖灯|暖色|暖黄|橙光/.test(text) ? 'warm lighting' : '',
    /柔和|柔光/.test(text) ? 'soft lighting' : '',
  ].filter(Boolean)
}

function buildStructuredKreaDescription(plan: PromptPlan): string {
  const style = inferredKreaStyle(plan)
  const dual = plan.identity.some(token => normalizeProseKey(token) === '2girls')
  const subject = clean(plan.subjectProse || proseList(plan.identity))
  const subjectText = `_${normalizeProseKey(subject).replace(/[.,;:]/g, '_')}_`
  const identityKeys = new Set(plan.identity.map(normalizeProseKey))
  const exactKeys = new Set(plan.exactControls.map(normalizeProseKey))
  const outfitKeys = new Set([...exactKeys, ...plan.sceneVisualFragments.map(normalizeProseKey)])
  const outfit = outfitPhrases(plan)
  const consumedOutfitKey = !plan.outfitProse
    ? KREA_CANONICAL_OUTFITS.find(([key]) => outfitKeys.has(key))?.[0] : undefined
  const authoredProse = plan.sceneProse || sanitizeKreaProse(plainEnglish(plan.scene?.animaCaption))

  const action: string[] = []
  const artists = [...plan.artists].map(token => proseToken(token.replace(/^@/, '')))
  const mood: string[] = [...plan.emotion.map(moodPhrase).filter(Boolean)]
  const environment: string[] = []
  const manualBackground: string[] = []
  const camera: string[] = []
  const lighting: string[] = [...plan.lighting.map(lightPhrase).filter(Boolean), ...sceneLightingPhrases(plan.scene, lightingOverride(plan)?.source)]
  for (const token of resolveCameraTags([...plan.camera, ...sceneCameraTokens(plan.scene), ...plan.sceneVisualFragments, ...plan.manual], plan.manual, plan.camera)) {
    const key = normalizeProseKey(token)
    if (!key || KREA_META_KEYS.has(key) || exactKeys.has(key) || key === consumedOutfitKey) continue
    if (identityKeys.has(key) && subjectText.includes(`_${key}_`)) continue
    if (/^no_hair_ribbons?$/.test(key) && subject.includes('no ribbons in her hair')) continue
    if (token.startsWith('@')) { artists.push(proseToken(token.slice(1))); continue }
    if (KREA_ACTION_RE.test(key) || key.startsWith('folding_') || KREA_BODY_DETAIL_RE.test(key)) { action.push(actionPhrase(token)); continue }
    if (KREA_CAMERA_KEYS.has(key)) { camera.push(cameraPhrase(token)); continue }
    if (KREA_LIGHT_KEYS.has(key) || /(?:light|lighting|shadow|shadows|backlit)$/.test(key)) { lighting.push(lightPhrase(token)); continue }
    if (KREA_OUTFIT_RE.test(key) && !/_(?:on|over|beside|under)_/.test(key)) {
      if (key === 'apron_only' && outfit.some(item => /only .*apron/i.test(item))) continue
      outfit.push(outfitPhrase(token).replace(/^(?:wearing|dressed in)\s+/i, ''))
      continue
    }
    if (KREA_MOOD_RE.test(key) && key !== 'red_ears') { mood.push(moodPhrase(token)); continue }
    if (isEnvironmentKey(key) || /^(?:morning|afternoon|evening|night|late_night|dawn|sunset|clear_sky|starry_sky|rain|snow|snowfall)$/.test(key)) {
      environment.push(environmentPhrase(token))
      if (isEnvironmentKey(key) && plan.manual.includes(token)) manualBackground.push(proseToken(token))
      continue
    }
    action.push(actionPhrase(token))
  }
  environment.unshift(...sceneFieldPhrases(plan.scene))
  removeIndoorSkyPhrases(environment)
  if (environment.includes('late at night')) {
    const nightIndex = environment.indexOf('at night')
    if (nightIndex >= 0) environment.splice(nightIndex, 1)
  }

  const parts = [style]
  if (artists.length) parts.push(sentence(`Use artistic influences from ${naturalList(artists)}`))
  const outfitText = naturalList(outfit)
  if (subject) parts.push(sentence(subject))
  // Outfit prose may already be a complete sentence; do not attach it to "wearing".
  if (outfitText) parts.push(sentence(`Clothing: ${outfitText}`))
  const actionText = naturalList(action.map(proseClause))
  const moodText = naturalList(compactMood(mood))
  const portrayal: string[] = []
  if (actionText) portrayal.push(`Include ${actionText}`)
  if (moodText) portrayal.push(dual ? `their expressions are ${moodText}` : `${actionText ? 'her' : 'Her'} expression is ${moodText}`)
  if (plan.visualDescription) portrayal.push(clean(plan.visualDescription).replace(/[.!?]+\s*/g, '; ').replace(/;\s*$/, ''))
  if (portrayal.length) parts.push(sentence(portrayal.join(actionText && moodText ? ', while ' : ', ')))
  // 精简蓝图将环境与镜头放在标签，关系放在 prose；两个通道都须消费。
  if (authoredProse) parts.push(sentence(authoredSceneCaption(plan, authoredProse, false)))
  const environmentText = naturalList(environment)
  // 2026-08-30 调研 §七/§八：Krea 见「室内/场景」就爱画人，官方推荐空场景
  // 在正句追加 "no characters, no people, no figures"（本地 Turbo 负面失效的
  // 替代通道）。判定：散文里确实没有主体（无 subject 描述、环境句也不含
  // 人物代词）时追加——热门角色恒有 subjectProse 不会误伤；纯背景/风景
  // 场景（studio 背景图）自动兜底。
  const emptySceneGuard = !subject && !outfitText && Boolean(environmentText)
    && !/no characters|no people|no figures/i.test(environmentText)
    && !/\b(?:she|her|girl|woman|figure|character|person)\b/i.test(`${environmentText} ${authoredProse}`)
  if (environmentText) {
    parts.push(sentence(
      `The scene takes place ${environmentText}${emptySceneGuard ? '; no characters, no people, no figures' : ''}`,
    ))
  }
  // Authored blueprint/recipe prose also carries actions and spatial relations, so keep it.
  // Its presence must not swallow manual background tags; make their narrower priority explicit.
  if (authoredProse && manualBackground.length) {
    parts.push(sentence(`For the background, use ${naturalList(manualBackground)} in preference to the earlier setting`))
  }
  const direction = naturalList([...camera, ...plan.composition.map(cameraPhrase).filter(Boolean)])
  const atmosphere = naturalList(lighting)
  const palette = naturalList(plan.palette.map(proseToken).filter(Boolean))
  if (direction || atmosphere || palette) {
    const clauses: string[] = []
    if (direction) clauses.push(`The composition uses ${direction}`)
    if (atmosphere) clauses.push(`the scene is lit by ${atmosphere}`)
    if (palette) clauses.push(`the color palette uses ${palette}`)
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
  return parts.filter(Boolean).join(' ')
}

/** Free subjects retain all supplied people and relationships without assigning a default gender. */
function buildFreeKreaDescription(plan: PromptPlan): string {
  const tokens = resolveCameraTags([...plan.identity, ...plan.exactControls, ...plan.sceneVisualFragments,
    ...plan.emotion, ...plan.camera, ...plan.lighting, ...plan.palette, ...plan.composition, ...plan.manual], plan.manual, plan.camera)
  const details: string[] = [], camera: string[] = [], lighting: string[] = [], subjects: string[] = [], artists: string[] = []
  for (const token of tokens) {
    const safe = sanitizeKreaProse(token), key = normalizeProseKey(safe)
    if (!key) continue
    const count = /^(\d+)\+?(girls?|boys?|others?|people)$/.exec(safe.toLowerCase().replace(/\s+/g, ''))
    if (count) {
      const kind = /^girl/.test(count[2]) ? 'female character' : /^boy/.test(count[2]) ? 'male character' : 'person'
      subjects.push(`${count[1]}${token.includes('+') ? ' or more' : ''} ${Number(count[1]) === 1 ? kind : kind === 'person' ? 'people' : `${kind}s`}`)
    } else if (safe.startsWith('@')) artists.push(safe.slice(1))
    else if (key === 'solo') subjects.push('a single subject')
    else if (key === 'no_humans') subjects.push('no people')
    else if (KREA_META_KEYS.has(key)) continue
    else if (KREA_CAMERA_KEYS.has(key)) camera.push(cameraPhrase(safe))
    else if (KREA_LIGHT_KEYS.has(key) || /(?:light|lighting|shadow|shadows|backlit)$/.test(key)) lighting.push(lightPhrase(safe))
    else details.push(actionPhrase(safe))
  }
  return [
    ...plan.style.map(sentence), sentence(plan.artistProse),
    artists.length ? sentence(`Use artistic influences from ${naturalList(artists)}`) : '',
    subjects.length ? sentence(`The image contains ${naturalList(subjects)}`) : '',
    details.length ? sentence(`Include ${naturalList(details)}`) : '',
    plan.sceneProse ? sentence(authoredSceneCaption(plan, plan.sceneProse, false)) : '', sentence(plan.visualDescription),
    camera.length ? sentence(`The composition uses ${naturalList(camera)}`) : '',
    lighting.length ? sentence(`The scene is lit by ${naturalList(lighting)}`) : '',
  ].filter(Boolean).join(' ')
}

function proseClause(value: string): string {
  return clean(value)
    .replace(/[.!?]+\s*/g, '; ')
    .replace(/(?:;\s*)+$/g, '')
    .trim()
}

/**
 * Anima uses tags for identity and clothing, captions for authored scene relationships.
 * Do not repeat the character and outfit dossiers after their tags. Only visual fields are read;
 * title, story, dialogue, search metadata, and audit metadata never enter here.
 */
function buildAnimaVisualDirection(plan: PromptPlan): string {
  const authored = clean(String(plan.scene?.animaCaption || plan.sceneProse || ''))
  // Tags already carry camera, light, action and environment. Only authored
  // relationships belong in the caption; never reconstruct and truncate them.
  return authored
    ? sentence(sanitizeVisualArtifacts(authoredSceneCaption(plan, authored)))
    : sentence(sanitizeVisualArtifacts(plan.visualDescription))
}

export function createPromptPlan(input: PromptCompilerInput): PromptPlan {
  const isRating = (tag: string) => /^(?:safe|general|sensitive|questionable|explicit|nsfw)$/.test(normalizeKey(tag))
  const promptRating = input.profile?.rating_mode === 'prompt'
  const authoredRating = promptRating && [...split(input.scenePrompt), ...(input.manual || []), ...(input.controls || [])].some(isRating)
  const quality = split(input.profile?.quality_prefix)
  const sceneIdentity = input.scene?.identityTokensOverride
  const defaultCamera = SHOT.find(option => option.id === sceneShot(input.scene ?? null))?.prompt
  const camera = mergeCameraControls(input.camera || [], cameraTokensFromText(input.scene?.camera),
    !input.camera?.length || Boolean(defaultCamera && input.camera.every(token => normalizeKey(token) === normalizeKey(defaultCamera))))
  const plan: PromptPlan = {
    freeSubject: input.freeSubject,
    quality: authoredRating ? quality.filter(tag => !isRating(tag)) : quality,
    rating: !promptRating && input.rating ? [input.rating] : [],
    identity: Array.isArray(sceneIdentity) && sceneIdentity.length ? [...sceneIdentity] : split(input.identity),
    exactControls: [...new Set(input.controls || [])],
    characterTokens: [...new Set(input.characterTokens || [])], copyrightTokens: [...new Set(input.copyrightTokens || [])],
    artists: [...new Set(input.artists || [])],
    preserveTokens: [...new Set(input.exactTokens || [])],
    sceneVisualFragments: split(input.scenePrompt), emotion: [...(input.emotion || [])],
    camera, lighting: [...(input.lighting || [])], palette: [...(input.palette || [])],
    authoredLighting: input.authoredLighting,
    composition: [...(input.composition || [])], manual: [...(input.manual || [])],
    negative: split(input.negative), visualDescription: plainEnglish(input.visualDescription),
    style: [...new Set(input.style || [])],
    medium: String(input.medium || '').trim(),
    subjectProse: String(input.scene?.identityProseOverride || input.subjectProse || '').trim(),
    outfitProse: String(input.outfitProse || '').trim(),
    sceneProse: String(input.sceneProse || '').trim(),
    scene: input.scene ?? null,
    artistProse: String(input.artistProse || '').trim(),
  }
  if (compositionIntent(input.scene) !== 'single') {
    const source = { ...input.scene, promptTokens: plan.sceneVisualFragments }
    plan.identity = compositionTokens(plan.identity, source)
    plan.sceneVisualFragments = compositionTokens(plan.sceneVisualFragments, source)
    plan.subjectProse = plan.subjectProse.replace(/\bis the only prominent character,\s*/i, 'is ')
  }
  // Studio's default low twintails must yield to an explicitly authored updo,
  // loose hairstyle or braids. Authored/exact scene and manual tokens stay intact.
  if ([...plan.sceneVisualFragments, ...plan.exactControls, ...plan.manual]
    .some(token => /(?:^|_)(?:hair_up|hair_down|twin_braids|two(?:_[a-z]+){0,3}_braids)(?:_|$)/.test(normalizeKey(token)))) {
    plan.identity = plan.identity.filter(token => normalizeKey(token) !== 'low_twintails')
  }
  // An explicit scene variant can remove Nene's default hair ribbons.
  if ([...plan.sceneVisualFragments, ...plan.manual].some(token => /^no_hair_ribbons?$/.test(normalizeKey(token)))) {
    plan.identity = plan.identity.filter(token => !['pink_hair_ribbons', 'hair_ribbon'].includes(normalizeKey(token)))
    plan.subjectProse = plan.subjectProse.replace(/\bpink hair ribbons\b/gi, 'no ribbons in her hair')
  }
  const light = lightingOverride(plan)
  if (light) {
    const exact = new Set([...plan.preserveTokens, ...(input.profile?.exact_tokens || [])].map(normalizeKey))
    plan.sceneVisualFragments = plan.sceneVisualFragments.filter(token => exact.has(normalizeKey(token))
      || input.profile?.exact_prefixes?.some(prefix => token.toLowerCase().startsWith(prefix.toLowerCase()))
      || lightingTokenId(token) !== light.source)
  }
  if (input.profile?.model_id === 'anima-miaomiao-v1.6') {
    const authored = [...plan.identity, ...plan.exactControls, ...plan.sceneVisualFragments, ...plan.manual]
    // Inspect only authored positive content, including the caption actually sent to Anima.
    if ([...authored, buildAnimaVisualDirection(plan)].some(conflictsWithFairSkin)) {
      plan.quality = plan.quality.filter(tag => normalizeKey(tag) !== 'fair_skin')
    }
  }
  return plan
}

function allTags(plan: PromptPlan, includeStyle = true): string[] {
  const raw = [ ...plan.quality, ...plan.rating, ...plan.identity, ...plan.exactControls, ...plan.artists,
    ...(includeStyle ? plan.style : []), ...plan.sceneVisualFragments, ...plan.emotion, ...plan.camera, ...plan.lighting, ...plan.palette,
    ...plan.composition, ...plan.manual ].filter(Boolean)
  return raw.map(tag => {
    const k = normalizeProseKey(tag)
    if (k === 'burning_red_ears') return 'blushing ears'
    return tag
  })
}

export function renderPromptPlan(plan: PromptPlan, family: PromptFamily, profile?: ModelProfile | null): { prompt: string; negative: string } {
  const capabilities = resolveDrawCapabilities(family, profile)
  if (capabilities.promptFormat === 'natural-language') {
    const proseSafe: PromptPlan = {
      ...plan,
      identity: sanitizeKreaTokens(plan.identity), exactControls: sanitizeKreaTokens(plan.exactControls),
      sceneVisualFragments: sanitizeKreaTokens(plan.sceneVisualFragments), emotion: sanitizeKreaTokens(plan.emotion),
      camera: sanitizeKreaTokens(plan.camera), lighting: sanitizeKreaTokens(plan.lighting),
      palette: sanitizeKreaTokens(plan.palette), composition: sanitizeKreaTokens(plan.composition),
      manual: sanitizeKreaTokens(plan.manual),
      subjectProse: sanitizeKreaProse(plan.subjectProse),
      outfitProse: sanitizeKreaProse(plan.outfitProse),
      sceneProse: sanitizeKreaProse(plan.sceneProse),
      visualDescription: sanitizeKreaProse(plan.visualDescription),
      artistProse: sanitizeKreaProse(plan.artistProse),
      style: plan.style.map(sanitizeKreaProse).filter(Boolean),
      medium: sanitizeKreaProse(plan.medium),
    }
    return { prompt: sanitizeKreaProse(plan.freeSubject ? buildFreeKreaDescription(proseSafe) : buildStructuredKreaDescription(proseSafe)), negative: '' }
  }
  const tags = allTags(plan)
  if (capabilities.promptFormat === 'anima-tags') {
    const formatted = formatPromptForEngine(
      orderedAnimaTags(plan, resolveCameraTags(tags, plan.manual, plan.camera), profile?.strip_quality_tokens === true),
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

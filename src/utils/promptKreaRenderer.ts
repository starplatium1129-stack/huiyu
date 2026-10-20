import type { PromptPlan, PromptSceneContext } from '../types/prompt'
import { sceneLighting, sceneShot } from './sceneInference.ts'
import { authoredSceneCaption } from './promptCaption.ts'
import { lightingOverride } from './promptLighting.ts'
import { sanitizeKreaProse, sanitizeKreaTokens } from './promptVisualText.ts'
import { resolveCameraTags } from './promptCamera.ts'
import { SHOT, LIGHTING } from '../config/promptConstants.ts'
import { CANONICAL_OUTFITS } from './canonicalOutfits.ts'
import { cleanPromptProse as clean, promptSentence as sentence, plainEnglish } from './promptProse.ts'
import { proseToken, normalizeProseKey, actionPhrase, outfitPhrase, moodPhrase, compactMood, cameraPhrase, lightPhrase, environmentPhrase, isEnvironmentKey, removeIndoorSkyPhrases } from './promptPhraseTables.ts'

const proseList = (values: string[]): string => [...new Set(values.map(proseToken).filter(Boolean))].join(', ').replace(/(?:,\s*){2,}/g, ', ')

const KREA_META_KEYS = new Set([
  '1girl', 'solo', '2girls', 'official_cg', 'visual_audited', 'landscape', 'portrait',
  'general', 'sensitive', 'safe', 'explicit', 'adult', 'visual_novel_event_cg',
  'nene_r18', 'natsume_r18', 'adult_after_story', 'official_visual_novel_cg_framing',
])
const KREA_CAMERA_KEYS = new Set([
  'close_up', 'extreme_close_up', 'medium_close_up', 'close_up_detail', 'medium_shot', 'upper_body',
  'half_body', 'waist_up', 'cowboy_shot', 'wide_shot', 'long_shot', 'full_body',
  'pov', 'pov_shot', 'high_angle', 'low_angle', 'from_above', 'from_below',
  'side_view', 'from_side', 'front_view', 'back_view', 'from_behind', 'profile', 'dutch_angle', 'cinematic_16_9_clockwise_dutch_angle',
  'waist_up_close_shot', 'portrait_shot', 'establishing_shot', 'face_focus',
  'three_quarter_view', 'over_the_shoulder', 'over_shoulder', 'selfie', 'eye_level',
  'front_three_quarter_view', 'rear_three_quarter_view', 'back_three_quarter_view', 'side_three_quarter_view', 'overhead_shot', 'bird_s_eye_view',
])
const KREA_LIGHT_KEYS = new Set([
  'window_light', 'golden_hour', 'golden_light', 'backlight', 'backlit', 'rim_light',
  'moonlight', 'lantern_light', 'overcast', 'soft_light', 'soft_lighting',
  'warm_light', 'warm_lighting', 'cinematic_lighting', 'volumetric_lighting',
])
const KREA_OUTFIT_RE = /(?:^|_)(?:clothes|clothing|outfit|uniform|shirt|blouse|skirt|miniskirt|dress|sundress|nightdress|camisole|capelet|windbreaker|parka|pants|shorts|vest|turtleneck|coverup|smock|apron|lingerie|underwear|panties|bra|bikini|swimsuit|pantyhose|thighhighs|stockings|tights|socks|scarf|tabi|geta|coat|sweater|cardigan|pajamas|sleepwear|nightgown|towel|yukata|kimono|furisode|haori|obi|obijime|qipao|cheongsam|robe|jacket|blazer|collar|sleeves|gloves|boots|shoes|bow|ribbon|maid|serafuku|tactical_gear|office_lady)(?:_|$)/
const KREA_BODY_DETAIL_RE = /^(?:nude|naked|fully_nude|bare_|cleavage|sideboob|underboob|no_bra|no_panties|panties_aside|pulling_down_panties|unbuttoned|unzipped|open_shirt|off_shoulder|high_slit|midriff|collarbone|navel|slender_thighs|nipples|areola|pussy|cameltoe|breasts_out|topless|bottomless|lifted_skirt|legs_apart|spread_legs|parted_lips|open_mouth|ahegao|closed_eyes|half_closed_eyes|averting_gaze|blushing|deep_blush|heavy_blush|heavy_breathing|drooling|wet_skin|wet_hair|wet_clothes|sweat|sweaty_skin|see_through|translucent|hugging_pillow|sex|intercourse|vaginal|anal|oral|fellatio|blowjob|deepthroat|cunnilingus|paizuri|titfuck|handjob|fingering|masturbation|female_masturbation|missionary|doggystyle|cowgirl_position|mating_press|spooning|grinding|penetration|cum|cum_on_face|cum_in_mouth|cum_on_breasts|cum_on_body|internal_cumshot|creampie|excessive_cum|after_sex|panty_pull|skirt_lift|grabbed_breasts|groping)/
const KREA_ACTION_RE = /^(?:holding|carrying|grabbing|gripping|smelling|standing|sitting|lying|waiting|leaning|kneeling|straddling|clinging|swimming|walking|running|reaching|undressing|looking|turning|adjusting|sweeping|tripping|squeezing|hand_gripping|skirt_hem_caught|one_hand|both_hands|propped|cross_legged|legs_apart|skirt_lift|neck_kiss|eye_contact|close_distance)(?:_|$)/
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


function outfitPhrases(plan: PromptPlan): string[] {
  if (plan.outfitProse) return [clean(plan.outfitProse)]
  const keys = new Set([...plan.exactControls, ...plan.sceneVisualFragments].map(normalizeProseKey))
  const canonical = Object.values(CANONICAL_OUTFITS).find(outfit => keys.has(outfit.tags[0]))
  if (canonical) return [canonical.prose]
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
  [/温泉(?!旅馆)|风吕|汤池/, 'at a bathing pool'],
  [/露天|户外/, 'outdoors'],
  [/客厅|家庭影音室/, 'inside a living room'],
  [/教室|课桌/, 'inside a classroom'],
  [/厨房|料理台|后厨/, 'inside a kitchen'],
  [/图书馆|图书室|书库/, 'inside a library'],
  [/书店/, 'inside a bookstore'],
  [/玄关|门厅/, 'inside an entrance hall'],
  [/礼堂|颁奖台/, 'inside an auditorium'],
  [/海边|海滨|海岸|沙滩/, 'on a beach'],
  [/神社/, 'at a shrine'],
  [/古寺|寺庙|寺院/, 'at a temple'],
  [/公园/, 'in a park'],
  [/天台|屋顶/, 'on a rooftop'],
  [/街头|街道|放学路|回家路|路口/, 'on a street'],
  [/室内场景/, 'indoors'],
]

const WEATHER_PHRASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/暴雨|骤雨|大雨|雷雨/, 'during a rainstorm'],
  [/阴天|阴雨/, 'under an overcast sky'],
  [/雨/, 'in the rain'],
  [/雪/, 'in snowy conditions'],
  [/晴/, 'in clear weather'],
  [/雾|氤氲/, 'in soft mist'],
  [/微风|轻风/, 'in a light breeze'],
  [/狂风|强风|大风/, 'in strong wind'],
  [/^(?!.*(?:微风|轻风|狂风|强风|大风)).*风/, 'in windy weather'],
]

// The room or terrace is the subject's location; coastal/town names describe its surroundings.
const SPECIFIC_LOCATION_PHRASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?:木屋|旅馆).*(?:露台|廊下)/, 'on a veranda'],
  [/木屋/, 'inside a wooden cabin'],
  [/(?:旅馆|酒店|客栈|社务所).*客房/, 'inside a guest room'],
  [/电玩城/, 'inside an arcade'],
]

function sceneFieldPhrases(scene: PromptSceneContext | null): string[] {
  if (!scene) return []
  const phrases: string[] = []
  const specificLocation = SPECIFIC_LOCATION_PHRASES.find(([pattern]) => pattern.test(String(scene.location || '')))
  phrases.push(...(specificLocation ? [specificLocation[1]] : mappedPhrases(scene.location, LOCATION_PHRASES)))
  const time = plainEnglish(scene.timeOfDay) || plainEnglish(scene.time)
  if (time) phrases.push(environmentPhrase(time))
  const weather = String(scene.weather || '')
  phrases.push(...(/雨(?:后|停|歇)|雨.*(?:初歇|停歇)|after (?:the )?rain/i.test(weather)
    ? ['after the rain'] : mappedPhrases(weather, WEATHER_PHRASES)))
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
    replacedSource !== 'lantern' && /暖光|暖灯|暖色[^，。与]*(?:灯|光|照明)|暖黄|橙光/.test(text) ? 'warm lighting' : '',
    /柔和|柔光/.test(text) ? 'soft lighting' : '',
  ].filter(Boolean)
}

function buildStructuredKreaDescription(plan: PromptPlan): string {
  const style = inferredKreaStyle(plan)
  const dual = plan.identity.some(token => normalizeProseKey(token) === '2girls')
  const subject = clean(plan.subjectProse || proseList(plan.identity))
  const subjectText = `_${normalizeProseKey(subject).replace(/[.,;:]/g, '_')}_`
  const identityKeys = new Set(plan.identity.map(normalizeProseKey))
  const subjectNames = new Set(plan.characterTokens.map(token => normalizeProseKey(token.split('(')[0])))
  const workNames = new Set(plan.copyrightTokens.map(normalizeProseKey))
  const exactKeys = new Set(plan.exactControls.map(normalizeProseKey))
  const outfitKeys = new Set([...exactKeys, ...plan.sceneVisualFragments.map(normalizeProseKey)])
  const outfit = outfitPhrases(plan)
  const consumedOutfitKey = !plan.outfitProse
    ? Object.values(CANONICAL_OUTFITS).find(outfit => outfitKeys.has(outfit.tags[0]))?.tags[0] : undefined
  const authoredProse = plan.sceneProse || sanitizeKreaProse(plainEnglish(plan.scene?.animaCaption))

  const action: string[] = []
  const artists = [...plan.artists].map(token => proseToken(token.replace(/^@/, '')))
  const mood: string[] = [...plan.emotion.map(moodPhrase).filter(Boolean)]
  const environment: string[] = []
  const manualBackground: string[] = []
  const camera: string[] = []
  const lighting: string[] = [...plan.lighting.map(lightPhrase).filter(Boolean), ...sceneLightingPhrases(plan.scene, lightingOverride(plan)?.source)]
  for (const token of resolveCameraTags([...plan.identity, ...plan.camera, ...sceneCameraTokens(plan.scene), ...plan.sceneVisualFragments, ...plan.manual], plan.manual, plan.camera)) {
    const key = normalizeProseKey(token)
    if (!key || KREA_META_KEYS.has(key) || workNames.has(key) || exactKeys.has(key) || key === consumedOutfitKey) continue
    const name = normalizeProseKey(token.split('(')[0])
    if (subjectNames.has(name) && subjectText.includes(`_${name}_`)) continue
    if (identityKeys.has(key) && subjectText.includes(`_${key}_`)) continue
    if (/^no_hair_ribbons?$/.test(key) && subject.includes('no ribbons in her hair')) continue
    if (token.startsWith('@')) { artists.push(proseToken(token.slice(1))); continue }
    // These objects do not imply a worn garment or an active light source.
    if (/^(?:(?:clothes|coat)_hangers?|folded_clothes)$/.test(key) || /(?:^|_)flashlight$/.test(key)) { action.push(proseToken(token)); continue }
    if (KREA_ACTION_RE.test(key) || key.startsWith('folding_') || KREA_BODY_DETAIL_RE.test(key)) { action.push(actionPhrase(token)); continue }
    if (KREA_CAMERA_KEYS.has(key)) { camera.push(cameraPhrase(token)); continue }
    if (KREA_LIGHT_KEYS.has(key) || /(?:light|lighting|shadow|shadows|backlit)$/.test(key)) { lighting.push(lightPhrase(token)); continue }
    if (isEnvironmentKey(key) && /(?:^|_)(?:cafe|shop|store|boutique)$/.test(key)) { environment.push(environmentPhrase(token)); continue }
    if (KREA_OUTFIT_RE.test(key) && !/_(?:on|over|beside|under|by)_/.test(key)) {
      if (key === 'apron_only' && outfit.some(item => /only .*apron/i.test(item))) continue
      outfit.push(outfitPhrase(token).replace(/^(?:wearing|dressed in)\s+/i, ''))
      continue
    }
    if (KREA_MOOD_RE.test(key) && key !== 'red_ears' && key !== 'lunar_tears') { mood.push(moodPhrase(token)); continue }
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
    .replace(/[.!?]+(?:\s+|$)/g, '; ')
    .replace(/(?:;\s*)+$/g, '')
    .trim()
}

/** Natural-language rendering and sanitization stay within the Krea model boundary. */
export function renderKreaPrompt(plan: PromptPlan): { prompt: string; negative: string } {
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

import { hasVariableCamera } from './randomVariationProse.ts'
import { isStableIdentityToken } from './interrogateReference.ts'
import { canVarySceneOutfit, sceneAllowsAction, randomSceneLightOptions, randomSceneWardrobe, sceneVariationOverlay, type RandomSceneContext } from './randomSceneVariation.ts'
import { cameraTokensFromText } from './promptCamera.ts'
import { sceneLighting, sceneShot } from './sceneInference.ts'
import { inferBlueprintLighting } from './blueprintLighting.ts'
import type { DraftRandomVariation } from './promptBuilderPersistence.ts'
import type { DirectorControlSources } from '../types/promptDirector.ts'
import pools from '../config/randomInspirationPools.json' with { type: 'json' }
import type { ArtistStyleOption } from '../config/artistStyles.ts'
import { normalizeArtistStyleIds, ARTIST_STYLE_CANDIDATES } from '../config/artistStyles.ts'
import { COLOR_MOODS, COMPOSITION, EMOTION, LIGHTING, SHOT } from '../config/promptConstants.ts'
import { normalizeKey } from './promptPolicy.ts'
import { fitsRandomFacts, compatibleRandomDetail, outfitFitsSetting, randomTokens, visibleInRandomShot } from './randomPromptConstraints.ts'
import { RANDOM_SETTINGS } from './randomSceneSettings.ts'
import { isGarmentToken, isOutfitToken } from './popularIdentity.ts'
import { isWardrobeContextTag, wardrobeTokens } from './wardrobeContent.ts'

/**
 * 随机灵感采样器（2026-08-29，详见 docs/guides/engineering/random-prompt-assembler-design.md）。
 *
 * 纯函数：数据池与随机源全部注入，无 Vue / IO 依赖。
 * 只产出「风格层」采样结果（RandomDraw），三引擎渲染完全复用现有
 * promptCompiler（createPromptPlan → renderPromptPlan），本模块不触碰渲染。
 *
 * 三条硬约束：
 * 1. 角色身份固定——identity token（CHAR_PROMPT / identityExclude）绝不进入采样池；
 * 2. 画师默认不注入（includeArtists=false，保留角色原生画风），keepArtists 恒保留；
 * 3. Mature 池无独立开关——本地直连本就放行，随机抽中即与显式触发词联动
 *    （评级提升由 isManualR18Tags：触发词正则 ∪ 词条池 Mature 分类命中，见
 *    usePromptAssembly.effectiveScene），此处只保证标签层面不与显式触发词冲突、不重复。
 */

export interface RandomInspirationOptions {
  context?: string
  scene?: RandomSceneContext
  /** Adopted picture facts remain editable in the draft and reproducible in a saved roll. */
  referenceTags?: string[]
  /** Explicit caller opt-in: popular wardrobes may vary unless manually selected. */
  allowClothing?: boolean
  rich?: boolean
  negative?: string[]
  visualDescription?: string
  /** 工作室角色（studio 模式）。popular 模式改传 identityExclude，不传 char。 */
  char?: 'nene' | 'natsume' | 'triad'
  /** Explicit identity anchors replace the studio lookup. Popular callers opt into
   *  wardrobe sampling separately; manually selected outfits remain protected. */
  identityExclude?: ReadonlySet<string>
  /** 「随机画师」开关，默认 false：不加画师 tag，保留角色原生画风。 */
  includeArtists?: boolean
  /** 用户手动已选画师，重掷恒保留（独立于 includeArtists）。 */
  keepArtists?: string[]
  /** 注入随机源（测试用）。缺省 Math.random。 */
  rng?: () => number
  /** 项目标签池（data/tags.json，经 sceneStore 加载）。 */
  tags: ReadonlyArray<{ en: string; cat: string; status?: string; verification?: { postCount: number } }>
  /** 官方服装（loras.json outfit_guidance，key → token 列表）。 */
  officialOutfits?: Readonly<Record<string, readonly string[]>>
  /** 画师候选，缺省复用轻量白名单；显式空数组表示不采样。 */
  artists?: ReadonlyArray<Pick<ArtistStyleOption, 'id'>>
}

export interface RandomDraw {
  directorSources: DirectorControlSources
  variation: DraftRandomVariation
  kept: string[]
  /** EMOTION id 列表（最多一个，进入 store.selections.emotion）。 */
  emotions: string[]
  /** SHOT id 或 null。 */
  shot: string | null
  /** LIGHTING id 或 null。 */
  lighting: string | null
  /** COMPOSITION id 或 null。 */
  composition: string | null
  /** COLOR_MOODS id 或 null。 */
  colorMood: string | null
  /** 场景/动作/外观/身体/服装/Mature 等原始标签（写入 store.manualTags）。 */
  manualTags: string[]
  /** 归一后的画师 id（默认空数组）。 */
  artistStyleIds: string[]
}

// ── 常量：身份 token / 元标签 / 互斥分组 / 场景室内外 ──────────────────

/** 角色身份 token：与 CHAR_PROMPT 同源，采样池必须排除。 */
const IDENTITY_TOKENS: Record<string, ReadonlySet<string>> = {
  nene: new Set(['1girl', 'solo', 'ayachi_nene', 'white_hair', 'very_long_hair', 'low_twintails', 'purple_eyes', 'ahoge', 'pink_hair_ribbons']),
  natsume: new Set(['1girl', 'solo', 'shiki_natsume', 'black_hair', 'very_long_hair', 'yellow_eyes', 'mole_under_eye', 'hairclip']),
  triad: new Set(['2girls', '1girl', 'solo']),
}

/** 与身份/构图无关的元标签，随机时一律丢弃。 */
const META_TOKENS = new Set(['general', 'official_cg', 'visual_audited', 'anime', 'landscape', 'portrait', 'safe', 'sensitive', 'nsfw'])

/** 极端重度/道具约束标签（在常规随机灵感中过滤，优先唯美情调与高级感）。 */
const MATURE_HARDCORE = new Set([
  'anal', 'fellatio', 'blowjob', 'cunnilingus', 'facesitting', 'deepthroat',
  'ball_gag', 'gagged', 'gag', 'spanking', 'dildo', 'vibrator', 'fucking',
  'creampie', 'cum', 'cum_on_body', 'cum_drip', 'penis', 'multiple_penises',
  'clitoris', 'labia', 'urethra', 'prostate', 'tentacles', 'pegging', 'bondage',
  'tied_up', 'rope', 'handcuffs', 'blindfold', 'mating_press', 'sumata',
])

const COLOR_MOOD_LINK: Readonly<Record<string, readonly string[]>> = pools.colorMoodLink
const ENVIRONMENT_SHOTS = SHOT.filter(option => !['detail', 'over', 'turn'].includes(option.id))
const SOLO_ACTIONS = ['standing', 'sitting', 'leaning', 'stretching', 'waving', 'walking']
const GROUP_INTIMACY = new Set(['handjob', 'vaginal', 'missionary', 'doggystyle', 'standing_sex', 'leg_lock',
  'spooning', 'sitting_on_face', 'sixty_nine', 'paizuri', 'footjob', 'thigh_sex', 'french_kiss', 'kissing_neck',
  'ear_bite', 'groping', 'waist_grab', 'facial', 'cum_in_mouth'])
const EXPRESSION_DETAILS = new Set(['teasing', 'smug', 'ahegao', 'rolling_eyes', 'orgasm', 'moaning'])
const EXPOSURE_DETAILS = new Set(['breasts', 'nipples', 'puffy_nipples', 'inverted_nipples', 'pussy', 'anus',
  'pubic_hair', 'underboob', 'bare_hips', 'bare_back', 'midriff'])
const WARDROBE_DETAILS = new Set(['garter_belt', 'garter_straps', 'thong'])

function draw<T>(pool: readonly T[], count: number, rng: () => number, exclude?: ReadonlySet<T>): T[] {
  const candidates = [...new Set(pool)].filter(item => !exclude || !exclude.has(item))
  if (!candidates.length) return []
  const result: T[] = []
  const remaining = [...candidates]
  const take = Math.min(count, remaining.length)
  for (let i = 0; i < take; i += 1) {
    const index = Math.floor(rng() * remaining.length)
    result.push(remaining.splice(index, 1)[0])
  }
  return result
}

function chance(probability: number, rng: () => number): boolean {
  return rng() < probability
}

export function randomPromptPlan(options: RandomInspirationOptions): RandomDraw {
  const rng = options.rng ?? Math.random
  const char = options.char ?? 'nene'
  // 热门角色模式：identityExclude（identityTokens+exactTokens+outfit tokens）优先；
  // studio 模式：内置身份查表。两者都归一化后并入排除集。
  const explicitIdentity = options.identityExclude
  const identitySource: Iterable<string> = explicitIdentity
    ? explicitIdentity
    : (IDENTITY_TOKENS[char] ?? IDENTITY_TOKENS.nene)
  const exclude = new Set<string>()
  for (const token of identitySource) for (const part of randomTokens(token)) exclude.add(normalizeKey(part))
  for (const value of options.negative ?? []) for (const token of randomTokens(value)) exclude.add(normalizeKey(token))
  META_TOKENS.forEach(token => exclude.add(token))

  // 跨角色特征单向隔离：单人抽取时，屏蔽其他主角的标志性外观特征
  if (!explicitIdentity && char !== 'triad') {
    if (char === 'nene') {
      for (const t of ['shiki_natsume', 'natsume', 'mole_under_eye', 'hairclip', 'two_red_hairclips', 'black_hair', 'yellow_eyes']) {
        exclude.add(normalizeKey(t))
      }
    } else if (char === 'natsume') {
      for (const t of ['ayachi_nene', 'nene', 'white_hair', 'purple_eyes', 'low_twintails', 'pink_hair_ribbons']) {
        exclude.add(normalizeKey(t))
      }
    }
  }

  // One pass, canonical-key deduplication: duplicate source IDs do not bias sampling.
  const catalog = new Map<string, Map<string, string>>()
  for (const tag of options.tags) {
    if (tag.status === 'retired' || (tag.verification && tag.verification.postCount <= 0)) continue
    const pool = catalog.get(tag.cat) ?? new Map<string, string>()
    for (const token of randomTokens(tag.en)) {
      const key = normalizeKey(token)
      if (!exclude.has(key) && !isStableIdentityToken(token) && !pool.has(key)) pool.set(key, token)
    }
    catalog.set(tag.cat, pool)
  }
  const byCat = (cat: string): string[] => [...(catalog.get(cat)?.values() ?? [])]

  const reference = options.referenceTags ?? []
  const referenceShot = sceneShot({ tags: reference })
  let scene = options.scene
  if (reference.length) {
    scene = scene ? { ...scene, fixedTokens: [...(scene.fixedTokens ?? []), ...reference] } : {
      prompt: reference.join(', '), tags: reference, fixedTokens: reference, prose: '', action: '', time: '',
      lighting: sceneLighting({ tags: reference }), shot: referenceShot,
    }
  }
  const manualTags: string[] = []
  const available = new Set([...catalog.values()].flatMap(category => [...category.keys()]))
  const pick = <T>(values: readonly T[]): T | undefined => draw(values, 1, rng)[0]
  const known = (tag: string) => available.has(normalizeKey(tag))
  const authored = [...randomTokens(scene?.prompt ?? ''), ...(scene?.fixedTokens ?? [])]
  const originalFacts = [...authored, ...(scene?.tags ?? [])]
  const userProse = options.visualDescription?.trim()
  const narrative = Boolean(scene?.prose || scene?.otherProse || scene?.prompt.includes('\n') || userProse)
  const blocked = (tag: string) => randomTokens(tag).some(part => exclude.has(normalizeKey(part)))
  const allowedChoice = (choice: {prompt?: string}) => !blocked(choice.prompt ?? '')

  // Choose one place, its visible surroundings and one motivated light together.
  const locations = RANDOM_SETTINGS.filter(setting => known(setting.tags[0])
    && LIGHTING.some(light => light.id === setting.lighting && allowedChoice(light)))
  const complete = locations.filter(setting => setting.tags.every(known))
  const setting = !scene && !userProse ? pick(complete.length ? complete : locations) : undefined
  const sceneSetting = scene && RANDOM_SETTINGS.find(item => authored.some(tag => normalizeKey(tag) === item.tags[0]))
  const authoredLight = userProse ? inferBlueprintLighting({ lighting: userProse }) : null
  const lightIds = authoredLight ? [authoredLight] : scene ? randomSceneLightOptions(scene) : setting ? [setting.lighting]
    : userProse ? [] : ['window', 'golden', 'moon', 'lantern', 'overcast']
  const lighting = pick(lightIds.filter(id => LIGHTING.some(item => item.id === id && allowedChoice(item)))) ?? null
  const inheritedShot = !!scene && (Boolean(referenceShot) || scene.prompt.includes('\n') || !!scene.otherProse || !!scene.prose && !hasVariableCamera(scene.prose))
  const shot = userProse && hasVariableCamera(userProse) ? sceneShot({ tags: cameraTokensFromText(userProse) })
    : inheritedShot && scene ? referenceShot ?? scene.shot : pick(ENVIRONMENT_SHOTS.filter(allowedChoice))?.id ?? null
  const placement = [scene?.camera, scene?.prose, scene?.otherProse, scene?.prompt, userProse].join(' ').replace(/_/g, ' ')
  const keepComposition = Boolean(scene?.composition || /\b(?:left|right|cent(?:er|re)(?:d)?|symmetr\w*|thirds|panels?|triptych|diptych)\b|居中|分格|三分法/i.test(placement))
  const directorSources: DirectorControlSources = {
    shot: inheritedShot ? 'scene' : 'manual', lighting: scene && lighting === scene.lighting ? 'scene' : 'manual',
    composition: keepComposition && scene ? 'scene' : 'manual', colorMood: narrative && scene ? 'scene' : 'manual',
  }
  const composition = keepComposition ? scene?.composition ?? null : chance(options.rich ? 1 : 0.5, rng)
    ? pick(COMPOSITION.filter(item => allowedChoice(item) && (item.id !== 'bywindow' || lighting === 'window')))?.id ?? null : null
  const controls = [SHOT.find(item => item.id === shot), LIGHTING.find(item => item.id === lighting),
    COMPOSITION.find(item => item.id === composition)].flatMap(item => randomTokens(item?.prompt ?? ''))
  const visible = (token: string) => visibleInRandomShot(token, shot)
  const add = (token: string, fixed = originalFacts) => {
    if (!blocked(token) && visible(token) && !manualTags.some(item => normalizeKey(item) === normalizeKey(token))
      && fitsRandomFacts(token, [...fixed, ...controls, ...manualTags])) manualTags.push(token)
  }
  if (setting) setting.tags.filter(known).forEach(tag => add(tag))
  if (scene?.rawLighting && !userProse) {
    const source = catalog.get('Lighting')?.get(normalizeKey(scene.rawLighting))
    if (source && !authored.some(tag => normalizeKey(tag) === normalizeKey(source))) add(source)
  }
  if (sceneSetting && !narrative) {
    // Add a physical detail to a sparse, recognizable location without changing its time or weather.
    const detail = sceneSetting.tags.slice(1).find(tag => ['bookshelf', 'desk', 'piano', 'bed', 'couch', 'flower', 'stone_stairs', 'ocean'].includes(tag))
    if (detail && known(detail) && !originalFacts.some(tag => normalizeKey(tag) === detail)) add(detail)
  }

  const varyOutfit = (options.allowClothing ?? !explicitIdentity) && char !== 'triad' && !userProse && (!scene || canVarySceneOutfit(scene))
  const isWardrobe = randomSceneWardrobe(options.tags)
  const fixedOutfitFacts = varyOutfit ? originalFacts.filter(tag => !isWardrobe(tag)) : originalFacts
  const canAct = !narrative && !scene?.action && !scene?.fixedTokens?.length
    && !authored.some(tag => catalog.get('Action')?.has(normalizeKey(tag)) || /^(?:holding|carrying|sitting|standing|lying)_/.test(normalizeKey(tag)))
  const fixedExpression = narrative || originalFacts.some(tag => catalog.get('Emotion')?.has(normalizeKey(tag)))
  // One mature fact can itself define the wardrobe, action or expression.
  const matureCandidates = byCat('Mature').filter(tag => {
    const key = normalizeKey(tag)
    if (!canAct || !visible(tag) || MATURE_HARDCORE.has(key) || !fitsRandomFacts(tag, originalFacts)) return false
    if (/(?:breasts|chest)$/.test(key) && key !== 'breasts') return false
    if (GROUP_INTIMACY.has(key) && char !== 'triad') return false
    if (fixedExpression && EXPRESSION_DETAILS.has(key)) return false
    if (EXPOSURE_DETAILS.has(key) && originalFacts.some(isWardrobe)) return false
    if (!varyOutfit && (EXPOSURE_DETAILS.has(key) || isOutfitToken(key) || WARDROBE_DETAILS.has(key)
      || ['clothes_pull', 'clothing_aside', 'undressing'].includes(key))) return false
    return !scene || sceneAllowsAction(scene, tag)
  })
  const mature = chance(0.5, rng) ? pick(matureCandidates) : undefined
  const matureKey = normalizeKey(mature ?? '')
  const matureWardrobe = !!mature && (isOutfitToken(matureKey) || WARDROBE_DETAILS.has(matureKey))
  const matureExposure = EXPOSURE_DETAILS.has(matureKey)
  const matureEvent = !!mature && !matureWardrobe && !matureExposure
  const emotion = !fixedExpression && !EXPRESSION_DETAILS.has(matureKey) ? pick(EMOTION.filter(allowedChoice)) : undefined
  const emotions = emotion ? [emotion.id] : []
  const palette = COLOR_MOODS.filter(mood => allowedChoice(mood) && COLOR_MOOD_LINK[emotion?.id ?? '']?.includes(mood.id)
    && !(lighting === 'moon' && mood.prompt.includes('warm tones'))
    && !(['golden', 'lantern'].includes(lighting ?? '') && ['sad', 'tension'].includes(mood.id)))
  const colorMood = narrative && scene ? scene.colorMood ?? null : chance(0.5, rng) ? pick(palette)?.id ?? null : null

  if (canAct && !matureEvent && chance(options.rich ? 1 : 0.6, rng)) {
    const choices = setting?.actions ?? sceneSetting?.actions ?? SOLO_ACTIONS
    const action = pick(choices.filter(tag => known(tag) && visible(tag) && (!scene || sceneAllowsAction(scene, tag))))
    if (action) add(action)
  }

  const outfitStart = manualTags.length
  if (matureWardrobe && mature) add(mature, fixedOutfitFacts)
  else if (varyOutfit && !matureExposure && !matureEvent) {
    const fitsSetting = (tokens: string[]) => outfitFitsSetting(tokens, setting?.tags[0] ?? sceneSetting?.tags[0], [...originalFacts, ...manualTags])
    const official = Object.values(options.officialOutfits ?? {}).map(bundle =>
      wardrobeTokens(bundle.flatMap(randomTokens)).filter(token => !isStableIdentityToken(token)
        && !catalog.get('Action')?.has(normalizeKey(token)) && !/^(?:holding|carrying|looking)_/.test(normalizeKey(token))))
      .filter(bundle => bundle.length && !bundle.some(blocked) && visible(bundle[0]) && fitsSetting(bundle))
    const bundle = chance(0.6, rng) ? pick(official) : undefined
    if (bundle) {
      add(bundle[0], fixedOutfitFacts)
      draw(bundle.slice(1).filter(visible), 2, rng).forEach(tag => add(tag, fixedOutfitFacts))
    } else {
      const generic = pick(byCat('Clothing').filter(tag => isGarmentToken(tag) && !isWardrobeContextTag(tag) && visible(tag) && fitsSetting([tag])))
      if (generic) add(generic, fixedOutfitFacts)
    }
    if (setting?.tags.includes('snow') && manualTags.length > outfitStart) {
      const clothing = manualTags.slice(outfitStart).map(normalizeKey).join(' ')
      if (shot !== 'close' && shot !== 'medium' && !/skirt|dress|pants|jeans|tights|legwear/.test(clothing) && known('jeans')) add('jeans', fixedOutfitFacts)
      if (!/boots|shoes|footwear|barefoot/.test(clothing) && known('boots')) add('boots', fixedOutfitFacts)
    }
  }
  const outfit = manualTags.slice(outfitStart)
  if (mature && !matureWardrobe) add(mature)

  if (!narrative && chance(0.4, rng)) {
    const wet = setting?.tags.some(tag => ['rain', 'ocean'].includes(tag))
    const detail = pick(byCat('Appearance').concat(byCat('Body')).filter(tag => {
      const key = normalizeKey(tag)
      if (key === 'bokeh') return shot === 'close' || shot === 'medium'
      if (key === 'petals') return setting?.tags.includes('flower')
      if (key === 'water_droplets') return wet
      return key === 'tears' && ['sad', 'moved', 'wronged'].includes(emotion?.id ?? '')
    }))
    if (detail) add(detail)
  }
  if (!narrative && chance(0.3, rng)) {
    const style = pick(byCat('Style').filter(tag => normalizeKey(tag) !== 'game_asset'))
    if (style) add(style)
  }

  // ── 画师（默认 0 位；includeArtists 开启后 0~2 位；keepArtists 恒保留） ──
  const artistPool = options.artists ?? ARTIST_STYLE_CANDIDATES
  const keep = normalizeArtistStyleIds(options.keepArtists ?? [])
  const drawn: string[] = []
  if (options.includeArtists && artistPool.length) {
    const roll = rng()
    let count = 0
    if (roll < 0.6) count = 1
    else if (roll < 0.8) count = 2
    const excludeIds = new Set(keep)
    const candidates = artistPool.filter(artist => !excludeIds.has(artist.id))
    drawn.push(...draw(candidates.map(artist => artist.id), count, rng))
  }
  const artistStyleIds = normalizeArtistStyleIds([...keep, ...drawn])

  const diffuse = /rain|overcast|snow|cloudy|阴|雨|雪/i.test([scene?.weather, ...originalFacts, ...manualTags].join(' '))
  for (const category of ['Lighting', 'Camera'] as const) {
    const pool = narrative || (category === 'Lighting' && !lighting) ? [] : byCat(category).filter(token => compatibleRandomDetail(token, category, shot, lighting, diffuse))
    if (pool.length && chance(0.35, rng)) {
      const detail = draw(pool, 1, rng)[0]
      if (detail) add(detail)
    }
  }

  return {
    directorSources,
    kept: options.scene ? [
      '地点与时段', ...(options.scene.prose || options.scene.action ? ['核心动作'] : []),
      ...(!(options.allowClothing ?? !explicitIdentity) || !canVarySceneOutfit(options.scene) ? ['服装'] : []),
      ...(options.scene.prose ? ['原文表情'] : []),
      ...(options.scene.prose && !hasVariableCamera(options.scene.prose) ? ['原文镜头'] : []),
      ...(directorSources.lighting === 'scene' ? ['原文光源'] : []),
    ] : reference.length ? ['已采用的参考图词条'] : [],
    variation: { ...sceneVariationOverlay(options.scene, outfit, options.tags, !!shot && !inheritedShot, !!composition && !keepComposition), context: options.context ?? '' },
    emotions,
    shot,
    lighting,
    composition,
    colorMood,
    manualTags: reference.length ? [...new Set([...reference, ...manualTags])] : manualTags,
    artistStyleIds,
  }
}

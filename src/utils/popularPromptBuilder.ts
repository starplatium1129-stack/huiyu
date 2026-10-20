import type { PopularCharacter, PopularOutfit } from '../types/character'
import type { SceneBlueprint } from '../types/sceneBlueprint'
import type { DirectorControlSources } from '../types/promptDirector'
import { createPromptPlan, renderPromptPlan, type PromptCompilerInput, type PromptPlan } from './promptCompiler.ts'
import {
  assembleNegative,
  isManualR18Tags,
  mutualGroupWithCategory,
  profileRatingTag,
  type ModelProfile,
} from './promptPolicy.ts'
import { KREA_STYLE_RECIPES, resolveStyleRecipe, type ResolvedStyle } from '../config/kreaStyleRecipes.ts'
import { normalizeProseKey } from './promptPhraseTables.ts'
import { compositionNegative, compositionTokens } from './blueprintComposition.ts'
import { cameraTokensFromText, mergeCameraControls } from './promptCamera.ts'
import { inferBlueprintLighting } from './blueprintLighting.ts'
import { inferBlueprintDecisions } from './popularBlueprintDecisions.ts'
import { isManualDirectorValue } from './promptDirector.ts'
import { SHOT, LIGHTING, COMPOSITION } from '../config/promptConstants.ts'
import { isGarmentToken, standaloneIdentityTokens, standaloneIdentityProse } from './popularIdentity.ts'

// ── Prompt 组装（唯一渲染层 = createPromptPlan + renderPromptPlan） ─────────

export interface PopularPromptOptions {
  character: PopularCharacter
  outfit: PopularOutfit
  blueprint: SceneBlueprint | null
  engine: 'anima' | 'krea2'
  profile?: ModelProfile | null
  manual?: string[]
  emotion?: string[]
  shot?: string | null
  lighting?: string | null
  palette?: string[]
  composition?: string | null
  directorSources?: DirectorControlSources
  /** 用户补充的画面描述；只追加，不得替换角色服装。 */
  visualDescription?: string
  negativeCustom?: string
  /** Model-specific style recipe; omitted values inherit the blueprint's recipe. */
  style?: ResolvedStyle | null
  artistTags?: string[]
  artistProse?: string
  /**
   * 反推顶替的服装词条（2026-08-29）。非空时**整体替换** outfit.tokens 与
   * outfit.prose —— 只换 tag 不换散文是无效的：那句 "She wears 校服..." 仍在，
   * 参考图的泳装压不过（实测主因）。可一键清空恢复角色默认服装。
   */
  outfitOverride?: ReadonlyArray<string> | null
  /**
   * Whether the user selected this outfit, including an explicit default outfit.
   *
   * 基础提示词对标 studio（宁宁/夏目）：它们无场景时 `characterControlTokens`
   * 返回空，只留人物基本特征。故 popular 在无蓝图且服装仍是默认时**不注入服装**，
   * 让反推词条与手动词条自由生效；用户主动挑了任意一套服装才注入。
   */
  outfitExplicit?: boolean
  /** 词条池 Mature 分类键集（tags.json cat==='Mature'，调用方派生）。
   *  manual 命中 Mature 词条时评级联动升 R18（与 studio isManualR18Tags 同一契约，
   *  2026-08-29 随机灵感开放热门角色引入：否则抽中 Mature 词仍被负面压制）。 */
  matureTokens?: ReadonlySet<string>
}

export interface PopularPromptResult {
  plan: PromptPlan
  prompt: string
  negative: string
  adult: boolean
}

const NENE_NATSUME_POLLUTION = /(?:ayachi_nene|shiki_natsume|nene_r18|natsume_r18)/i
const NENE_NATSUME_PREFIX = /^(?:nene_|natsume_)[a-z0-9_]+$/i

/** 专家模式手动词条净化：热门角色场景不得出现宁宁/夏目 LoRA 控制词。 */
function sanitizePopularManual(tags: string[]): string[] {
  return tags.filter(tag => !NENE_NATSUME_POLLUTION.test(tag) && !NENE_NATSUME_PREFIX.test(tag))
}

const STUDIO_NAME_RE = /(?:ayachi_nene|shiki_natsume)/i
const STUDIO_PREFIX_RE = /(?:^|[^a-z0-9_])(?:nene|natsume)_[a-z0-9_]+/i

/** 扫描一段文本是否泄漏宁宁/夏目 LoRA 锚点；返回泄漏描述，无则空数组。 */
export function scanStudioTokenLeaks(text: string): string[] {
  const leaks: string[] = []
  if (STUDIO_NAME_RE.test(text)) leaks.push('studio character name')
  if (STUDIO_PREFIX_RE.test(text)) leaks.push('studio control prefix')
  return leaks
}

/**
 * 人物/服装层禁携环境词（2026-08-29 干净人物提示词契约）：地点、季节、时段
 * 属于场景蓝图职责域。曾实测泄漏：5 个泳装带 summer、mika/hina 带 beach、
 * 防寒服带 snow、针织带 autumn——人物提示词与场景叠加（含反推叠加）时这些
 * 词会与蓝图词条打架。tea_party（套装语义）不在此列。
 */
const ENVIRONMENT_TOKENS = new Set([
  'beach', 'summer', 'winter', 'autumn', 'ocean', 'sea', 'underwater',
  'swimming_pool', 'poolside', 'indoors', 'outdoors', 'nightlife',
  'classroom', 'library', 'bedroom', 'festival',
])

/** 扫描词条数组中的环境词泄漏（identityTokens / outfit tokens 通用）。 */
function scanEnvironmentLeaks(tokens: ReadonlyArray<string>): string[] {
  return tokens.filter(token => ENVIRONMENT_TOKENS.has(String(token || '').toLowerCase()))
}

/**
 * 角色数据全字段污染扫描：identityTokens/exactTokens/identityProse/aliases/
 * exactPrefixes 以及每个 outfit 的 prose+tokens，统一在此判定，供内容契约
 * 校验与单测共用，避免两处各自维护一套正则漂移。
 * 2026-08-29 扩展：identityTokens 与 outfit tokens 额外扫环境词（地点/季节/
 * 时段），守住「干净人物提示词」——不选场景时角色词条不得自带环境。
 */
export function scanCharacterPollution(character: PopularCharacter): string[] {
  const leaks: string[] = []
  const textSources: Array<[string, string]> = [
    ['identityProse', character.identityProse],
    ['aliases', character.aliases.join(', ')],
    ['exactPrefixes', character.exactPrefixes.join(', ')],
    ['identityTokens', character.identityTokens.join(', ')],
    ['exactTokens', character.exactTokens.join(', ')],
  ]
  for (const [field, text] of textSources) {
    scanStudioTokenLeaks(text).forEach(leak => leaks.push(`${character.id}.${field}: ${leak}`))
  }
  scanEnvironmentLeaks(character.identityTokens).forEach(token => {
    leaks.push(`${character.id}.identityTokens: environment token "${token}"`)
  })
  character.outfits.forEach(outfit => {
    scanStudioTokenLeaks(`${outfit.prose} ${outfit.tokens.join(' ')}`).forEach(leak => {
      leaks.push(`${character.id}.outfit.${outfit.id}: ${leak}`)
    })
    scanEnvironmentLeaks(outfit.tokens).forEach(token => {
      leaks.push(`${character.id}.outfit.${outfit.id}: environment token "${token}"`)
    })
  })
  return leaks
}

function identityWithoutOutfit(prose: string): string {
  // 剥离句尾的服装描述（", wearing X." / ", dressed in X."），供 Krea 自然语言路径使用。
  return prose
    .replace(/,\s*(?:wearing|dressed in)\b[^.]*\.?$/i, '.')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Keep one adult identity anchor without repeating the existing adult wording. */
function adultIdentityProse(prose: string): string {
  const identity = identityWithoutOutfit(prose)
  // The authored prefix names the character and work; "Bunny Girl" is a title, not an age.
  const separator = identity.indexOf(',')
  const heading = separator < 0 ? identity : identity.slice(0, separator + 1)
  const description = (separator < 0 ? '' : identity.slice(separator + 1))
    .replace(/\b(?:young\s+)?girl\b/gi, 'adult woman')
    .replace(/\bschoolgirl\b/gi, 'adult woman')
    .replace(/\b(?:middle|junior high|high)[- ]school student\b/gi, 'adult alumna')
    .replace(/\bstudent\b/gi, 'adult alumna')
    .replace(/\bteen(?:age|aged)?\b/gi, 'adult')
  const resolved = heading + description
  return /\badult\b/i.test(resolved) ? resolved : `Adult ${resolved}`
}

const ADULT_IDENTITY_EXCLUDE_RE =
  /^(?:child|children|loli|underage|minor|young_girl|schoolgirl|student|teenager|middle_school_student|junior_high_student|high_school_student)$/

/** Krea 渲染模板自带动词（"wearing X"），服装 prose 若
 *  自带 "wearing/dressed in" 开头必须剥除，否则编译出 "wearing wearing"。
 *  2026-08-24 实测：8 角色 37 套服装踩坑（yor/reze/fern/jalter/sakura/yui/sylphiette/mimori/cecilia）。 */
function outfitProseForRender(prose: string): string {
  return String(prose || '').replace(/^(?:wearing|dressed in)\s+/i, '').trim()
}

/**
 * 反推顶替服装时的服装描述：把 tag 还原成可渲染的自然语言（下划线转空格）。
 * Krea 渲染模板自带 "wearing X"，这里只给名词短语。
 */
function outfitOverrideProse(tokens: ReadonlyArray<string>): string {
  return tokens.map(token => String(token || '').replace(/_/g, ' ').trim()).filter(Boolean).join(', ')
}

/**
 * 剥离身份散文里的服装描写（2026-08-29）。
 *
 * 既有的 `identityWithoutOutfit` 只剥**句尾** ", wearing X."；但 48 个角色里有 17 个
 * 的服装描写在**句中**（"…emerald eyes, wearing a white lab coat over…"），剥不掉。
 * 不选场景时，这段描写等于硬塞一套衣服给用户，挤掉自主添加词条的空间（对标
 * studio：宁宁/夏目不选场景时没有任何服装注入，服装由场景或用户自己给）。
 * 实测 17 个命中角色里 16 个剥得干净，仅 kyouyama_kazusa 的 "and black tights"
 * 属并列结构残留（影响小，不再加规则以免误伤）。
 */
function proseWithoutOutfit(prose: string): string {
  let out = String(prose || '')
  // ", wearing X …" / ", dressed in X …" 从句（句中、句尾皆可），删到句号或分号前
  out = out.replace(/,\s*(?:wearing|dressed in)\b[^.;]*/gi, '')
  out = out.replace(/;\s*(?:wearing|dressed in)\b[^.;]*/gi, '')
  // 清理：悬空逗号、标点前空白、重复空格、以连接词收尾
  out = out.replace(/,\s*(?=[,.;])/g, '')
  out = out.replace(/[,\s]+(?=[.;])/g, '')
  out = out.replace(/\s+/g, ' ')
  out = out.replace(/\b(?:with|and|over|in)\s*\.\s*$/i, '.')
  return out.trim()
}

export function buildPopularPromptPlan(options: PopularPromptOptions): PopularPromptResult {
  const { character, outfit, blueprint, engine } = options
  const profile = options.profile ?? null
  const style = options.style === undefined && blueprint
    ? resolveStyleRecipe(KREA_STYLE_RECIPES, engine, blueprint, null) : options.style
  const adult = Boolean(blueprint?.adult || style?.adult)

  const manual = sanitizePopularManual(options.manual || [])
  // 反推顶替的服装（非空即整体替换 outfit.tokens 与 outfit.prose）
  const overridden = options.outfitOverride?.length ? [...options.outfitOverride] : null
  // 服装是否参与注入（2026-08-29 基础提示词瘦身，对标 studio 的「场景驱动」）：
  //   1) 反推顶替 → 一定注入（参考图服装必须出来）
  //   2) 有蓝图/场景 → 注入（用户已选中某个具体场面）
  //   3) 用户显式挑了某套服装 → 注入（尊重明确选择）
  //   4) 否则（无场景 + 仍是默认服装）→ 不注入，只留人物基本特征
  const outfitActive = Boolean(overridden) || Boolean(blueprint) || options.outfitExplicit === true
  // 手动 Mature 词条仅联动分级与负向，不参与访问控制。
  const manualR18 = isManualR18Tags(manual, options.matureTokens)
  const outfitAppearance = outfitActive && !adult && !overridden ? outfit : null
  const identitySource = blueprint?.identityTokensOverride?.length ? blueprint.identityTokensOverride
    : outfitAppearance?.identityTokensOverride?.length ? outfitAppearance.identityTokensOverride : character.identityTokens
  const identityProse = blueprint?.identityProseOverride || outfitAppearance?.identityProseOverride || character.identityProse
  const ratingLevel = (adult || manualR18) ? 'R18' : 'ALL'
  const inherited = inferBlueprintDecisions(blueprint)
  const cameraSource = isManualDirectorValue(options.directorSources, 'shot', options.shot, inherited.shot) ? 'manual' : 'scene'
  const lightingSource = isManualDirectorValue(options.directorSources, 'lighting', options.lighting, inherited.lighting) ? 'manual' : 'scene'
  const shotToken = SHOT.find(item => item.id === options.shot)?.prompt || ''
  const cameraTokens = mergeCameraControls(
    shotToken ? [shotToken] : [],
    cameraTokensFromText(blueprint?.camera),
    cameraSource === 'scene',
  )
  const lightingToken = LIGHTING.find(item => item.id === options.lighting)?.prompt || ''
  const lightingTokens = lightingToken ? [lightingToken] : []
  const authoredLighting = blueprint ? inferBlueprintLighting(blueprint) ?? blueprint.lighting : undefined
  const compositionToken = COMPOSITION.find(item => item.id === options.composition)?.prompt || ''
  // Character DNA 锁 avoid（v2）：从常驻身份锚定流过滤易失真元素（如 C.C. 印记、
  // 花火面具、式和服类死绑回归）。只过滤 identity 标签流；场景蓝图按需使用不受限。
  const dnaAvoid = new Set((character.dnaLock?.avoid || []).map(key => normalizeProseKey(key)))

  // 用户描述是额外画面指令，服装由独立字段稳定保留。
  const userVisual = String(options.visualDescription || '').trim()
  const nsfwTokens = adult ? (blueprint?.nsfwTokens || []) : []
  const nsfwProse = adult ? String(blueprint?.nsfwProse || '').trim() : ''
  const sceneProse = [
    // 成人场景：裸体叙述前置，避免被服装散文压过（Krea 2 自然语言模型对句首描述权重最高）。
    ...(nsfwProse ? [nsfwProse] : []),
    blueprint?.promptProse,
  ].filter(Boolean).join(' ')

  const emotionTokens = options.emotion || []
  const subjectProse = !blueprint
    ? standaloneIdentityProse({ ...character, identityTokens: identitySource, identityProse })
    : adult
      ? adultIdentityProse(identityProse)
      : (outfitActive
          ? (overridden ? proseWithoutOutfit(identityProse) : identityWithoutOutfit(identityProse))
          : proseWithoutOutfit(identityProse))
  // Both renderers share the resolved outfit. Adult blueprints retain their authored
  // clothing state in scene tokens/prose; the bound outfit must not dress them again.
  const outfitProse = (adult || !outfitActive)
    ? ''
    : (overridden ? outfitOverrideProse(overridden) : outfitProseForRender(outfit.prose))

  const manualPose = manual.map(mutualGroupWithCategory).find(h => h?.category === 'pose')
  const manualViewpoint = manual.map(mutualGroupWithCategory).find(h => h?.category === 'viewpoint')
  const sourceOutfit = blueprint?.outfitId
    ? character.outfits.find(item => item.id === blueprint.outfitId)
    : character.outfits.find(item => item.default) ?? character.outfits[0]
  const stableIdentity = new Set([...character.exactTokens, ...identitySource.filter(token =>
    !isGarmentToken(normalizeProseKey(token)) && mutualGroupWithCategory(token)?.category !== 'outfit')].map(normalizeProseKey))
  const replacedOutfit = !adult && sourceOutfit && (overridden || sourceOutfit.id !== outfit.id)
    ? new Set(sourceOutfit.tokens.map(normalizeProseKey).filter(key => !stableIdentity.has(key)))
    : new Set<string>()
  // 两种引擎共用蓝图的画面要素；手动姿态与换装优先于蓝图原词。
  const sceneTokensFiltered = (blueprint?.promptTokens || []).filter(token => {
    if (replacedOutfit.has(normalizeProseKey(token))) return false
    const hit = mutualGroupWithCategory(token)
    if (manualPose && hit?.category === 'pose' && hit.group !== manualPose.group) return false
    if (manualViewpoint && hit?.category === 'viewpoint' && hit.group !== manualViewpoint.group) return false
    return true
  })

  // 不选场景时，身份词里混入的服装一并去掉（数据遗留：不少角色把 pleated_skirt /
  // qipao / green_clothes / coat 等写进了 identityTokens，而它是无条件注入的，
  // 不过滤则瘦身对它们无效）。双保险：互斥族判定 + 普通衣物名单。
  const referenceIdentity = Boolean(overridden) && !adult
  const identityTokens = (!blueprint ? standaloneIdentityTokens(identitySource) : outfitActive && !referenceIdentity
    ? identitySource
    : identitySource.filter(token =>
        mutualGroupWithCategory(token)?.category !== 'outfit' && !isGarmentToken(token)))
    .filter(token => !replacedOutfit.has(normalizeProseKey(token)))
    .filter(token => !dnaAvoid.has(normalizeProseKey(token)))
    .filter(token => !adult || (!isGarmentToken(token)
      && !ADULT_IDENTITY_EXCLUDE_RE.test(String(token || '').trim().toLowerCase())))
  const exactIdentity = (!blueprint ? standaloneIdentityTokens(character.exactTokens) : character.exactTokens).filter(token => !referenceIdentity
    || (mutualGroupWithCategory(token)?.category !== 'outfit' && !isGarmentToken(token)))
  const exactControls = [...new Set([
    ...((adult || !outfitActive) ? [] : (overridden ?? outfit.tokens)),
    ...exactIdentity,
    ...(adult ? ['adult'] : []),
    ...nsfwTokens,
  ])]
  // Resolve shared content once. Model projections below choose tags or prose;
  // Krea must not acquire every Anima identity/outfit token as a second description.
  const commonInput: PromptCompilerInput = {
    subjectProse, outfitProse, sceneProse,
    characterTokens: [...(character.characterTokens || []), ...(blueprint?.characterTokens || [])],
    copyrightTokens: character.copyrightTokens,
    emotion: emotionTokens,
    camera: cameraTokens,
    cameraSource,
    lighting: lightingTokens,
    lightingSource,
    authoredLighting,
    palette: options.palette,
    composition: compositionToken ? [compositionToken] : [],
    manual,
    visualDescription: userVisual,
  }
  const modelInput: PromptCompilerInput = engine === 'krea2'
    ? {
        scenePrompt: compositionTokens([...sceneTokensFiltered, ...nsfwTokens], blueprint).join(', '),
        style: style ? [style.lead] : [],
        medium: style?.medium ?? '',
        artistProse: options.artistProse,
      }
    : {
        profile,
        identity: compositionTokens(identityTokens, blueprint).join(', '),
        characterTokens: [...commonInput.characterTokens!, ...exactIdentity],
        controls: compositionTokens(exactControls, blueprint),
        artists: options.artistTags?.length ? options.artistTags : undefined,
        exactTokens: compositionTokens(exactIdentity, blueprint),
        scenePrompt: compositionTokens(sceneTokensFiltered, blueprint).join(', '),
        negative: (blueprint?.negativeTokens || []).join(', '),
        rating: profileRatingTag(profile, { rating: ratingLevel }) || (ratingLevel === 'R18' ? 'nsfw' : ''),
        style: style?.sd ? style.sd.split(',').map(token => token.trim()).filter(Boolean) : [],
      }
  const plan = createPromptPlan({ ...commonInput, ...modelInput })
  const rendered = renderPromptPlan(plan, engine, profile)
  if (engine === 'krea2') return { plan, prompt: rendered.prompt, negative: '', adult }
  // renderPromptPlan 对 anima 恒返回空 negative，但无 LoRA 工作流含负向 encode 节点，
  // 因此负向词由调用方下发：合并 profile 基础与本条明确排除项。
  const negative = assembleNegative(
    profile,
    {
      negative: (blueprint?.negativeTokens || []).join(', '),
      rating: ratingLevel,
    },
    'anima',
    { shot: options.shot, character: character.id, custom: options.negativeCustom },
  )
  const finalNegative = compositionNegative(negative, blueprint)
  return { plan, prompt: rendered.prompt, negative: finalNegative, adult }
}

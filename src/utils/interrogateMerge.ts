import {
  mutualGroupWithCategory,
  normalizeKey,
  tokenize,
  resolveFramingMode,
  FOOTWEAR_AND_LEG_TOKENS,
  SHOE_TOKENS,
  BAREFOOT_TOKENS,
  CLOSED_EYES_TOKENS,
  GAZE_AND_EYE_DETAIL_TOKENS,
  QUALITY_TOKENS,
} from './promptPolicy.ts'

/**
 * 反推词条合并器（2026-08-29，随机灵感/反推优化）。
 *
 * 职责：反推（interrogate）词条写入 manualTags 前的「不重复叠加」与
 * 「人物身份冲突」「互斥组冲突」消解。纯函数，无 Vue/IO 依赖，可被 node:test 单测。
 *
 * 三重去重：manualTags（已有手动词条）∪ 身份行（charPrompt / identityTokens
 * + exactTokens + outfit tokens）∪ 场景行（scene.prompt / blueprint.promptTokens）。
 *
 * 身份冲突：反推词条命中「人物固有特征域」（发色/瞳色/发型/发长/主体数量），
 * 且当前身份行在该域已有取值但不含该词条 → 跳过并报告（以当前作画角色为准，
 * 图上人物 ≠ 当前角色时，特征词条会污染角色身份）。
 *
 * 互斥组冲突（2026-08-29 修复「校服 + 泳装并存」）：反推词条命中互斥组
 * （服装/时段/天气），且身份行已占用**另一个**组 → 跳过并报告。
 * 语义与身份域相反：身份域是域内互斥（pink_hair vs blonde_hair 不能共存），
 * 互斥组是组间互斥（校服 vs 泳装不能共存），同组内可叠加
 * （school_uniform + pleated_skirt 同属「校服/水手服」族）。
 * 组定义复用 promptPolicy 的 MUTUAL_EXCLUSION_GROUPS —— 与最终提示词的
 * 「服装相互冲突」警告同一真相源，杜绝两处判定漂移。
 */

// ── 人物固有特征域（同域不同值 = 身份冲突） ────────────────────────────────

const HAIR_COLOR_RE = /(?:very_)?(?:black|white|blonde|brown|red|pink|blue|silver|purple|orange|green|grey|gray|auburn|platinum|multicolored|colored|gradient|starry|light_brown|dark_brown|light_blue|light_purple|dark_green|pale_pink|silver_white)_hair$/
const EYE_COLOR_RE = /(?:black|white|blonde|brown|red|pink|blue|silver|purple|orange|green|grey|gray|amber|golden|yellow|gold|aqua|teal|violet|crimson|scarlet|starry|star-shaped|heterochromia|pink|light_blue|light_purple|dark_red)_eyes$/
const HAIR_STYLE_RE = /(?:twintails|low_twintails|high_twintails|side_twintails|braid|braids|single_braid|twin_braids|ponytail|side_ponytail|hair_bun|side_bun|double_bun|ahoge|antenna_hair|parted_bangs|hime_cut|bob_cut|hair_down|haircut|short_ponytail)$/
const HAIR_LENGTH_RE = /(?:very_long|absurdly_long|long|short|medium)_hair$/
const SUBJECT_COUNT_RE = /^(?:1girl|2girls|multiple_girls|1boy|multiple_boys|solo|crowd)$/

interface IdentityDomain {
  name: string
  label: string
  test: (key: string) => boolean
}

const IDENTITY_DOMAINS: IdentityDomain[] = [
  { name: 'hairColor', label: '发色', test: key => HAIR_COLOR_RE.test(key) },
  { name: 'eyeColor', label: '瞳色', test: key => EYE_COLOR_RE.test(key) },
  { name: 'hairStyle', label: '发型', test: key => HAIR_STYLE_RE.test(key) },
  { name: 'hairLength', label: '发长', test: key => HAIR_LENGTH_RE.test(key) },
  { name: 'subjectCount', label: '主体数量', test: key => SUBJECT_COUNT_RE.test(key) },
]

// ── 马赛克/打码/元数据与噪点词条：反推命中即自动过滤（2026-08-29 / 2026-09 优化） ─────────────
// 1. NSFW 素材常带官方打码/马赛克，反推出的打码词条会把这些视觉特征带进提示词；
// 2. Danbooru 元数据（watermark/signature/artist_name/rating:* 等）非画面视觉意图；
// 3. 质量词（masterpiece/best_quality 等）与打分词（score_*）出图时由模型 profile 统一管理，反推中多出反致质量词堆叠超标；
// 4. 画质缺陷标签（bad_anatomy/blurry 等）反推进正向会劣化成图。
// uncensored（无码）是正向属性，不在过滤清单。
const CENSOR_OR_ARTIFACT_TAGS = new Set([
  'censored',
  'mosaic_censoring',
  'bar_censor',
  'convenient_censoring',
  'pointless_censoring',
  'heart_censor',
  'hair_censor',
  'out_of_frame_censoring',
  'novelty_censor',
  'steam_censor',
  'blur_censor',
  'censored_nipples',
  'identity_censor',
  'tail_censor',
  'light_censor',
  'soap_censor',
  'blank_censor',
  'character_censor',
  'watermark',
  'signature',
  'username',
  'artist_name',
  'text',
  'commentary',
  'commentary_request',
  'source_anime',
  'source_filmmaker',
  'source_game',
  'source_picture',
  'copyright_name',
  'character_name',
  'bad_anatomy',
  'bad_hands',
  'blurry',
  'jpeg_artifacts',
  'lowres',
  'low_quality',
  'worst_quality',
  'poorly_drawn',
  'poorly_drawn_face',
  'sketch',
])

const RATING_TAG_RE = /^rating(?:_safe|_general|_sensitive|_questionable|_explicit|:safe|:general|:sensitive|:questionable|:explicit)$/

/** 立绘/单人物设定图常见留白背景词（若已有具体场景，自动忽略以保护场景环境）。 */
const STANDALONE_BG_TAGS = new Set([
  'white_background',
  'simple_background',
  'plain_background',
  'grey_background',
  'gray_background',
  'transparent_background',
])

/** 命中马赛克/打码/元数据过滤清单的词条（归一后比较）。 */
export function isCensorTag(tag: string): boolean {
  const key = normalizeKey(tag)
  if (!key) return false
  if (CENSOR_OR_ARTIFACT_TAGS.has(key) || RATING_TAG_RE.test(key)) return true
  if (QUALITY_TOKENS.has(key) || /^score_\d+$/i.test(key)) return true
  return false
}

/** 词条命中的身份域（无则 null）。 */
export function identityDomainOf(tag: string): IdentityDomain | null {
  const key = normalizeKey(tag)
  return IDENTITY_DOMAINS.find(domain => domain.test(key)) ?? null
}

export interface InterrogateTagConflict {
  tag: string
  domain: string
  reason: string
}

export interface InterrogateMergeInput {
  /** 反推词条（建议传入已剥离角色名的 general tags）。 */
  tags: ReadonlyArray<string>
  /** 已有手动词条（store.manualTags）。 */
  manualTags: ReadonlySet<string>
  /** 身份行词条：studio 为 charPrompt tokens；popular 为 identityTokens +
   *  exactTokens + 当前 outfit tokens（调用方经 collectInterrogateContext 组装）。 */
  identityTokens: ReadonlyArray<string>
  /** 场景行词条：studio 为场景 prompt+tags；popular 为蓝图 promptTokens。 */
  sceneTokens?: ReadonlyArray<string>
  shot?: string | null
  replaceOutfit?: boolean
}

export interface InterrogateMergeResult {
  /** 可写入 manualTags 的新词条（保持反推置信度顺序）。 */
  accepted: string[]
  /** 与手动/身份/场景重复而跳过的词条。 */
  duplicates: string[]
  /** 与当前角色身份域冲突而跳过的词条（含域与原因）。 */
  conflicts: InterrogateTagConflict[]
  /** 马赛克/打码类词条（自动过滤，不带进提示词）。 */
  filtered: string[]
  /**
   * 反推出、且与当前角色服装**跨族**的服装词条。
   *
   * 这些词条**不进 accepted**（追加到 manualTags 末尾会被角色那 12 个服装 tag
   * 与 "She wears ..." 散文淹没），而是由调用方拿去**顶替**角色默认服装
   * （outfit.tokens + outfit.prose），这样参考图的服装才真正生效。
   * 用户 2026-08-29 选定行为：自动替换，可一键切回。
   */
  outfitReplacement: string[]
  /** 被顶替掉的当前服装族名（提示文案用）；无替换时为 null。 */
  replacedOutfitGroup: string | null
  /**
   * 因采纳参考图姿势/服装/视线/视角等，需要从现有 manualTags 中自动移除的旧词条。
   */
  obsoleteManualTags: string[]
  /**
   * 成功还原参考图姿势与服装的具体操作说明。
   */
  restorations: string[]
}

function toKeySet(tokens: ReadonlyArray<string>): Set<string> {
  const set = new Set<string>()
  for (const token of tokens) {
    const key = normalizeKey(token)
    if (key) set.add(key)
  }
  return set
}

/** 三重去重 + 身份域与全维度冲突消解后的可叠加词条（参考图姿势与服装优先还原）。 */
export function mergeInterrogatedTags(input: InterrogateMergeInput): InterrogateMergeResult {
  const occupied = toKeySet([...input.identityTokens, ...(input.sceneTokens ?? []), ...input.manualTags])
  const seen = new Set(occupied)
  const accepted: string[] = [], duplicates: string[] = [], filtered: string[] = [], outfitReplacement: string[] = []
  const conflicts: InterrogateTagConflict[] = []
  const obsoleteManualTags: string[] = []
  const restorations: string[] = []
  let replacedOutfitGroup: string | null = null
  let incomingOutfit: string | null = null
  const incomingGroupByCat = new Map<string, string>()
  const selectedFraming = resolveFramingMode(input.shot)
  const conflict = (tag: string, domain: string, reason: string) => conflicts.push({ tag, domain, reason })

  for (const raw of input.tags) {
    const key = normalizeKey(raw)
    if (!key) continue
    if (isCensorTag(key)) { filtered.push(key); continue }
    if (seen.has(key)) { duplicates.push(key); continue }
    seen.add(key)
    const domain = identityDomainOf(key)
    if (domain) {
      const values = [...occupied].filter(value => domain.test(value))
      const incompatible = values.filter(value => !(domain.name === 'subjectCount'
        && ((key === 'solo' && ['1girl', '1boy'].includes(value)) || (value === 'solo' && ['1girl', '1boy'].includes(key)))))
      if (incompatible.length) {
        conflict(key, domain.label, `${domain.label}与当前角色固有特征（${incompatible.slice(0, 3).join('、')}）冲突`)
        continue
      }
    }
    const framing = resolveFramingMode(null, [key])
    if (framing) {
      const fixed = selectedFraming || [...occupied].map(value => resolveFramingMode(null, [value])).find(Boolean)
      if (fixed && fixed !== framing) { conflict(key, '镜头', '景别与当前镜头或已采用词条冲突，已保留当前构图'); continue }
    }

    // ── 镜头可见性：特写镜头下不可见脚部/鞋袜部件 ──
    const currentFraming = selectedFraming || [...occupied].map(value => resolveFramingMode(null, [value])).find(Boolean)
    if (currentFraming === 'close' && FOOTWEAR_AND_LEG_TOKENS.has(key)) {
      conflict(key, '镜头可见性', '特写镜头下脚部与鞋袜不可见，已自动忽略')
      continue
    }

    // ── 立绘纯色背景过滤：当前已有具体场景时，自动忽略立绘白底/纯色背景词以保护场景环境 ──
    const hasActiveScene = Boolean(input.sceneTokens && input.sceneTokens.length > 0)
    if (hasActiveScene && STANDALONE_BG_TAGS.has(key)) {
      conflict(key, '场景背景', '当前已选具体场景，已自动忽略参考图立绘留白背景')
      continue
    }

    // ── 视线与闭眼：参考图神态优先，清理 manualTags 中的冲突旧词 ──
    if (CLOSED_EYES_TOKENS.has(key)) {
      for (const t of input.manualTags) {
        const k = normalizeKey(t)
        if (GAZE_AND_EYE_DETAIL_TOKENS.has(k)) {
          obsoleteManualTags.push(t)
          occupied.delete(k)
        }
      }
      const remainingGaze = [...occupied].some(t => GAZE_AND_EYE_DETAIL_TOKENS.has(t))
      if (remainingGaze) {
        conflict(key, '眼神', '闭眼状态与当前角色/场景设定的直视镜头冲突')
        continue
      }
    }
    if (GAZE_AND_EYE_DETAIL_TOKENS.has(key)) {
      for (const t of input.manualTags) {
        const k = normalizeKey(t)
        if (CLOSED_EYES_TOKENS.has(k)) {
          obsoleteManualTags.push(t)
          occupied.delete(k)
        }
      }
      const remainingClosed = [...occupied].some(t => CLOSED_EYES_TOKENS.has(t))
      if (remainingClosed) {
        conflict(key, '眼神', '眼神细节与当前闭眼状态冲突')
        continue
      }
    }

    // ── 赤脚与穿鞋：参考图穿戴优先，清理 manualTags 中的冲突旧词 ──
    if (BAREFOOT_TOKENS.has(key)) {
      for (const t of input.manualTags) {
        const k = normalizeKey(t)
        if (SHOE_TOKENS.has(k)) {
          obsoleteManualTags.push(t)
          occupied.delete(k)
        }
      }
      const remainingShoes = [...occupied].some(t => SHOE_TOKENS.has(t))
      if (remainingShoes && input.replaceOutfit === false) {
        conflict(key, '穿戴状态', '赤脚与当前穿鞋状态冲突')
        continue
      }
    }
    if (SHOE_TOKENS.has(key)) {
      for (const t of input.manualTags) {
        const k = normalizeKey(t)
        if (BAREFOOT_TOKENS.has(k)) {
          obsoleteManualTags.push(t)
          occupied.delete(k)
        }
      }
      const remainingBarefoot = [...occupied].some(t => BAREFOOT_TOKENS.has(t))
      if (remainingBarefoot) {
        conflict(key, '穿戴状态', '穿鞋与当前赤脚状态冲突')
        continue
      }
    }

    // ── 嘴部表情互斥 ──
    if (key === 'closed_mouth') {
      if (input.manualTags.has('open_mouth')) {
        obsoleteManualTags.push('open_mouth')
        occupied.delete('open_mouth')
      } else if (occupied.has('open_mouth')) {
        conflict(key, '面部表情', '闭嘴与当前张嘴表情冲突')
        continue
      }
    }
    if (key === 'open_mouth') {
      if (input.manualTags.has('closed_mouth')) {
        obsoleteManualTags.push('closed_mouth')
        occupied.delete('closed_mouth')
      } else if (occupied.has('closed_mouth')) {
        conflict(key, '面部表情', '张嘴与当前闭嘴表情冲突')
        continue
      }
    }

    const hit = mutualGroupWithCategory(key)
    if (hit) {
      if (hit.category === 'outfit') {
        if (incomingOutfit && incomingOutfit !== hit.group) {
          conflict(key, hit.label, `反推结果包含多套服装，已优先采用「${incomingOutfit}」`)
          continue
        }
        incomingOutfit = hit.group
      } else {
        const priorIncoming = incomingGroupByCat.get(hit.category)
        if (priorIncoming && priorIncoming !== hit.group) {
          conflict(key, hit.label, `反推结果包含多个${hit.label}，已优先还原首选「${priorIncoming}」`)
          continue
        }
        incomingGroupByCat.set(hit.category, hit.group)
      }

      const prior = [...occupied].map(mutualGroupWithCategory).filter(value => value?.category === hit.category)
      const foreign = prior.find(value => value?.group !== hit.group)

      if (foreign) {
        if (hit.category === 'outfit') {
          if (input.replaceOutfit !== false) {
            outfitReplacement.push(key)
            replacedOutfitGroup = foreign.group
            continue
          } else {
            conflict(key, hit.label, `${hit.label}冲突：反推出「${hit.group}」，当前已定为「${foreign.group}」`)
            continue
          }
        } else if (hit.category === 'pose' || hit.category === 'viewpoint' || hit.category === 'angle') {
          // 姿势、视角、拍摄角度：参考图动作构图优先！最大化还原上传图片！
          for (const t of input.manualTags) {
            const match = mutualGroupWithCategory(t)
            if (match?.category === hit.category && match.group !== hit.group) {
              obsoleteManualTags.push(t)
              occupied.delete(normalizeKey(t))
            }
          }
          for (const occ of [...occupied]) {
            const match = mutualGroupWithCategory(occ)
            if (match?.category === hit.category && match.group !== hit.group) {
              occupied.delete(occ)
            }
          }
          if (!restorations.some(r => r.includes(hit.label))) {
            restorations.push(`已还原参考图${hit.label}「${hit.group}」（替换原「${foreign.group}」）`)
          }
        } else {
          conflict(key, hit.label, `${hit.label}冲突：反推出「${hit.group}」，当前已定为「${foreign.group}」`)
          continue
        }
      }
    }
    accepted.push(key)
    occupied.add(key)
  }
  // Keep all accepted members of the chosen clothing family in the replacement.
  if (outfitReplacement.length) {
    for (let i = accepted.length - 1; i >= 0; i--) {
      if (mutualGroupWithCategory(accepted[i])?.group === incomingOutfit) outfitReplacement.unshift(...accepted.splice(i, 1))
    }
  }
  return { accepted, duplicates, conflicts, filtered, outfitReplacement, replacedOutfitGroup, obsoleteManualTags, restorations }
}

/**
 * 反推识别出的角色名（characterTags）与当前作画角色的冲突说明。
 * 命中当前角色触发词 → 无冲突返回 null；识别到其他角色 → 提示文案。
 *
 * 2026-08-29 修复「同角色误报冲突」：WD14 输出的角色名是 Danbooru 标准词条
 * （mika_(blue_archive)），而项目身份词可能写法不同（misono_mika / 空格格式 /
 * 缺作品后缀）。除精确匹配外，支持角色名等价匹配（见 isSameCharacterKey）。
 */
export function characterConflictNote(
  characterTags: ReadonlyArray<string> | undefined,
  identityTokens: ReadonlyArray<string>,
  aliases?: ReadonlyArray<string>,
): string | null {
  if (!characterTags || !characterTags.length) return null
  const identityKeys = toKeySet(identityTokens)
  const aliasKeys = new Set<string>()
  for (const alias of aliases ?? []) {
    const key = normalizeKey(alias)
    if (key) aliasKeys.add(key)
  }
  const foreign = characterTags.filter(tag => {
    const key = normalizeKey(tag)
    if (!key) return false
    if (identityKeys.has(key)) return false
    // 角色名等价匹配：剥作品后缀（_(blue_archive) 等）后与身份词/别名互相
    // 相等或包含（mika_(blue_archive) ≙ mika ≙ misono_mika）。
    return !isSameCharacterKey(key, identityKeys, aliasKeys)
  })
  if (!foreign.length) return null
  return `图中识别到其他角色：${foreign.slice(0, 3).join('、')}${foreign.length > 3 ? ' 等' : ''}，已按当前角色作画，角色名词条未叠加`
}

/** WD14/Danbooru 角色词条的作品后缀（_(blue_archive) 等，下划线+括号段）。 */
const SERIES_SUFFIX_RE = /_\([a-z0-9_]+\)$/

/** 剥作品后缀后的角色名基座：mika_(blue_archive) → mika；misono_mika → misono_mika。 */
function seriesBase(key: string): string {
  return key.replace(SERIES_SUFFIX_RE, '')
}

/**
 * 反推角色名与当前角色身份词/别名是否等价：
 * 1. 剥作品后缀后相等（artoria_pendragon_(fate) ≙ artoria_pendragon）；
 * 2. 或一方基座包含另一方且被包含侧 ≥3 字符（mika ≙ misono_mika；
 *    makima_(chainsaw_man) 的基座 makima 与身份词 makima 相等走规则 1）。
 * 只与「当前角色」的身份词和别名比对，不会跨角色误伤。
 */
function isSameCharacterKey(key: string, identityKeys: ReadonlySet<string>, aliasKeys: ReadonlySet<string>): boolean {
  const base = seriesBase(key)
  const known = new Set<string>(identityKeys)
  for (const alias of aliasKeys) known.add(seriesBase(alias))
  for (const candidate of known) {
    if (key === candidate || base === candidate) return true
  }
  for (const candidate of known) {
    const a = base
    const b = candidate
    if (a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a))) return true
  }
  return false
}

// ── 上下文采集（视图层参数组装，保持工具层与 store 解耦） ────────────────

export interface InterrogateContextParams {
  kind: 'studio' | 'popular'
  /** studio：pb.charPrompt（"1girl, solo, ayachi_nene, white_hair, …"）。 */
  charPrompt?: string
  /** studio：当前场景 prompt 与 tags。 */
  scenePrompt?: string
  sceneTags?: ReadonlyArray<string>
  /** popular：当前角色词条聚合。 */
  character?: {
    identityTokens: ReadonlyArray<string>
    exactTokens?: ReadonlyArray<string>
    outfitTokens?: ReadonlyArray<string>
    /** 2026-08-29：角色别名（含 Danbooru 标准词条，用于同角色等价比对）。 */
    aliases?: ReadonlyArray<string>
  } | null
  /** popular：当前蓝图 promptTokens。 */
  blueprintTokens?: ReadonlyArray<string>
}

/** 采集反推合并所需的身份行与场景行词条。 */
export function collectInterrogateContext(params: InterrogateContextParams): {
  identityTokens: string[]
  sceneTokens: string[]
  aliases: string[]
} {
  if (params.kind === 'popular') {
    const character = params.character
    return {
      identityTokens: [
        ...(character?.identityTokens ?? []),
        ...(character?.exactTokens ?? []),
        ...(character?.outfitTokens ?? []),
      ],
      sceneTokens: [...(params.blueprintTokens ?? [])],
      aliases: [...(character?.aliases ?? [])],
    }
  }
  return {
    identityTokens: tokenize(String(params.charPrompt || '')),
    sceneTokens: [
      ...tokenize(String(params.scenePrompt || '')),
      // Search/index tags are not part of the compiled scene prompt.
    ],
    aliases: [],
  }
}

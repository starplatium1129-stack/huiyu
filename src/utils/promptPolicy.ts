import { WIDE_TOKENS, CLOSE_TOKENS, MID_TOKENS } from './promptFramingTokens.ts'
import type { PromptPart, PromptEngine, ModelProfile, LoraMeta } from './promptPolicyTypes.ts'
export type { PromptPart, PromptEngine, DrawCapabilities, ModelProfile, LoraMeta } from './promptPolicyTypes.ts'
import { mutualGroupWithCategory } from './promptDiagnostics.ts'
export {
  BANNED_TAGS,
  checkArtDirection,
  QUALITY_WORDS,
  QUALITY_TOKENS,
  QUALITY_OR_SCORE_RE,
  mutualGroupOf,
  mutualGroupWithCategory,
  membersOfMutualGroup,
  analyzeParts,
  FACE_CLOSEUP_TOKENS,
  FOOTWEAR_AND_LEG_TOKENS,
  SHOE_TOKENS,
  BAREFOOT_TOKENS,
  CLOSED_EYES_TOKENS,
  GAZE_AND_EYE_DETAIL_TOKENS,
} from './promptDiagnostics.ts'
export type { MutualGroupCategory, MutualGroupHit, PromptReport } from './promptDiagnostics.ts'
import { framingShot, type PromptScene } from './sceneFraming.ts'
export type { PromptScene } from './sceneFraming.ts'
// Prompt policy — 从重构前 tools/prompt-policy.js + prompt-builder/prompt.js 迁移
// 负责：Danbooru 标签规范化、模型 profile 质量/负面前缀、LoRA 权重策略、
//       framing 冲突消解、场景模板净化、结构健康报告

import { resolveDrawCapabilities } from './drawCapabilities.ts'
import {
  sanitizeNatsumeSoloTemplate,
  sanitizeNeneSoloTemplate,
  sanitizeSoloTemplate,
} from './soloTemplateSanitize.ts'

export { sanitizeSoloTemplate } from './soloTemplateSanitize.ts'





/**
 * 引擎/底模能力表：把“这个引擎能不能做 X”从散落硬编码收敛成数据驱动。
 * 后端 AnimaOption.capabilities 是运行时模型白名单；这里作为前端统一视图，
 * 由引擎默认值 + data/presets.json 的 profile.capabilities + 后端模型能力合并。
 */








const NEGATIVE_BOILERPLATE = new Set([
  'bad_quality', 'worst_quality', 'low_quality', 'normal_quality', 'worst_detail',
  'lowres', 'blurry', 'jpeg_artifacts', 'text', 'watermark', 'logo', 'signature',
  'username', 'sketch', 'censor', 'old', 'early', 'bad_anatomy', 'bad_hands',
  'mutated_hands', 'extra_fingers', 'missing_fingers', 'fused_fingers', 'extra_arms',
  'extra_legs', 'extra_limbs', 'deformed', 'bad_proportions', 'duplicate', 'cropped',
  'poorly_drawn_face',
])

/** 已知多词 Danbooru 标签：空格 → 下划线（长度降序，避免短词先匹配） */
const UNDERSCORE_TAGS = [
  'beautiful detailed eyes', 'chromatic aberration', 'depth of field',
  'volumetric lighting', 'dramatic lighting', 'natural lighting', 'studio lighting',
  'back lighting', 'side lighting', 'rim lighting', 'soft lighting', 'hard lighting',
  'extreme close up', 'dynamic angle', 'portrait shot', 'cowboy shot',
  'upper body', 'full body', 'medium shot', 'long shot', 'close up', 'wide shot',
  'dutch angle', 'pov shot', 'half closed eyes', 'crossed arms',
  'hands on hips', 'hand on chest', 'arms behind back', 'arms up',
  'sparkling eyes', 'glowing eyes', 'detailed eyes', 'narrowed eyes', 'wide eyes',
  'open mouth', 'closed mouth', 'parted lips', 'tongue out',
  'golden hour', 'window light', 'pink tone', 'warm light', 'soft light', 'lantern light',
  'loose hair', 'wet hair', 'short hair', 'long hair',
  'school uniform', 'off shoulder', 'crop top', 'mini skirt', 'pleated skirt',
  'thigh highs', 'hair ribbon', 'hair clip', 'hair ornament',
  'cat ears', 'sailor collar', 'open jacket', 'elbow gloves',
  'puffy sleeves', 'detached sleeves', 'frilled skirt',
  'cherry blossom', 'rule of thirds', 'centered composition', 'framed composition',
  'foreground framing', 'by window', 'cool palette', 'warm color palette',
].sort((a, b) => b.length - a.length)

/** Danbooru 规范化：逗号分段后空格/连字符 → 下划线 */
export function norm(text: string): string {
  return String(text || '')
    .split(',')
    .map(seg => {
      const s = seg.trim()
      if (!s) return ''
      // lora 语法保持原样
      if (/^<lora:/i.test(s)) return s
      if (/^BREAK$/i.test(s)) return 'BREAK'
      const lower = s.toLowerCase()
      for (const tag of UNDERSCORE_TAGS) {
        if (lower === tag) return tag.replace(/\s+/g, '_')
      }
      return s.replace(/[\s-]+/g, '_')
    })
    .filter(Boolean)
    .join(', ')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function formatAnimaToken(token: string, exactTokens: readonly string[] = [], exactPrefixes: readonly string[] = []): string {
  const scores: string[] = []
  const exact: string[] = []
  let protectedToken = token.replace(/\bscore_(\d+)\b/gi, (_match, value: string) => {
    const marker = `ZZAICSSCORE${scores.length}ZZ`
    scores.push(`score_${value}`)
    return marker
  })
  const protectedExact = [...new Set(exactTokens)].concat(
    tokenize(token).filter(value => /^(?:nene_|natsume_)[a-z0-9_]+$/i.test(value)),
    tokenize(token).filter(value => exactPrefixes.some(prefix => value.toLowerCase().startsWith(prefix.toLowerCase()))),
  )
  ;[...new Set(protectedExact)]
    .filter(value => value.trim())
    .sort((a, b) => b.length - a.length)
    .forEach(value => {
      const marker = `ZZAICSEXACT${exact.length}ZZ`
      const pattern = new RegExp(`(^|[^A-Za-z0-9_])(${escapeRegExp(value)})(?=$|[^A-Za-z0-9_])`, 'g')
      protectedToken = protectedToken.replace(pattern, `$1${marker}`)
      exact.push(value)
    })
  let formatted = protectedToken.replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
  scores.slice().reverse().forEach((score, reverseIndex) => {
    const index = scores.length - reverseIndex - 1
    formatted = formatted.replace(`ZZAICSSCORE${index}ZZ`, score)
  })
  exact.slice().reverse().forEach((value, reverseIndex) => {
    const index = exact.length - reverseIndex - 1
    formatted = formatted.replace(`ZZAICSEXACT${index}ZZ`, value)
  })
  return formatted
}

/** Format one prompt for the model family without changing the SD contract. */
export function formatPromptForEngine(text: string, engine: PromptEngine = 'sd', exactTokens: readonly string[] = [], exactPrefixes: readonly string[] = []): string {
  const raw = String(text || '')
  if (engine === 'sd') return norm(raw)
  if (engine === 'krea2') return raw.replace(/<lora:[^>]+>/gi, '').replace(/\bBREAK\b/gi, ', ').trim()
  const clean = raw.replace(/<lora:[^>]+>/gi, '')
  return splitBreaks(dedupeText(clean))
     .map(section => tokenize(section).map(token => formatAnimaToken(token, exactTokens, exactPrefixes)).filter(Boolean).join(', '))
    .filter(Boolean)
    .join(' BREAK ')
}

export function formatPromptForProfile(text: string, profile: ModelProfile | null, fallbackEngine: PromptEngine = 'sd'): string {
  const engine = profile?.engine || (profile?.tag_style === 'space' ? 'anima' : fallbackEngine)
  return formatPromptForEngine(text, engine, profile?.exact_tokens || [], profile?.exact_prefixes || [])
}

export function normalizeKey(token: string): string {
  return String(token || '')
    .replace(/^\s*\[NEG\]\s*/i, '')
    .replace(/^\s*<lora:|>\s*$/gi, '')
    .replace(/^\s*\(+|\)+\s*$/g, '')
    .replace(/:\s*-?\d+(?:\.\d+)?\s*$/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s\-/]+/g, '_')
}

export function tokenize(text: string): string[] {
  return String(text || '').split(',').map(token => token.trim()).filter(Boolean)
}

export function splitBreaks(text: string): string[] {
  return String(text || '')
    .replace(/\s*,?\s*\bBREAK\b\s*,?\s*/gi, '\u0000BREAK\u0000')
    .split('\u0000BREAK\u0000')
    .map(section => section.trim())
}

function dedupeSegment(text: string, seen = new Set<string>()): string {
  return tokenize(text).filter(token => {
    const key = normalizeKey(token)
    if (!key || key === 'break' || seen.has(key)) return false
    seen.add(key)
    return true
  }).join(', ')
}

/** BREAK 是角色作用域边界；不同角色可以重复服装、表情等主体属性。 */
export function dedupeText(text: string, externalSeen?: Set<string>): string {
  const sections = splitBreaks(text)
  if (sections.length === 1) return dedupeSegment(sections[0], externalSeen ?? new Set())
  return sections
    .map(section => dedupeSegment(section, new Set()))
    .filter(Boolean)
    .join(' BREAK ')
}

export function sanitizePrompt(text: string): string {
  return dedupeText(String(text || '').replace(/\s+/g, ' '))
}

export function mergeTokenText(...texts: string[]): string {
  const seen = new Set<string>()
  const out: string[] = []
  texts.forEach(text => {
    tokenize(text).forEach(token => {
      const key = normalizeKey(token)
      if (!seen.has(key)) { seen.add(key); out.push(token) }
    })
  })
  return out.join(', ')
}

export function isNegativeBoilerplate(token: string): boolean {
  return NEGATIVE_BOILERPLATE.has(normalizeKey(token))
}

export function mergeNegativePrompt(
  prefix: string,
  base = '',
  mode: 'merge' | 'replace' = 'merge',
  replaceScope: 'boilerplate' | 'all' = 'boilerplate',
): string {
  if (mode !== 'replace') return dedupeSegment([prefix, base].filter(Boolean).join(', '), new Set())
  if (replaceScope === 'all') return dedupeSegment(prefix, new Set())
  const semantic = tokenize(base).filter(token => !isNegativeBoilerplate(token))
  return dedupeSegment([prefix, ...semantic].filter(Boolean).join(', '), new Set())
}

// ── 模型 profile ───────────────────────────────────────────────────────────

function normalizeModelName(name: string): string {
  return String(name || '').toLowerCase().replace(/\.(safetensors|ckpt)$/i, '').replace(/\s*\[[0-9a-f]+\]\s*$/i, '').trim()
}

/** 按当前模型名匹配 profile；只有 SD 保留本站历史默认 profile 回退。 */
export function resolveModelProfile(
  profiles: ModelProfile[],
  modelName?: string,
  engine: PromptEngine = 'sd',
): ModelProfile | null {
  const all = Array.isArray(profiles) ? profiles : []
  const list = all.filter(profile => engine === 'sd'
    ? !profile.engine || profile.engine === 'sd'
    : profile.engine === engine)
  if (!list.length) return null
  const target = normalizeModelName(modelName || '')
  if (target) {
    const hit = list.find(p =>
      [p.model_id, ...(p.match || [])].some(m => {
        const key = normalizeModelName(String(m))
        return key && (target.includes(key) || key.includes(target))
      }),
    )
    if (hit) return hit
  }
  return engine === 'sd' ? list[0] : null
}

export function sceneRating(scene: unknown): 'R18' | 'R15' | 'ALL' {
  const s = (scene ?? {}) as { rating?: unknown; mature?: unknown }
  const rating = String(s.rating || '').toUpperCase()
  if (rating === 'R18' || s.mature) return 'R18'
  if (rating === 'R15') return 'R15'
  return 'ALL'
}

/** 手动词条 R18 门控词（LoRA 控制词 + 显式裸体词），单一事实源。 */
export const MANUAL_R18_RE = /^(?:nene_r18|natsume_r18|nude|completely_nude|naked|topless|nipples|bare_breasts|pussy|vaginal|penis|sex|uncensored|nsfw)$/i

/**
 * manualTags 是否构成 R18 迹象：门控词正则命中，或命中词条池 Mature 分类
 * （matureTokens 由调用方从 tags.json cat==='Mature' 派生，见 usePromptAssembly /
 * usePopularPromptAssembly）。评级联动单一契约：studio（effectiveScene）与
 * popular（buildPopularPromptPlan）共用，2026-08-29 随机灵感 Mature 池提额引入——
 * 此前 47 条 Mature 词条仅 5 条能触发正则，抽中也不升评级，负面强制压制
 * nsfw/nude/explicit，用户感知"随机不到 NSFW"。
 */
export function isManualR18Tags(tags: Iterable<string>, matureTokens?: ReadonlySet<string>): boolean {
  for (const tag of tags) {
    if (MANUAL_R18_RE.test(tag)) return true
    if (matureTokens && matureTokens.has(normalizeKey(tag))) return true
  }
  return false
}

/**
 * v18 训练 caption 中实际出现的服装词组。
 *
 * 主控制词负责选择服装身份，后续词负责锁定官方配色、剪裁和腿部细节。
 * 这里故意不使用近义词或自然语言改写，避免网站提示词与训练语汇脱节。
 */
export { characterControlTokens, TRAINED_OUTFIT_BUNDLES } from './characterControlTokens.ts'

export function profileRatingTag(profile: ModelProfile | null, scene: unknown): string {
  if (!profile) return ''
  const rating = sceneRating(scene)
  if (rating === 'R18') return String(profile.rating_r18 || '')
  if (rating === 'R15') return String(profile.rating_r15 || '')
  return String(profile.rating_all || '')
}

/** 质量前缀：模型 profile 优先，并按分级追加 rating 标签。
 *  WAI 官方前缀必须原样保留空格（masterpiece, best quality, amazing quality），
 *  只有 Anima/Krea 才走家族格式化。 */
export function qualityPrefix(profile: ModelProfile | null, scene?: unknown, engine: PromptEngine = 'sd'): string {
  const prefix = profile ? String(profile.quality_prefix ?? '') : 'masterpiece, best quality, very aesthetic, absurdres'
  const rating = profileRatingTag(profile, scene)
  const merged = rating ? mergeTokenText(prefix, rating) : prefix
  return engine === 'sd' ? merged : formatPromptForEngine(merged, engine, profile?.exact_tokens || [])
}

/** 负面前缀：按 profile 的 merge/replace 策略与场景负面合并 */
export function modelNegativePrompt(profile: ModelProfile | null, baseNegative: string, engine: PromptEngine = 'sd'): string {
  const prefix = profile?.negative_prefix || ''
  const merged = prefix ? mergeNegativePrompt(
    prefix,
    baseNegative || '',
    (profile?.negative_mode as 'merge' | 'replace') || 'merge',
    (profile?.negative_replace_scope as 'boilerplate' | 'all') || 'boilerplate',
  ) : (baseNegative || '')
  return engine === 'anima' ? formatPromptForEngine(merged, engine, profile?.exact_tokens || []) : merged
}

export function adaptNegative(
  text: string,
  scene?: unknown,
  context: { shot?: string | null; character?: string | null } = {},
): string {
  const rating = sceneRating(scene)
  const remove = new Set<string>()
  // 2026-08-15 用户裁定：裸体压制负面只在 All 评级加；R15 及以上（含 R18）都不堵露点，
  // 避免同一场景因评级变化导致出图画面明显不同（词条差异会真实改变画面）。
  if (rating !== 'ALL') ['nsfw', 'nude', 'naked', 'explicit'].forEach(tag => remove.add(tag))
  if (context.shot === 'close' || context.shot === 'detail') remove.add('cropped')
  if (context.character === 'triad') remove.add('duplicate')

  const tokens = tokenize(text).filter(token => !remove.has(normalizeKey(token)))
  const required = rating === 'ALL'
    ? ['nsfw', 'nude', 'explicit']
    : ['child', 'loli', 'underage']
  required.forEach(tag => tokens.push(tag))
  return dedupeSegment(tokens.join(', '), new Set())
}

/** 紧凑手部/解剖/文字/白边留白保护词：任何 profile 负面都必须带上，防止场景无负面时裸奔或出现白边框/画面缩角。 */
export const NEGATIVE_PROTECTION = 'bad anatomy, bad hands, extra fingers, missing fingers, fused fingers, extra arms, extra legs, deformed, text, watermark, logo, signature, border, white_border, framed, letterbox, pillarbox, padding, margin, inset, comic_panel, split_screen'

/**
 * 模型原生负面统一装配（App 与 corpus 测试共用）：
 *   官方前缀 + 场景非样板排除词（generic boilerplate 由 replace 策略移除）
 *   + 紧凑手/解剖/文字保护 + rating 安全。
 * Krea 恒空；Anima 负面独立于 SD 负面开关；Aesthetic 额外剥掉 score 词。
 */
export function assembleNegative(
  profile: ModelProfile | null,
  scene: PromptScene | null | undefined,
  engine: PromptEngine,
  context: { shot?: string | null; character?: string | null; custom?: string; sdNegativeEnabled?: boolean } = {},
): string {
  const capabilities = resolveDrawCapabilities(engine, profile)
  if (!capabilities.negative) return ''
  if (engine === 'sd' && context.sdNegativeEnabled === false) return ''
  const profileNegative = modelNegativePrompt(profile, scene?.negative || '', engine)
  const custom = engine === 'sd' ? String(context.custom || '').trim() : ''
  const merged = custom
    ? mergeTokenText(custom, mergeTokenText(NEGATIVE_PROTECTION, profileNegative))
    : mergeTokenText(NEGATIVE_PROTECTION, profileNegative)
  const adapted = adaptNegative(merged, scene, { shot: context.shot, character: context.character })
  const formatted = engine === 'anima' ? formatPromptForProfile(adapted, profile, engine) : adapted
  if (profile?.strip_quality_tokens === true) {
    return tokenize(formatted).filter(token => !/^score_\d+$/i.test(normalizeKey(token))).join(', ')
  }
  return formatted
}

// ── Framing（镜头冲突消解） ────────────────────────────────────────────────





export function resolveFramingMode(shot?: string | null, manualTags: string[] = []): '' | 'wide' | 'close' | 'mid' {
  if (shot === 'wide') return 'wide'
  if (shot === 'close' || shot === 'detail') return 'close'
  if (shot === 'medium') return 'mid'
  if (shot) return ''
  const keys = manualTags.map(normalizeKey)
  if (keys.some(k => WIDE_TOKENS.has(k))) return 'wide'
  if (keys.some(k => CLOSE_TOKENS.has(k))) return 'close'
  if (keys.some(k => MID_TOKENS.has(k))) return 'mid'
  return ''
}

/** 同一 prompt 里不能既 close_up 又 full_body：保留当前镜头，剔除冲突项 */
export function filterFraming(text: string, shot?: string | null): string {
  const mode = resolveFramingMode(shot)
  if (!mode) return text
  const drop = mode === 'wide'
    ? new Set([...CLOSE_TOKENS, ...MID_TOKENS])
    : mode === 'close'
      ? new Set([...WIDE_TOKENS, ...MID_TOKENS])
      : new Set([...WIDE_TOKENS, ...CLOSE_TOKENS])
  return splitBreaks(text)
    .map(section => tokenize(section).filter(token => !drop.has(normalizeKey(token))).join(', '))
    .filter(Boolean)
    .join(' BREAK ')
}

export function applyFraming(parts: PromptPart[], shot?: string | null): PromptPart[] {
  const mode = resolveFramingMode(shot)
  if (!mode) return parts
  return parts.map(part => {
    if (part.cls === 'n' || part.cls === 'l') return part
    return { ...part, text: filterFraming(part.text, shot) }
  }).filter(part => part.text.trim())
}

export function dedupeParts(parts: PromptPart[]): PromptPart[] {
  const positiveSeen = new Set<string>()
  const negativeSeen = new Set<string>()
  return parts.map(part => {
    if (part.cls === 'l') return part
    const seen = part.cls === 'n' ? negativeSeen : positiveSeen
    const scoped = /\bBREAK\b/i.test(part.text)
    return { ...part, text: dedupeText(part.text, scoped ? undefined : seen) }
  }).filter(part => part.text.trim())
}

// ── 双人构图增强 ──────────────────────────────────────────────────────────

export function enrichDualPrompt(template: string, neneTags: string[], natsumeTags: string[]): string {
  const sections = splitBreaks(template)
  const left = sections[0] || ''
  const right = sections[1] || ''
  const leftStart = left.lastIndexOf('(')
  const global = leftStart >= 0 ? left.slice(0, leftStart).replace(/,\s*$/, '') : left.replace(/,\s*$/, '')
  const leftBlock = leftStart >= 0 ? left.slice(leftStart) : ''
  const leftIsNatsume = /shiki_natsume/i.test(leftBlock)
  const rightIsNene = /ayachi_nene/i.test(right)
  const mergeSubject = (block: string, identityTags: string[]) => {
    let raw = block.trim()
    if (raw.startsWith('(')) raw = raw.slice(1)
    if (raw.endsWith(')')) raw = raw.slice(0, -1)
    return `(${dedupeText([...identityTags, ...tokenize(raw)].join(', '))})`
  }
  const enrichedLeft = mergeSubject(leftBlock, leftIsNatsume ? natsumeTags : neneTags)
  const enrichedRight = mergeSubject(right, rightIsNene ? neneTags : natsumeTags)
  return `${[global, enrichedLeft].filter(Boolean).join(', ')} BREAK ${enrichedRight}`
}

// ── 单人引擎防分身净化已收敛至 ./soloTemplateSanitize.ts（2026-09-05 单体拆分，
//    三个 sanitize 函数共享 sanitizeSections 内核，行为不变）

/** 场景是否支持该角色（避免把宁宁场景套到夏目身上） */
export function sceneSupportsCharacter(scene: PromptScene | null | undefined, char: string): boolean {
  if (!scene) return false
  const sceneChar = String(scene.char || '')
  if (!sceneChar) return true
  if (char === 'triad') return sceneChar === 'triad' || sceneChar === 'both'
  if (sceneChar === 'triad' || sceneChar === 'both') return true
  return sceneChar === char
}

/** 场景模板净化：剥 lora、_BREAK_ 规范化、framing 过滤。
 *
 * scene.tags 是 UI/检索元数据，不会自动进入最终 Prompt。此前把与其同名
 * 的模板 token 删除，会悄悄丢失 low_twintails、hair_ribbon、two_red_hairclips
 * 等身份和服装锚点；手动 tag 的去重由调用方在后续阶段完成。
 */
export function sceneTemplateText(
  scene: PromptScene | null | undefined,
  opts: { char?: string; manualTags?: Set<string>; shot?: string | null; engine?: PromptEngine; profile?: ModelProfile | null } = {},
): string {
  if (!scene?.prompt) return ''
  let template = String(scene.prompt)
    .replace(/<lora:[^>]+>/gi, '')
    .replace(/_BREAK_/gi, ' BREAK ')
    .split(',')
    .map(t => t.trim())
    .filter(Boolean)
    .join(', ')

  if (opts.char === 'triad') {
    template = enrichDualPrompt(
      template,
      ['ayachi_nene', 'white_hair', 'very_long_hair', 'low_twintails', 'purple_eyes', 'ahoge', 'hair_ribbon'],
      ['shiki_natsume', 'black_hair', 'long_hair', 'yellow_eyes', 'mole_under_eye', 'hairclip'],
    )
  } else if (opts.char === 'natsume') {
    // The character line supplies the canonical identity; scenes remain solo regardless of old interaction tags.
    template = sanitizeNatsumeSoloTemplate(template)
  } else if (opts.char === 'nene') {
    template = sanitizeNeneSoloTemplate(template)
  }
  // 单人创作模式：只要不是显式双人组合（triad），无论任何引擎，强制净化掉多余主体词（如 2girls）
  const isDualScene = opts.char === 'triad' || scene?.char === 'triad' || scene?.char === 'both'
  const capabilities = resolveDrawCapabilities(opts.engine || 'sd', opts.profile)
  if (!isDualScene || !capabilities.dualCharacter) {
    template = sanitizeSoloTemplate(template)
  }
  // 姿势消解：当 manualTags（如反推采纳）中已有明确姿势时，场景模板中异组旧姿势自动让位
  if (opts.manualTags?.size) {
    const manualPose = [...opts.manualTags].map(mutualGroupWithCategory).find(h => h?.category === 'pose')
    if (manualPose) {
      template = template
        .split(',')
        .map(t => t.trim())
        .filter(t => {
          const hit = mutualGroupWithCategory(t)
          return !(hit?.category === 'pose' && hit.group !== manualPose.group)
        })
        .join(', ')
    }
  }
  return filterFraming(formatPromptForProfile(template, opts.profile || null, opts.engine || 'sd'), framingShot(opts.shot, scene.camera))
}

// ── LoRA 权重策略 ─────────────────────────────────────────────────────────

export interface LoraSpec { name: string; weight: number }

export interface SceneLoraRef { name: string; weight: number | null }

/**
 * WAI LoRA 解析器：在场景模板剥离之前读取显式 <lora:name:weight>，
 * 返回原始 name 与作者写的权重（无权重时为 null）。
 */
export function parseScenePromptLoras(scene: PromptScene | null | undefined): SceneLoraRef[] {
  const text = String(scene?.prompt || '')
  const refs: SceneLoraRef[] = []
  const re = /<lora:([^>:]+)(?::([\d.]+))?>/gi
  let match
  while ((match = re.exec(text))) {
    const name = String(match[1] || '').trim()
    if (!name) continue
    const weight = match[2] === undefined ? null : Number(match[2])
    refs.push({ name, weight: weight !== null && Number.isFinite(weight) ? weight : null })
  }
  return refs
}

/** 历史版本号迁移到 characters.json 的正式模型名。 */
function canonicalLoraName(name: string, fallbackByChar: Record<string, string>): string {
  if (/^ayachi_nene_v\d+/i.test(name) && fallbackByChar.nene) return fallbackByChar.nene
  if (/^shiki_natsume_v\d+/i.test(name) && fallbackByChar.natsume) return fallbackByChar.natsume
  return name
}

/**
 * LoRA 权重解析：
 * 场景模板里的显式 <lora:name:weight> 优先（保留作者权重）；没有时才回退到
 * scene.lora / fallbackByChar 并按镜头动态解析（双人 0.62 / 复杂 0.7 /
 * 全身 0.75 / 特写 0.85 / 默认）。
 */
export function resolveLoraSpecs(
  character: string,
  scene: PromptScene | null | undefined,
  loraMeta: LoraMeta[],
  fallbackByChar: Record<string, string>,
  context: { shot?: string | null; manualTags?: Set<string> } = {},
): LoraSpec[] {
  const promptRefs = parseScenePromptLoras(scene).map(ref => ({
    name: canonicalLoraName(ref.name, fallbackByChar),
    explicit: ref.weight,
  }))
  const refs = promptRefs.length
    ? promptRefs
    : String(scene?.lora ? scene.lora : (fallbackByChar[character] || ''))
        .split(',')
        .map(value => {
          const clean = value.trim().replace(/^<lora:/i, '').replace(/>$/, '')
          const parts = clean.split(':')
          return { name: canonicalLoraName((parts[0] || '').trim(), fallbackByChar), explicit: Number(parts[1]) }
        })
        .filter(item => item.name)
  if (!refs.length) return []

  const dual = character === 'triad' || refs.length > 1
  const complex = scene && (scene.category === '战斗' || scene.category === 'Active_Sync_Scenes')
  const mode = resolveFramingMode(context.shot, [...(context.manualTags ?? new Set<string>())])
  const wide = mode === 'wide'
  const portrait = mode === 'close'

  return refs.map(ref => {
    const meta = loraMeta.find(m => m?.name === ref.name) || null
    const recommended = meta?.recommended_weight || {}
    let base = Number(meta?.strength?.default)
    if (!Number.isFinite(base)) base = 0.8
    const weight = typeof ref.explicit === 'number' && ref.explicit > 0
      ? ref.explicit
      : dual ? 0.62
      : complex ? (Number(recommended.complex_scene) || 0.7)
      : wide ? (Number(recommended.fullbody) || 0.75)
      : portrait ? (Number(recommended.portrait) || 0.85)
      : base
    return { name: ref.name, weight: Number(Number(weight).toFixed(2)) }
  })
}

export function loraSpecText(spec: LoraSpec): string {
  return `${spec.name}:${spec.weight}`
}

// ── 结构健康报告 ──────────────────────────────────────────────────────────

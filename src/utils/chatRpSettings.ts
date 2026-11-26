import { profileLocalStorage as localStorage } from '../platform/web/profileStorage.ts'
import { CHAT_RP_SETTINGS_KEY } from './storageKeys.ts'

export interface ChatContextBudget {
  maxMessages: number
  maxChars: number
}

export interface ChatSamplingSettings {
  temperature?: number
  topP?: number
  maxTokens?: number
  frequencyPenalty?: number
  presencePenalty?: number
}

export interface ChatRpPreset {
  id: string
  name: string
  description?: string
  builtin?: boolean
  systemPrefix: string
  postHistory: string
  disableBubbleSplit: boolean
  sampling?: ChatSamplingSettings
}

export interface ChatAuthorNote {
  enabled: boolean
  text: string
  depth: number
}

export interface ChatRegexRule {
  id: string
  name: string
  enabled: boolean
  pattern: string
  replacement: string
  flags: string
  target: 'display' | 'both'
}

export interface ChatRpState {
  version: 1
  activePresetId: string
  customPresets: ChatRpPreset[]
  contextBudget: ChatContextBudget
  sampling: ChatSamplingSettings
  authorNotes: Record<string, ChatAuthorNote>
  regexRules: ChatRegexRule[]
  statusBarEnabled: boolean
  affectionPromptEnabled: boolean
}

export interface ContextBudgetTier {
  id: string
  label: string
  maxMessages: number
  maxChars: number
}

export const CONTEXT_BUDGET_TIERS: readonly ContextBudgetTier[] = [
  { id: 'light', label: '轻量 (24条 / 12K)', maxMessages: 24, maxChars: 12_000 },
  { id: 'standard', label: '标准 (48条 / 32K)', maxMessages: 48, maxChars: 32_000 },
  { id: 'long', label: '长剧情 (80条 / 64K)', maxMessages: 80, maxChars: 64_000 },
  { id: 'ultra', label: '超长 (120条 / 100K)', maxMessages: 120, maxChars: 100_000 },
]

export const BUILTIN_CHAT_RP_PRESETS: readonly ChatRpPreset[] = [
  {
    id: 'default',
    name: '默认（跟随角色卡）',
    description: '完整保留角色卡或本地人设的原汁原味设定与回复规矩',
    builtin: true,
    systemPrefix: '',
    postHistory: '',
    disableBubbleSplit: false,
  },
  {
    id: 'novel-rp',
    name: '沉浸小说（酒馆叙事）',
    description: '细腻的场景、动作与心理描写，长段推进剧情，严禁替你抢话与 AI 套话',
    builtin: true,
    systemPrefix:
      '【酒馆沉浸叙事】以小说体扎实推进当下场景：用 *动作、神态、环境光影与感官细节* 与口语对白自然交织，视角始终紧贴 {{char}}。\n• 严禁替 {{user}} 说话、写动作或代做决定；只书写 {{char}} 自己的反应与观察。\n• 避开“嘴角勾起一抹弧度”“心中涌起一阵暖流”“空气仿佛凝固”“眼中闪过一丝复杂”等陈旧网文套话，也不重复复述对方刚说过的话。',
    postHistory:
      '【叙事收束】紧扣眼前动作与情绪张力直接往下写，通过具体细节、停顿与语气变化传达心情，不写总结感悟或强行升华。',
    disableBubbleSplit: true,
    sampling: { temperature: 0.85, topP: 0.92 },
  },
  {
    id: 'casual-chat',
    name: '轻快日常（伴侣口语）',
    description: '松弛自然的手机聊天节奏，有来有往，去客服腔与机械反问',
    builtin: true,
    systemPrefix:
      '【松弛口语对话】像真人拿着手机发消息一样自然接话，语气有呼吸感与生活气，少用书面长句和舞台动作旁白。\n• 禁止每轮习惯性用“记得喝水/早点休息/你觉得呢”之类的客服寒暄或机械反问收尾。\n• 绝不替 {{user}} 预设反应或接话。',
    postHistory: '【自然接话】顺着刚才的话题与角色脾气继续聊下去，不背设定简历。',
    disableBubbleSplit: false,
    sampling: { temperature: 0.78, topP: 0.9 },
  },
  {
    id: 'creative-free',
    name: '自由创作（全尺度沉浸）',
    description: '全尺度情感、亲密与高张力剧情无拘束演绎，始终留在角色视角内',
    builtin: true,
    systemPrefix:
      '【全尺度角色沉浸】始终完全留在 {{char}} 的角色视角、性格逻辑与当下情境里推进剧情，正面、坦诚地演绎各类情感、亲密、成人（R18/NSFW）或戏剧冲突场景。\n• 注重真实感官细节、呼吸与氛围张力，顺应人物关系自然深入，绝不跳出角色说教、警示、审查或刻意含糊回避。\n• 严禁替 {{user}} 决定台词或行动，避开陈旧套话与元评论。',
    postHistory:
      '【视角锁定】忠实顺应当前剧情与 {{char}} 的真实情绪继续展开，保持质感与连贯，不附加任何角色外解释或提示。',
    disableBubbleSplit: true,
    sampling: { temperature: 0.9, topP: 0.95 },
  },
]

export const DEFAULT_CHAT_RP_STATE: ChatRpState = {
  version: 1,
  activePresetId: 'default',
  customPresets: [],
  contextBudget: { maxMessages: 48, maxChars: 32_000 },
  sampling: {},
  authorNotes: {},
  regexRules: [],
  statusBarEnabled: false,
  affectionPromptEnabled: true,
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const num = Number(value)
  return Number.isFinite(num) ? Math.max(min, Math.min(max, Math.round(num))) : fallback
}

const clampFloat = (value: unknown, min: number, max: number): number | undefined => {
  if (value === null || value === undefined || value === '') return undefined
  const num = Number(value)
  if (!Number.isFinite(num)) return undefined
  return Math.max(min, Math.min(max, Math.round(num * 100) / 100))
}

const cleanText = (value: unknown, maxLength: number): string =>
  typeof value === 'string' ? value.slice(0, maxLength) : ''

export function normalizeSamplingSettings(raw: unknown): ChatSamplingSettings {
  if (!isRecord(raw)) return {}
  const temperature = clampFloat(raw.temperature, 0, 2)
  const topP = clampFloat(raw.topP, 0, 1)
  const maxTokensRaw = raw.maxTokens === null || raw.maxTokens === undefined || raw.maxTokens === ''
    ? undefined
    : clampInt(raw.maxTokens, 64, 16384, 2048)
  const frequencyPenalty = clampFloat(raw.frequencyPenalty, -2, 2)
  const presencePenalty = clampFloat(raw.presencePenalty, -2, 2)
  return {
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { topP } : {}),
    ...(maxTokensRaw !== undefined ? { maxTokens: maxTokensRaw } : {}),
    ...(frequencyPenalty !== undefined ? { frequencyPenalty } : {}),
    ...(presencePenalty !== undefined ? { presencePenalty } : {}),
  }
}

export function normalizeRpPreset(raw: unknown, fallbackId?: string): ChatRpPreset | null {
  if (!isRecord(raw)) return null
  const name = cleanText(raw.name, 60).trim()
  if (!name) return null
  const id = cleanText(raw.id, 80).trim() || fallbackId || `preset-${crypto.randomUUID()}`
  const sampling = normalizeSamplingSettings(raw.sampling)
  return {
    id,
    name,
    ...(cleanText(raw.description, 160).trim() ? { description: cleanText(raw.description, 160).trim() } : {}),
    systemPrefix: cleanText(raw.systemPrefix, 4000),
    postHistory: cleanText(raw.postHistory, 4000),
    disableBubbleSplit: raw.disableBubbleSplit === true,
    ...(Object.keys(sampling).length ? { sampling } : {}),
  }
}

export function normalizeAuthorNote(raw: unknown): ChatAuthorNote {
  if (!isRecord(raw)) return { enabled: false, text: '', depth: 2 }
  return {
    enabled: raw.enabled === true,
    text: cleanText(raw.text, 2000),
    depth: clampInt(raw.depth, 0, 24, 2),
  }
}

export function validateChatRegexRule(pattern: string, flags: string): string | null {
  if (!pattern.trim()) return '正则表达式不能为空'
  if (pattern.length > 200) return '正则表达式不能超过 200 个字符'
  if (!/^[gimsuy]*$/.test(flags)) return '正则标志只允许 g / i / m / s / u / y'
  try {
    new RegExp(pattern, flags)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : '正则表达式语法无效'
  }
}

export function normalizeRegexRule(raw: unknown): ChatRegexRule | null {
  if (!isRecord(raw)) return null
  const pattern = cleanText(raw.pattern, 200)
  const flags = cleanText(raw.flags, 8).replace(/[^gimsuy]/g, '') || 'g'
  if (!pattern || validateChatRegexRule(pattern, flags)) return null
  return {
    id: cleanText(raw.id, 80).trim() || `rx-${crypto.randomUUID()}`,
    name: cleanText(raw.name, 60).trim() || '未命名规则',
    enabled: raw.enabled !== false,
    pattern,
    replacement: cleanText(raw.replacement, 500),
    flags,
    target: raw.target === 'both' ? 'both' : 'display',
  }
}

export function normalizeChatRpState(raw: unknown): ChatRpState {
  if (!isRecord(raw)) return structuredClone(DEFAULT_CHAT_RP_STATE)
  const budgetRaw = isRecord(raw.contextBudget) ? raw.contextBudget : {}
  const customPresets = Array.isArray(raw.customPresets)
    ? raw.customPresets
        .map(item => normalizeRpPreset(item))
        .filter((item): item is ChatRpPreset => Boolean(item))
        .filter(item => !BUILTIN_CHAT_RP_PRESETS.some(builtin => builtin.id === item.id))
        .slice(0, 40)
    : []
  const candidatePresetId = cleanText(raw.activePresetId, 80).trim()
  const validPreset =
    BUILTIN_CHAT_RP_PRESETS.some(p => p.id === candidatePresetId)
    || customPresets.some(p => p.id === candidatePresetId)
  const notesRaw = isRecord(raw.authorNotes) ? raw.authorNotes : {}
  const authorNotes: Record<string, ChatAuthorNote> = {}
  for (const [charId, note] of Object.entries(notesRaw)) {
    if (!charId || charId.length > 100) continue
    const normalized = normalizeAuthorNote(note)
    if (normalized.text.trim() || normalized.enabled) {
      authorNotes[charId] = normalized
    }
  }
  const regexRules = Array.isArray(raw.regexRules)
    ? raw.regexRules
        .map(normalizeRegexRule)
        .filter((rule): rule is ChatRegexRule => Boolean(rule))
        .slice(0, 40)
    : []
  return {
    version: 1,
    activePresetId: validPreset ? candidatePresetId : 'default',
    customPresets,
    contextBudget: {
      maxMessages: clampInt(budgetRaw.maxMessages, 8, 120, 48),
      maxChars: clampInt(budgetRaw.maxChars, 4000, 120_000, 32_000),
    },
    sampling: normalizeSamplingSettings(raw.sampling),
    authorNotes,
    regexRules,
    statusBarEnabled: raw.statusBarEnabled === true,
    affectionPromptEnabled: raw.affectionPromptEnabled !== false,
  }
}

export function loadChatRpState(): ChatRpState {
  try {
    const raw = localStorage.getItem(CHAT_RP_SETTINGS_KEY)
    return normalizeChatRpState(raw ? JSON.parse(raw) : null)
  } catch {
    return structuredClone(DEFAULT_CHAT_RP_STATE)
  }
}

export function saveChatRpState(state: ChatRpState): ChatRpState {
  const normalized = normalizeChatRpState(state)
  try {
    localStorage.setItem(CHAT_RP_SETTINGS_KEY, JSON.stringify(normalized))
  } catch {
    /* ignore storage quota failures */
  }
  return normalized
}

export function resolveActiveRpPreset(state: ChatRpState): ChatRpPreset {
  return (
    state.customPresets.find(p => p.id === state.activePresetId)
    || BUILTIN_CHAT_RP_PRESETS.find(p => p.id === state.activePresetId)
    || BUILTIN_CHAT_RP_PRESETS[0]
  )
}

export function resolveEffectiveSampling(state: ChatRpState): ChatSamplingSettings {
  const presetSampling = resolveActiveRpPreset(state).sampling || {}
  return {
    ...presetSampling,
    ...state.sampling,
  }
}

export function exportChatRpPresetJson(preset: ChatRpPreset): string {
  const { builtin: _builtin, ...clean } = preset
  return JSON.stringify({ format: 'huiyu-rp-preset-v1', preset: clean }, null, 2)
}

export function importChatRpPresetJson(rawText: string): ChatRpPreset {
  const parsed = JSON.parse(rawText) as unknown
  const payload = isRecord(parsed) && isRecord(parsed.preset) ? parsed.preset : parsed
  const normalized = normalizeRpPreset(payload, `preset-${crypto.randomUUID()}`)
  if (!normalized) throw new Error('无效的 RP 预设 JSON：缺少名称或格式错误')
  // Always assign a fresh non-builtin id when importing over a builtin id.
  if (BUILTIN_CHAT_RP_PRESETS.some(b => b.id === normalized.id)) {
    normalized.id = `preset-${crypto.randomUUID()}`
  }
  return normalized
}

export function applyChatDisplayRegex(text: string, rules?: readonly ChatRegexRule[]): string {
  if (!text || !rules?.length) return text
  let out = text
  for (const rule of rules) {
    if (!rule.enabled || !rule.pattern) continue
    try {
      const flags = rule.flags.includes('g') ? rule.flags : `${rule.flags}g`
      const regex = new RegExp(rule.pattern, flags)
      out = out.replace(regex, rule.replacement)
    } catch {
      /* skip invalid rule */
    }
  }
  return out
}

import { runtimeFetch } from '@/platform/runtimeUrl'
import { loadChatCharacterProfiles } from './chatCharacterProfiles'
import type { ChatCard } from './chatCards'

export interface CardV2LoreEntry {
  comment?: string
  name?: string
  keys: string[]
  secondary_keys?: string[]
  content: string
  enabled?: boolean
  constant?: boolean
  selective?: boolean
  case_sensitive?: boolean
  use_regex?: boolean
  whole_words?: boolean
  insertion_order?: number
  position?: string | number
  depth?: number
}

export interface CardV2Document {
  spec: 'chara_card_v2' | 'chara_card_v3'
  spec_version: string
  data: {
    name: string
    description: string
    personality: string
    scenario: string
    first_mes: string
    mes_example: string
    system_prompt: string
    post_history_instructions: string
    alternate_greetings: string[]
    tags?: string[]
    creator?: string
    character_book?: {
      name?: string
      scan_depth?: number
      token_budget?: number
      recursive_scanning?: boolean
      entries: CardV2LoreEntry[]
    }
    extensions: {
      depth_prompt?: { prompt: string; depth: number }
      huiyu?: {
        character_id?: string
        voice_id?: string
        [key: string]: unknown
      }
      [key: string]: unknown
    }
    [key: string]: unknown
  }
}

export interface ChatCardDetail {
  id: string
  source: 'user' | 'catalog'
  overridden: boolean
  summary: ChatCard
  document: CardV2Document
}

export interface VoiceOption {
  id: string
  label: string
}

export interface CatalogCharacterOption {
  id: string
  name: string
  franchise?: string
}

export function createEmptyCardDocument(): CardV2Document {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '',
      description: '',
      personality: '',
      scenario: '',
      first_mes: '',
      mes_example: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: [],
      extensions: {
        depth_prompt: { prompt: '', depth: 1 },
        huiyu: {},
      },
    },
  }
}

async function readApiError(response: Response, fallback: string): Promise<string> {
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null
  const msg = typeof payload?.msg === 'string' && payload.msg
    ? payload.msg
    : typeof payload?.message === 'string' && payload.message
      ? payload.message
      : typeof payload?.error === 'string' && payload.error
        ? payload.error
        : ''
  return msg || `${fallback}（HTTP ${response.status}）`
}

export async function listChatCardSummaries(signal?: AbortSignal): Promise<ChatCard[]> {
  const response = await runtimeFetch('/api/chat/cards', { cache: 'no-store', signal })
  if (!response.ok) throw new Error(await readApiError(response, '读取角色卡列表失败'))
  const data = await response.json() as { cards?: ChatCard[] }
  return Array.isArray(data.cards) ? data.cards : []
}

export async function fetchChatCardDetail(id: string, signal?: AbortSignal): Promise<ChatCardDetail> {
  const response = await runtimeFetch(`/api/chat/cards/${encodeURIComponent(id)}`, {
    cache: 'no-store',
    signal,
  })
  if (!response.ok) throw new Error(await readApiError(response, '读取角色卡详情失败'))
  return await response.json() as ChatCardDetail
}

function buildMutationBody(
  document: CardV2Document,
  options?: { avatarFile?: File | null; removeAvatar?: boolean },
): { body: BodyInit; headers?: HeadersInit } {
  if (options?.avatarFile) {
    const form = new FormData()
    form.append('card', JSON.stringify(document))
    form.append('avatar', options.avatarFile)
    if (options.removeAvatar) form.append('removeAvatar', 'true')
    return { body: form }
  }
  return {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ document, removeAvatar: Boolean(options?.removeAvatar) }),
  }
}

export async function createChatCard(
  document: CardV2Document,
  avatarFile?: File | null,
  signal?: AbortSignal,
): Promise<ChatCard> {
  const request = buildMutationBody(document, { avatarFile })
  const response = await runtimeFetch('/api/chat/cards/create', {
    method: 'POST',
    ...request,
    signal,
  })
  if (!response.ok) throw new Error(await readApiError(response, '创建角色卡失败'))
  const data = await response.json() as { card: ChatCard }
  return data.card
}

export async function updateChatCard(
  id: string,
  document: CardV2Document,
  options?: { avatarFile?: File | null; removeAvatar?: boolean; signal?: AbortSignal },
): Promise<ChatCard> {
  const request = buildMutationBody(document, options)
  const response = await runtimeFetch(`/api/chat/cards/${encodeURIComponent(id)}`, {
    method: 'PUT',
    ...request,
    signal: options?.signal,
  })
  if (!response.ok) throw new Error(await readApiError(response, '保存角色卡失败'))
  const data = await response.json() as { card: ChatCard }
  return data.card
}

export async function deleteChatCard(
  id: string,
  signal?: AbortSignal,
): Promise<{ restoredCatalog: boolean }> {
  const response = await runtimeFetch(`/api/chat/cards/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    signal,
  })
  if (!response.ok) throw new Error(await readApiError(response, '删除角色卡失败'))
  const data = await response.json() as { restoredCatalog?: boolean }
  return { restoredCatalog: Boolean(data.restoredCatalog) }
}

export function chatCardExportUrl(id: string, format: 'json' | 'png'): string {
  return `/api/chat/cards/${encodeURIComponent(id)}/export?format=${format}`
}

export async function fetchVoiceOptions(signal?: AbortSignal): Promise<VoiceOption[]> {
  const defaults = new Map<string, string>([
    ['nene', '绫地宁宁（内置）'],
    ['natsume', '四季夏目（内置）'],
    ['roxy', '洛琪希'],
  ])
  try {
    const response = await runtimeFetch('/api/tts-status?scope=room', { cache: 'no-store', signal })
    if (response.ok) {
      const data = await response.json() as {
        voices?: Record<string, boolean>
        voiceLabels?: Record<string, string>
      }
      if (data.voiceLabels && typeof data.voiceLabels === 'object') {
        for (const [id, label] of Object.entries(data.voiceLabels)) {
          if (typeof label === 'string' && label.trim()) defaults.set(id, label.trim())
        }
      }
      if (data.voices && typeof data.voices === 'object') {
        for (const id of Object.keys(data.voices)) {
          if (!defaults.has(id)) defaults.set(id, id)
        }
      }
    }
  } catch { /* Fallback to known built-in voice IDs. */ }
  return Array.from(defaults.entries()).map(([id, label]) => ({ id, label }))
}

export async function fetchCatalogCharacterOptions(signal?: AbortSignal): Promise<CatalogCharacterOption[]> {
  try {
    const response = await runtimeFetch('/data/character-chat-directory.json', { signal })
    if (response.ok) {
      const rows = await response.json() as Array<Record<string, unknown>>
      if (Array.isArray(rows) && rows.length) {
        return rows
          .filter(row => typeof row?.id === 'string' && typeof row?.name === 'string')
          .map(row => ({
            id: String(row.id),
            name: String(row.name),
            franchise: typeof row.franchise === 'string' ? row.franchise : undefined,
          }))
      }
    }
  } catch { /* Fall back to bundled character profiles. */ }
  const bundled = await loadChatCharacterProfiles()
  return bundled
    .filter((item): item is typeof item & { id: string; name: string } => typeof item?.id === 'string' && typeof item?.name === 'string')
    .map(item => ({
      id: item.id,
      name: item.name,
      franchise: typeof item.franchise === 'string' ? item.franchise : undefined,
    }))
}

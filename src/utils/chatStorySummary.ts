import { profileLocalStorage as localStorage } from '@/platform/web/profileStorage'
import { runtimeFetch } from '@/platform/runtimeUrl'
import type { ChatMessage, ChatProvider } from '@/composables/chat/chatStorageTypes'
import { CHAT_STORY_SUMMARY_KEY } from './storageKeys'

export interface StorySummaryEntry {
  text: string
  summarizedThroughMid: string
  autoEnabled: boolean
  updatedAt: number
}

interface StorySummaryStore {
  version: 1
  byKey: Record<string, StorySummaryEntry>
}

function keyOf(characterId: string, branchId: string): string {
  return `${characterId}::${branchId || 'main'}`
}

function loadStore(): StorySummaryStore {
  try {
    const raw = JSON.parse(localStorage.getItem(CHAT_STORY_SUMMARY_KEY) || 'null') as Record<string, unknown> | null
    if (!raw || typeof raw !== 'object' || !raw.byKey || typeof raw.byKey !== 'object' || Array.isArray(raw.byKey)) {
      return { version: 1, byKey: {} }
    }
    const byKey: Record<string, StorySummaryEntry> = {}
    for (const [key, val] of Object.entries(raw.byKey as Record<string, unknown>)) {
      if (!val || typeof val !== 'object' || Array.isArray(val)) continue
      const row = val as Record<string, unknown>
      byKey[key] = {
        text: typeof row.text === 'string' ? row.text.slice(0, 3000) : '',
        summarizedThroughMid: typeof row.summarizedThroughMid === 'string' ? row.summarizedThroughMid.slice(0, 160) : '',
        autoEnabled: row.autoEnabled === true,
        updatedAt: Number.isFinite(Number(row.updatedAt)) ? Number(row.updatedAt) : 0,
      }
    }
    return { version: 1, byKey }
  } catch {
    return { version: 1, byKey: {} }
  }
}

function writeStore(store: StorySummaryStore): void {
  localStorage.setItem(CHAT_STORY_SUMMARY_KEY, JSON.stringify(store))
}

export function getStorySummary(characterId: string, branchId: string): StorySummaryEntry {
  const store = loadStore()
  return store.byKey[keyOf(characterId, branchId)] || {
    text: '',
    summarizedThroughMid: '',
    autoEnabled: false,
    updatedAt: 0,
  }
}

export function saveStorySummary(
  characterId: string,
  branchId: string,
  patch: Partial<StorySummaryEntry>,
): StorySummaryEntry {
  const store = loadStore()
  const key = keyOf(characterId, branchId)
  const prev = store.byKey[key] || {
    text: '',
    summarizedThroughMid: '',
    autoEnabled: false,
    updatedAt: 0,
  }
  const next: StorySummaryEntry = {
    text: (patch.text !== undefined ? patch.text : prev.text).trim().slice(0, 3000),
    summarizedThroughMid: patch.summarizedThroughMid !== undefined ? patch.summarizedThroughMid : prev.summarizedThroughMid,
    autoEnabled: patch.autoEnabled !== undefined ? patch.autoEnabled : prev.autoEnabled,
    updatedAt: patch.updatedAt !== undefined ? patch.updatedAt : Date.now(),
  }
  store.byKey[key] = next
  writeStore(store)
  return next
}

export function clearStorySummary(characterId: string, branchId: string): void {
  saveStorySummary(characterId, branchId, {
    text: '',
    summarizedThroughMid: '',
    updatedAt: 0,
  })
}

export async function requestStorySummary(params: {
  provider: ChatProvider
  model?: string
  hostConfig?: boolean
  api?: { baseUrl: string; model: string; apiKey: string }
  chatgptClientId?: string
  characterName: string
  userName?: string
  existingSummary?: string
  messages: ReadonlyArray<Pick<ChatMessage, 'role' | 'content'>>
  signal?: AbortSignal
}): Promise<string> {
  if (params.provider === 'muse') {
    throw new Error('Muse 通道暂不支持自动摘要，请切换至本地模型、自定义 API 或 ChatGPT。')
  }
  const cleanMessages = params.messages
    .filter(m => m.content && m.content.trim())
    .slice(-60)
    .map(m => ({ role: m.role, content: m.content.slice(0, 1000) }))
  if (!cleanMessages.length) {
    throw new Error('当前对话尚无足够的文字消息可生成摘要。')
  }
  const response = await runtimeFetch('/api/chat/summarize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: params.provider,
      model: params.model || '',
      hostConfig: params.hostConfig || undefined,
      api: params.api,
      chatgptClientId: params.chatgptClientId || undefined,
      characterName: params.characterName,
      userName: params.userName || '用户',
      existingSummary: params.existingSummary || '',
      messages: cleanMessages,
    }),
    signal: params.signal,
  })
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null
  if (!response.ok || payload?.ok !== true || typeof payload.summary !== 'string') {
    const msg = typeof payload?.msg === 'string' && payload.msg
      ? payload.msg
      : typeof payload?.error === 'string' && payload.error
        ? payload.error
        : `摘要生成失败（HTTP ${response.status}）`
    throw new Error(msg)
  }
  return payload.summary.trim().slice(0, 3000)
}

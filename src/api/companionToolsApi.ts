import { runtimeFetch } from '@/platform/runtimeUrl'
import type { CompanionChatImage } from '@/types/companionDrawing'
import type { ChatSearchConnection } from '@/config/chatSearch'

export interface CompanionToolResult {
  ok: boolean
  output: string
  imageDataUrl?: string
  image?: CompanionChatImage
}

export async function executeCompanionTool(name: string, args: Record<string, unknown>, signal?: AbortSignal, search?: Pick<ChatSearchConnection, 'hostConfig' | 'chatApi'>): Promise<CompanionToolResult> {
  const selected = name === 'search_web' ? await (await import('@/utils/chatSearchStorage')).loadChatSearchSettings('search') : undefined
  signal?.throwIfAborted()
  const response = await runtimeFetch(name === 'search_web' ? '/api/chat/search' : '/api/desktop-tools', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ name, args, ...(selected ? { search: { provider: selected.provider, apiKey: selected.apiKey, ...search } } : {}) }),
  })
  const raw: unknown = await response.json()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('本机工具返回了无效响应。')
  const value = raw as Record<string, unknown>
  if (typeof value.ok !== 'boolean') throw new Error('本机工具返回了无效响应。')
  return {
    ok: response.ok && value.ok,
    output: typeof value.output === 'string' ? value.output : typeof value.error === 'string' ? value.error : '本机工具未返回详情。',
    ...(typeof value.imageDataUrl === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(value.imageDataUrl) ? { imageDataUrl: value.imageDataUrl } : {}),
  }
}

import { runtimeFetch } from '@/platform/runtimeUrl'
import type { CompanionChatImage } from '@/types/companionDrawing'
import type { ChatSearchConnection } from '@/config/chatSearch'
import { loadCompanionToolPermissions, companionToolAllowed } from '@/composables/chat/useCompanionToolPermissions'
import { confirmAction } from '@/composables/useConfirm'

export interface CompanionToolResult {
  ok: boolean
  output: string
  imageDataUrl?: string
  image?: CompanionChatImage
}

export async function executeCompanionTool(name: string, args: Record<string, unknown>, signal?: AbortSignal, search?: Pick<ChatSearchConnection, 'hostConfig' | 'chatApi'>, screenDestination?: string): Promise<CompanionToolResult> {
  if (name !== 'search_web' && !companionToolAllowed(name, await loadCompanionToolPermissions(signal))) throw new Error('此项房间工具权限已关闭。')
  let screenAuthorized = false
  if (name === 'capture_screen') {
    if (!screenDestination) throw new Error('无法确认截图将发送到哪个 API，已停止截图。')
    screenAuthorized = await confirmAction({ title: '允许本次截图并发送？', message: `将截取当前屏幕，并把截图发送给 ${screenDestination}。可能包含屏幕上的私人内容；授权仅适用于本次调用。`,
      confirmLabel: '截图并发送', cancelLabel: '拒绝', danger: false, signal })
    if (!screenAuthorized) return { ok: false, output: '用户拒绝本次截图与外发；不要重复请求。' }
    if (!companionToolAllowed(name, await loadCompanionToolPermissions(signal))) throw new Error('屏幕截图权限已关闭。')
  }
  const selected = name === 'search_web' ? await (await import('@/utils/chatSearchStorage')).loadChatSearchSettings('search') : undefined
  signal?.throwIfAborted()
  const response = await runtimeFetch(name === 'search_web' ? '/api/chat/search' : '/api/desktop-tools', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ name, args, ...(screenAuthorized ? { screenAuthorized: true } : {}), ...(selected ? { search: { provider: selected.provider, apiKey: selected.apiKey, ...search } } : {}) }),
  })
  const raw: unknown = await response.json()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('本机工具返回了无效响应。')
  const value = raw as Record<string, unknown>
  if (typeof value.ok !== 'boolean') throw new Error('本机工具返回了无效响应。')
  if (name !== 'search_web' && !companionToolAllowed(name, await loadCompanionToolPermissions(signal))) throw new Error('工具权限已关闭，返回内容不会继续发送给 API。')
  return {
    ok: response.ok && value.ok,
    output: typeof value.output === 'string' ? value.output : typeof value.error === 'string' ? value.error : '本机工具未返回详情。',
    ...(typeof value.imageDataUrl === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(value.imageDataUrl) ? { imageDataUrl: value.imageDataUrl } : {}),
  }
}

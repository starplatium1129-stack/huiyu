import { runtimeFetch } from '@/platform/runtimeUrl'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'
import { parseCompanionDrawingDraft, type CompanionDrawingDraft } from '@/types/companionDrawing'

export interface CompanionToolResult {
  ok: boolean
  output: string
  imageDataUrl?: string
  draft?: CompanionDrawingDraft
}

export async function executeCompanionTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CompanionToolResult> {
  const response = await runtimeFetch('/api/desktop-tools', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ name, args, adultEnabled: isLocalStudioHost() }),
  })
  const raw: unknown = await response.json()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('本机工具返回了无效响应。')
  const value = raw as Record<string, unknown>
  if (typeof value.ok !== 'boolean') throw new Error('本机工具返回了无效响应。')
  const draft = value.ok && name === 'generate_character_image' ? parseCompanionDrawingDraft(value.draft) : null
  return {
    ok: response.ok && value.ok,
    output: typeof value.output === 'string' ? value.output : typeof value.error === 'string' ? value.error : '本机工具未返回详情。',
    ...(typeof value.imageDataUrl === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(value.imageDataUrl) ? { imageDataUrl: value.imageDataUrl } : {}),
    ...(draft ? { draft } : {}),
  }
}

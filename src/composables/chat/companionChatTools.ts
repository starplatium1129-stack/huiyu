import { executeCompanionTool, type CompanionToolResult } from '@/api/companionToolsApi'
import type { captureCompanionImageSource } from './companionChatImages'
import type { ArtworkRepository } from '@/storage/artworkRepository'
import type { CompanionChatImage } from '@/types/companionDrawing'
import type { MediaSource } from '@/platform/desktop/workspaceMediaSource'
import { readWorkspaceMediaSource } from '@/platform/desktop/workspaceMediaRead'
import type { ChatSearchConnection } from '@/config/chatSearch'
import { flushProfileWrites } from '@/platform/web/profileStorage'
import { chatResetRevision } from '@/utils/chatReset'
import { loadCompanionToolPermissions, companionToolAllowed } from './useCompanionToolPermissions'

/** Loaded only when a tool reads the reference already selected by its turn. */
export async function readCompanionImage(image: CompanionChatImage, repository: ArtworkRepository, authority: string | undefined,
  signal: AbortSignal, check: (signal: AbortSignal) => void): Promise<string | Readonly<MediaSource>> {
  check(signal)
  if (image.imageId && repository.getWorkspaceMediaReference) {
    const reference = repository.getWorkspaceMediaReference(image.imageId)
    const source = await readWorkspaceMediaSource(reference.alias, authority ?? reference.authority, signal)
    check(signal)
    return source
  }
  let blob: Blob | null
  if (image.imageId || !image.path.startsWith('/')) blob = await repository.getImage(image.imageId || image.path, signal)
  else {
    const { fetchRuntimeResult } = await import('@/api/runtimeTasks')
    check(signal)
    blob = await fetchRuntimeResult(image.path, signal)
  }
  check(signal)
  if (!blob || !blob.size || !/^image\/(png|jpeg|webp|gif)$/.test(blob.type)) throw new Error('原图暂时无法读取，请重新选择图片。')
  if (blob.size > 20 * 1024 * 1024) throw new Error('图片超过 20 MB，请缩小后重试。')
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    const cleanup = () => signal.removeEventListener('abort', abort)
    const abort = () => { cleanup(); reader.abort(); reject(signal.reason || new DOMException('已取消', 'AbortError')) }
    reader.onload = () => { cleanup(); try { check(signal); resolve(String(reader.result || '')) } catch (error) { reject(error) } }
    reader.onerror = () => { cleanup(); reject(new Error('读取图片失败。')) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { abort(); return }
    reader.readAsDataURL(blob)
  })
}

/** Both image consumers hand off only after their chat message is durable. */
export async function retainCompanionImageMessage(storage: { save(): boolean | undefined }, taskId?: string) {
  const reset = chatResetRevision()
  const checkReset = () => {
    if (reset !== chatResetRevision()) throw new DOMException('聊天内容已清空，原图片请求身份已保留', 'AbortError')
  }
  if (!storage.save()) throw new Error('图片对话尚未保存，原请求身份已保留')
  await flushProfileWrites()
  // A reset can retire the queued chat write without rejecting its flush.
  checkReset()
  if (taskId) {
    const { acknowledgeCompanionImage } = await import('./companionImageGeneration')
    checkReset()
    await acknowledgeCompanionImage(taskId)
  }
}

export interface CompanionToolContext {
  character: string
  signal: AbortSignal
  report: (message: string) => void
  readImage?: NonNullable<ReturnType<typeof captureCompanionImageSource>>['read']
  imageUrl?: string
  search?: Pick<ChatSearchConnection, 'hostConfig' | 'chatApi'>
  screenDestination?: string
}

export async function executeSerializedCompanionChatTool(call: { name: string; arguments: string }, context: CompanionToolContext, completedDrawings?: Map<string, CompanionToolResult>): Promise<CompanionToolResult> {
  context.signal.throwIfAborted()
  let args: unknown
  try { args = JSON.parse(call.arguments || '{}') }
  catch { return { ok: false, output: '工具参数不是有效 JSON，请修正后重试。' } }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { ok: false, output: '工具参数必须是 JSON 对象。' }
  return executeCompanionChatTool(call.name, args as Record<string, unknown>, context, completedDrawings)
}

export async function executeCompanionChatTool(name: string, args: Record<string, unknown>, context: CompanionToolContext, completedDrawings?: Map<string, CompanionToolResult>): Promise<CompanionToolResult> {
  context.signal.throwIfAborted()
  if (name !== 'search_web' && !companionToolAllowed(name, await loadCompanionToolPermissions(context.signal))) throw new Error('房间工具权限已关闭。')
  if (!['generate_character_image', 'generate_image_from_reference'].includes(name)) {
    return executeCompanionTool(name, args, context.signal, name === 'search_web' ? context.search : undefined, context.screenDestination)
  }
  const reference = name === 'generate_image_from_reference'
  const input = {
    character: typeof args.character === 'string' ? args.character.trim() : context.character,
    description: typeof args.description === 'string' ? args.description.trim() : reference ? '根据参考图生成新图' : '',
    visualDescription: typeof args.visualDescription === 'string' ? args.visualDescription.trim() : '',
    outfit: typeof args.outfit === 'string' ? args.outfit.trim() : 'default',
    mature: args.mature === true,
  }
  const key = `${name}:${JSON.stringify(input)}`
  const completed = completedDrawings?.get(key)
  if (completed) return completed
  const referenceImage = reference
    ? async () => {
      if (!context.readImage && !context.imageUrl) throw new Error('请先发送一张图片，再让我反推并生成。')
      context.report('正在读取参考图…')
      return context.readImage ? await context.readImage() : context.imageUrl
    }
    : undefined
  const { generateCompanionImage } = await import('./companionImageGeneration')
  context.signal.throwIfAborted()
  const result = await generateCompanionImage(input, { character: context.character, signal: context.signal, report: context.report, referenceImage })
  context.signal.throwIfAborted()
  const receipt: CompanionToolResult = { ok: true, output: result.output, image: {
    path: result.resultPath, name: result.description.slice(0, 240) || '生成图片', taskId: result.taskId,
    ...(result.imageId ? { imageId: result.imageId } : {}), ...(result.artworkId ? { artworkId: result.artworkId } : {}),
  } }
  completedDrawings?.set(key, receipt)
  return receipt
}

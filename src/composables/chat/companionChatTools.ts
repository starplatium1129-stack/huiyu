import { executeCompanionTool, type CompanionToolResult } from '@/api/companionToolsApi'
import type { CompanionChatImage } from '@/types/companionDrawing'
import { companionImageSource } from './companionChatImages'

export interface CompanionToolContext {
  character: string
  signal: AbortSignal
  report: (message: string) => void
  image?: CompanionChatImage
  imageUrl?: string
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
  if (!['generate_character_image', 'generate_image_from_reference'].includes(name)) {
    return executeCompanionTool(name, args, context.signal)
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
  if (reference && !context.image && !context.imageUrl) throw new Error('请先发送一张图片，再让我反推并生成。')
  if (reference) context.report('正在读取参考图…')
  const referenceImage = reference
    ? context.image ? await companionImageSource(context.image, context.signal) : context.imageUrl
    : undefined
  const { generateCompanionImage } = await import('./companionImageGeneration')
  context.signal.throwIfAborted()
  const result = await generateCompanionImage(input, { signal: context.signal, report: context.report, referenceImage })
  context.signal.throwIfAborted()
  const receipt: CompanionToolResult = { ok: true, output: result.output, image: {
    path: result.resultPath, name: result.description.slice(0, 240) || '生成图片', taskId: result.taskId,
    ...(result.imageId ? { imageId: result.imageId } : {}), ...(result.artworkId ? { artworkId: result.artworkId } : {}),
  } }
  completedDrawings?.set(key, receipt)
  return receipt
}

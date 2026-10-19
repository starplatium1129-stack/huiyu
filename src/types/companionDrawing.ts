export interface CompanionDrawingDraft {
  path: string
  character: string
  description: string
}

/** Originals live in the media repository; messages only retain references. */
export interface CompanionChatImage {
  path: string
  name: string
  imageId?: string
  taskId?: string
  artworkId?: string
}

export interface CompanionChatSendOptions {
  image?: CompanionChatImage
  /** Current relay admission only; never persisted with message references. */
  imageAuthority?: string
  action?: 'generate-from-image'
}

export type ChatStoryAction =
  | { kind: 'regenerate' | 'fork'; messageId: string }
  | { kind: 'select-variant'; messageId: string; variantId: string }
  | { kind: 'switch-branch'; branchId: string }

export interface CompanionChatCommand extends CompanionChatSendOptions {
  command: 'send' | 'stop' | 'switch-character' | 'story-action'
  text?: string
  imageUrl?: string
  character?: string
  requestId?: string
  branchId?: string
  storyAction?: ChatStoryAction
}

const mediaAlias = /^(?:image-|img_|task-)[\w-]{1,160}$/
const resultPath = /^\/api\/tasks\/v1\/[\w-]{1,160}\/results\/\d+$/

export function parseCompanionChatImage(value: unknown): CompanionChatImage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  const imageId = typeof item.imageId === 'string' && mediaAlias.test(item.imageId) ? item.imageId : undefined
  const path = typeof item.path === 'string' && resultPath.test(item.path) ? item.path : imageId || item.path
  if (typeof path !== 'string' || !(mediaAlias.test(path) || resultPath.test(path))
    || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 240) return null
  const taskId = typeof item.taskId === 'string' && /^[\w-]{1,160}$/.test(item.taskId) ? item.taskId : undefined
  const artworkId = typeof item.artworkId === 'string' && item.artworkId.length <= 160 ? item.artworkId : undefined
  return { path, name: item.name.trim(), ...(imageId ? { imageId } : {}),
    ...(taskId ? { taskId } : {}), ...(artworkId ? { artworkId } : {}) }
}

export function parseCompanionChatImages(value: unknown): CompanionChatImage[] {
  return Array.isArray(value) ? value.map(parseCompanionChatImage)
    .filter((image): image is CompanionChatImage => Boolean(image)).slice(-4) : []
}

export function isCompanionDrawingPath(value: unknown): value is string {
  return typeof value === 'string' && /^generated-images\/companion_[\w%!'()*~-]{1,100}_\d{10,17}\.json$/.test(value)
}

/** Persist references, never raw model output or executable paths. */
export function parseCompanionDrawingDraft(value: unknown): CompanionDrawingDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  if (!isCompanionDrawingPath(item.path)
    || typeof item.character !== 'string' || !item.character.trim() || item.character.length > 80
    || typeof item.description !== 'string' || !item.description.trim() || item.description.length > 1200) return null
  return { path: item.path, character: item.character, description: item.description }
}

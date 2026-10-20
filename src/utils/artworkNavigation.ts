import type { ArtworkRecord } from '@/types/artwork'

export function artworkContinueTarget(item: ArtworkRecord, mode: 'regen' | 'remix' = 'regen') {
  if (item.engine === 'qwen-image') {
    if (typeof item.taskId === 'string' && item.taskId.trim())
      return { to: `/qwen-studio?job=${encodeURIComponent(item.taskId)}`, label: '查看 Qwen 原任务' }
    if (item.image_id) return { to: `/qwen-studio?artwork=${encodeURIComponent(item.id)}`, label: '用 Qwen 编辑' }
  } else if (!item.engine || ['sd', 'anima', 'krea2'].includes(item.engine)) {
    return { to: `/prompt-builder?${mode}=${encodeURIComponent(item.id)}`, label: mode === 'remix' ? '沿用配方' : '继续创作' }
  }
  const title = String(item.sceneTitle || item.title || item.scene || '')
  return { to: `/gallery?q=${encodeURIComponent(title)}&fromArtwork=${encodeURIComponent(item.id)}`, label: '在作品册查看' }
}

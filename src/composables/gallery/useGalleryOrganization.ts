import { onScopeDispose, ref, shallowRef } from 'vue'
import { artworkRepository } from '@/storage/artworkRepository'
import type { ArtworkProjectRecord } from '@/application/artwork/artworkRepository'
import { normalizeNewArtworkProject, type ArtworkProjectDraft } from '@/application/artwork/projects'
import { ARTWORK_ORGANIZATION_BATCH_SIZE, ARTWORK_ORGANIZATION_SELECTION_LIMIT, collectionTags, type ArtworkOrganizationId,
  type ArtworkOrganizationRequest, type ArtworkOrganizationReceipt } from '@/application/artwork/organization'

export function useGalleryOrganization(options: {
  ids: () => ArtworkOrganizationId[]
  changed: () => void
}) {
  const busy = ref(false), stopping = ref(false), message = ref(''), error = ref('')
  const receipts = shallowRef<ArtworkOrganizationReceipt[]>([])
  const canUndo = ref(false)
  const pendingProject = shallowRef<ArtworkProjectDraft | null>(null)
  const createdProject = shallowRef<ArtworkProjectRecord | null>(null)
  const tagsFromInput = (text: string) => collectionTags(text.split(/[,，;；\n]/))
  onScopeDispose(() => { stopping.value = true })
  async function apply(input: Omit<ArtworkOrganizationRequest, 'ids'>, newProjectTitle?: string) {
    if (busy.value) return
    const ids = options.ids().slice()
    if (!ids.length) return
    if (ids.length > ARTWORK_ORGANIZATION_SELECTION_LIMIT) { error.value = `一次最多整理 ${ARTWORK_ORGANIZATION_SELECTION_LIMIT.toLocaleString('zh-CN')} 幅作品，请分批选择以保留完整撤销记录`; return }
    busy.value = true; stopping.value = false; error.value = ''; message.value = ''
    let handled = 0
    try {
      const organizationInput = structuredClone(input)
      if (newProjectTitle !== undefined) {
        const draft = pendingProject.value ?? normalizeNewArtworkProject({ id: `album-${crypto.randomUUID()}`, title: newProjectTitle })
        pendingProject.value = { id: draft.id, title: draft.title }
        message.value = '正在新建画册…'
        const project = await artworkRepository.createProject(pendingProject.value)
        createdProject.value = project
        pendingProject.value = null
        organizationInput.projectId = project.id
      }
      for (let start = 0; start < ids.length && !stopping.value; start += ARTWORK_ORGANIZATION_BATCH_SIZE) {
        const receipt = await artworkRepository.organizeArtworks({ ...organizationInput, ids: ids.slice(start, start + ARTWORK_ORGANIZATION_BATCH_SIZE) })
        if (receipt.changes.length) {
          // Only confirmed changes replace the previous action's undo authority.
          receipts.value = [...(handled ? receipts.value : []), receipt]
          handled += receipt.changes.length
          canUndo.value = true
        }
        message.value = `已整理 ${handled} 幅作品`
      }
      message.value = stopping.value ? `已停止后续整理；已完成 ${handled} 幅，可撤销` : handled ? `已整理 ${handled} 幅作品，可撤销本次整理` : '所选作品已使用这些画册与标签'
    } catch (failure) {
      if (!handled) message.value = ''
      error.value = `${failure instanceof Error ? failure.message : '作品整理未确认'}${pendingProject.value ? '；请重试本次创建' : handled ? `；已完成 ${handled} 幅，可先撤销` : ''}`
    } finally { busy.value = false; options.changed() }
  }
  async function undo() {
    if (busy.value || !canUndo.value) return
    busy.value = true; error.value = ''; message.value = ''
    let restored = 0, skipped = 0
    const remaining = [...receipts.value]
    try {
      while (remaining.length) {
        const result = await artworkRepository.undoArtworkOrganization(remaining.at(-1)!)
        restored += result.restored; skipped += result.skipped
        remaining.pop(); receipts.value = [...remaining]
      }
      canUndo.value = false
      message.value = `已撤销 ${restored} 幅作品的整理${skipped ? `；${skipped} 幅已有新修改或已移出作品册，保持现状` : ''}`
    } catch (failure) { error.value = failure instanceof Error ? failure.message : '撤销尚未确认，可重试本次撤销' }
    finally { busy.value = false; options.changed() }
  }
  return { busy, stopping, message, error, canUndo, pendingProject, createdProject, apply, undo, tagsFromInput, stop: () => { stopping.value = true } }
}

import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { SceneDraft, CurationData } from '@/types/api'
import { useSceneEditorModal } from './useSceneEditorModal'
vi.mock('@/composables/useConfirm', () => ({ confirmAction: vi.fn(async () => true) }))
vi.mock('@/composables/useCopyFeedback', () => ({ copyWithFeedback: vi.fn() }))

function setup(nextSceneId = vi.fn(async (): Promise<string | null> => 'sc002')) {
  const scenes = ref([{ id: 'sc001', title: 'original', story: 'story' }] as SceneDraft[])
  const editor = useSceneEditorModal({ scenes, curation: ref<CurationData>({}), markDirty: vi.fn(), nextSceneId })
  return { scenes, editor }
}

describe('scene draft ID allocation', () => {
  it('keeps consecutive and concurrent duplicates unique before saving to the server', async () => {
    const { scenes, editor } = setup()
    await Promise.all([editor.duplicateScene('sc001'), editor.duplicateScene('sc001')])
    await editor.duplicateScene('sc001')
    expect(scenes.value.map(scene => scene.id)).toEqual(['sc001', 'sc002', 'sc003', 'sc004'])
  })
  it('does not reuse a draft ID when adding again before project save', async () => {
    const { editor } = setup()
    await editor.openAddModal()
    editor.editing.value!.title = 'new'
    editor.editing.value!.story = 'story'
    editor.saveScene()
    await editor.openAddModal()
    expect(editor.editing.value!.id).toBe('sc003')
  })
  it('does not invent an ID when state is unavailable or capacity is exhausted', async () => {
    const unavailable = setup(vi.fn(async () => { throw new Error('offline') }))
    await unavailable.editor.duplicateScene('sc001')
    expect(unavailable.scenes.value).toHaveLength(1)
    const exhausted = setup(vi.fn(async () => null))
    await exhausted.editor.openAddModal()
    expect(exhausted.editor.editing.value).toBeNull()
  })
  it('crosses sc999 and preserves the complete expanded ID in the editor', async () => {
    const { scenes, editor } = setup(vi.fn(async () => 'sc999'))
    await editor.duplicateScene('sc001')
    await editor.duplicateScene('sc001')
    expect(scenes.value.map(s => s.id)).toEqual(['sc001', 'sc999', 'sc1000'])
    expect(editor.editing.value!.id).toBe('sc1000')
  })
  it('uses the last safe ID once and reports exhaustion on another allocation', async () => {
    const { scenes, editor } = setup(vi.fn(async () => 'sc9007199254740991'))
    await editor.duplicateScene('sc001')
    await editor.duplicateScene('sc001')
    expect(scenes.value).toHaveLength(2)
    expect(editor.formHint.value).toContain('上限')
  })
  it.each(['sc000', 'sc0001', 'sc9007199254740992'])('rejects manually entered noncanonical %s', async id => {
    const { scenes, editor } = setup()
    await editor.openAddModal()
    editor.editing.value!.id = id
    editor.editing.value!.title = 'fixture'
    editor.editing.value!.story = 'fixture'
    editor.saveScene()
    expect(scenes.value).toHaveLength(1)
    expect(editor.formHint.value).toContain('安全整数')
  })
})

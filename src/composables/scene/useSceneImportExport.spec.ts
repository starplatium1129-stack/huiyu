import { ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSceneImportExport } from './useSceneImportExport'
import { confirmAction } from '@/composables/useConfirm'
import { downloadBlob } from '@/utils/downloadBlob'
import type { SceneMaintenanceSnapshot, SceneDraft } from '@/types/api'

vi.mock('@/composables/useConfirm', () => ({ confirmAction: vi.fn(async () => true) }))
vi.mock('@/utils/downloadBlob', () => ({ downloadBlob: vi.fn() }))
afterEach(() => vi.clearAllMocks())
const scene = (id: string): SceneDraft => ({ id, title: 'fixture', story: 'fixture', char: 'nene', rating: 'All', prompt: 'untouched  prompt', extension: { keep: true },
  category: 'fixture', lora: '', emotion: '', season: '', time: '', timeOfDay: '', location: '', weather: '', camera: '', lighting: '', tags: [], usage: [], storyJa: '', negative: '' })
function setup() {
  const draft: SceneMaintenanceSnapshot = { scenes: [scene('sc001')], tags: [], curation: {}, blueprints: [] }
  const deps = { scenes: ref(draft.scenes), tags: ref(draft.tags), curation: ref(draft.curation), blueprints: ref(draft.blueprints),
    markDirty: vi.fn(), canImport: vi.fn(() => true), esc: (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    errorMessage: (error: unknown) => String(error) }
  return { deps, tools: useSceneImportExport(deps) }
}

describe('scene import/export', () => {
  it('imports long canonical IDs without truncating or dropping unknown fields', () => {
    const { deps, tools } = setup()
    tools.importInput.value = JSON.stringify([scene('sc999'), scene('sc1000'), scene('sc9007199254740991'), scene('sc1000')])
    tools.importScenes()
    expect(deps.scenes.value.map(s => s.id)).toEqual(['sc001', 'sc999', 'sc1000', 'sc9007199254740991'])
    expect(deps.scenes.value[2].extension).toEqual({ keep: true })
    expect(deps.scenes.value[2].prompt).toBe('untouched  prompt')
    expect(tools.importResult.value).toContain('跳过 1')
  })
  it('rejects invalid IDs and escapes error details', () => {
    const { deps, tools } = setup()
    tools.importInput.value = JSON.stringify(['sc000', 'sc0001', 'sc9007199254740992', 'sc1000<script>'].map(scene))
    tools.importScenes()
    expect(deps.scenes.value).toHaveLength(1)
    expect(deps.markDirty).not.toHaveBeenCalled()
    expect(tools.importResult.value).toContain('&lt;script&gt;')
    expect(tools.importResult.value).not.toContain('<script>')
  })
  it('loads all four collections only after an explicit complete-snapshot confirmation', async () => {
    const { deps, tools } = setup()
    const data = { scenes: [scene('sc1000')], blueprints: [{ id: 'bp_001', title: 'fixture', characterId: 'nene', promptProse: '', promptTokens: [], negativeTokens: [] }],
      tags: [{ id: 't', en: 'a', cn: '甲', cat: 'Scene', weight: 1 }], curation: { reviewSceneIds: ['sc1000'] }, version: 1 }
    tools.importInput.value = JSON.stringify(data)
    vi.mocked(confirmAction).mockResolvedValueOnce(false)
    await tools.loadFullSnapshot()
    expect(deps.scenes.value[0].id).toBe('sc001')
    await tools.loadFullSnapshot()
    expect(tools.fullImportLoaded.value).toBe(true)
    expect(deps.scenes.value).toEqual(data.scenes)
    expect(deps.blueprints.value).toEqual(data.blueprints)
    expect(deps.tags.value).toEqual(data.tags)
    expect(deps.curation.value).toEqual(data.curation)
  })
  it('does not partially replace a draft from an incomplete or invalid full snapshot', async () => {
    const { deps, tools } = setup()
    tools.importInput.value = JSON.stringify({ scenes: [scene('sc1000')] })
    await tools.loadFullSnapshot()
    expect(deps.scenes.value[0].id).toBe('sc001')
    expect(tools.fullImportLoaded.value).toBe(false)
    expect(deps.markDirty).not.toHaveBeenCalled()
  })
  it('exports empty scene drafts together with blueprints, tags and curation', async () => {
    const { deps, tools } = setup()
    deps.scenes.value = []
    deps.blueprints.value = [{ id: 'bp_001', title: 'fixture' } as never]
    deps.curation.value.reviewSceneIds = ['sc001']
    tools.exportJSON()
    const blob = vi.mocked(downloadBlob).mock.calls[0][0] as Blob
    const data = JSON.parse(await blob.text())
    expect(data).toMatchObject({ scenes: [], blueprints: [{ id: 'bp_001' }], tags: [], curation: { reviewSceneIds: ['sc001'] }, version: 1 })
  })
  it('respects read-only import gating', async () => {
    const { deps, tools } = setup()
    deps.canImport.mockReturnValue(false)
    tools.importInput.value = JSON.stringify([scene('sc1000')])
    tools.importScenes()
    await tools.loadFullSnapshot()
    expect(deps.scenes.value).toHaveLength(1)
    expect(confirmAction).not.toHaveBeenCalled()
  })
})

import type { CompanionDesktopBridge } from '@/types/desktop'
import { ref, shallowRef, defineComponent } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSceneMaintenance } from './useSceneMaintenance'
import { ApiClientError } from '@/api/client'
import { maintenanceApi } from '@/api/maintenanceApi'
import { confirmAction } from '@/composables/useConfirm'
import { cloneSceneSnapshot, freezeSceneSnapshot } from '@/utils/sceneChanges'
import type { SceneDraft, SceneMaintenanceSnapshot, SceneSaveResult, SceneChangesPreview } from '@/types/api'

vi.mock('@/api/maintenanceApi', () => ({ maintenanceApi: {
  saveScenes: vi.fn(), saveSceneChanges: vi.fn(), importScenesSnapshot: vi.fn(), previewSceneChanges: vi.fn(), run: vi.fn(),
} }))
vi.mock('@/composables/useConfirm', () => ({ confirmAction: vi.fn() }))
const snapshot = (title = 'loaded'): SceneMaintenanceSnapshot => ({
  scenes: [{ id: 'sc001', title, story: 'fixture', char: 'nene', rating: 'All' } as SceneDraft], tags: [], curation: {}, blueprints: [],
})
const receipt = (): SceneSaveResult => ({ ok: true, count: 1, backup: 'fixture', version: 43, snapshot: snapshot('normalized') })
const impact = (): SceneChangesPreview => ({ ok: true, baseVersion: 42, version: 42, added: [], updated: ['sc001'], removed: [],
  blueprints: { added: [], updated: [], removed: [] }, related: [{ kind: 'scene', id: 'sc001', reason: 'fixture' }], checks: ['fixture'], unknown: ['未验收'] })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
let wrapper: ReturnType<typeof mount> | undefined
beforeEach(() => {
  vi.mocked(maintenanceApi.saveSceneChanges).mockResolvedValue(receipt())
  vi.mocked(maintenanceApi.importScenesSnapshot).mockResolvedValue(receipt())
  vi.mocked(maintenanceApi.previewSceneChanges).mockResolvedValue(impact())
  vi.mocked(confirmAction).mockResolvedValue(true)
})
afterEach(() => { wrapper?.unmount(); vi.resetAllMocks(); desktopFixture.current = undefined })
function setup() {
  const baseline = shallowRef<SceneMaintenanceSnapshot | null>(freezeSceneSnapshot(snapshot()))
  const version = ref<number | null>(42)
  const editKey = ref('')
  const draft = snapshot('edited')
  const deps = {
    scenes: ref(draft.scenes), tags: ref(draft.tags), curation: ref(draft.curation), blueprints: ref(draft.blueprints),
    dirty: ref(true), loading: ref(false), maintenanceHint: ref(''),
    baseVersion: () => version.value, baselineSnapshot: () => baseline.value, editSessionKey: () => editKey.value,
    adoptSceneState: vi.fn((next: number, saved: SceneMaintenanceSnapshot) => { version.value = next; baseline.value = freezeSceneSnapshot(saved) }),
    invalidateSceneCache: vi.fn(),
  }
  let tools!: ReturnType<typeof useSceneMaintenance>
  wrapper = mount(defineComponent({ setup() { tools = useSceneMaintenance(deps); return () => null } }))
  return { deps, tools, baseline, version, editKey }
}

describe('maintenance delta saving and edit protection', () => {
  it('submits only the delta then adopts an independent normalized snapshot and version', async () => {
    const { deps, tools, baseline, version } = setup()
    await tools.saveToProject()
    expect(maintenanceApi.saveSceneChanges).toHaveBeenCalledWith({ baseVersion: 42,
      changeSet: { version: 1, scenes: { upsert: snapshot('edited').scenes, remove: [] } } })
    expect(maintenanceApi.saveScenes).not.toHaveBeenCalled()
    expect(maintenanceApi.importScenesSnapshot).not.toHaveBeenCalled()
    expect(version.value).toBe(43)
    expect(deps.dirty.value).toBe(false)
    expect(deps.scenes.value[0].title).toBe('normalized')
    deps.scenes.value[0].title = 'next edit'
    expect(baseline.value!.scenes[0].title).toBe('normalized')
  })
  it.each(['scenes', 'tags', 'curation', 'blueprints', 'form'] as const)('preserves %s edits and the old baseline while a save is pending', async field => {
    const pending = deferred<SceneSaveResult>()
    vi.mocked(maintenanceApi.saveSceneChanges).mockReturnValueOnce(pending.promise)
    const { deps, tools, baseline, version, editKey } = setup()
    const oldBaseline = baseline.value
    const save = tools.saveToProject()
    if (field === 'scenes') deps.scenes.value[0].title = 'new unsaved edit'
    if (field === 'tags') deps.tags.value.push({ id: 't', en: 'a', cn: '甲', cat: 'Scene', weight: 1 })
    if (field === 'curation') deps.curation.value.reviewSceneIds = ['sc001']
    if (field === 'blueprints') deps.blueprints.value = [{ id: 'bp_new', title: 'new' } as never]
    if (field === 'form') editKey.value = 'new unsaved form edit'
    pending.resolve(receipt())
    await save
    expect(deps.dirty.value).toBe(true)
    expect(deps.maintenanceHint.value).toContain('合并')
    expect(deps.adoptSceneState).not.toHaveBeenCalled()
    expect(baseline.value).toBe(oldBaseline)
    expect(version.value).toBe(42)
    expect(deps.scenes.value[0].title).not.toBe('normalized')
    expect(vi.mocked(maintenanceApi.saveSceneChanges).mock.calls[0][0].changeSet.scenes.upsert[0].title).toBe('edited')
    expect(tools.canSave.value).toBe(false)
  })
  it('blocks overlapping save, preview and maintenance writes', async () => {
    const pending = deferred<SceneSaveResult>()
    vi.mocked(maintenanceApi.saveSceneChanges).mockReturnValueOnce(pending.promise)
    const { tools } = setup()
    const save = tools.saveToProject()
    await tools.runTool('classify')
    await tools.previewChanges()
    await tools.saveToProject()
    expect(maintenanceApi.run).not.toHaveBeenCalled()
    expect(maintenanceApi.previewSceneChanges).not.toHaveBeenCalled()
    expect(maintenanceApi.saveSceneChanges).toHaveBeenCalledTimes(1)
    pending.resolve(receipt())
    await save
  })
  it('clears a stale dirty flag for a no-op without issuing any write', async () => {
    const { deps, tools, baseline } = setup()
    deps.scenes.value = cloneSceneSnapshot(baseline.value!).scenes
    await tools.saveToProject()
    expect(deps.dirty.value).toBe(false)
    expect(maintenanceApi.saveSceneChanges).not.toHaveBeenCalled()
    await tools.previewChanges()
    expect(tools.previewEmpty.value).toBe(true)
  })
  it('refuses missing baselines and empty resulting libraries without a full-save fallback', async () => {
    const { deps, tools, baseline } = setup()
    const original = baseline.value
    baseline.value = null
    await tools.saveToProject()
    expect(deps.maintenanceHint.value).toContain('完整读取基线')
    baseline.value = original
    deps.scenes.value = []
    await tools.saveToProject()
    expect(deps.maintenanceHint.value).toContain('不能为空')
    expect(deps.dirty.value).toBe(true)
    expect(maintenanceApi.saveSceneChanges).not.toHaveBeenCalled()
    expect(maintenanceApi.saveScenes).not.toHaveBeenCalled()
  })
  it('shows actionable 409 details and retains local data', async () => {
    vi.mocked(maintenanceApi.saveSceneChanges).mockRejectedValueOnce(new ApiClientError('冲突', { kind: 'http', status: 409,
      responseBody: { ok: false, conflict: { baseVersion: 42, currentVersion: 99, changedIds: ['sc1000'], serverOnlyIds: ['sc1001'] } } }))
    const { deps, tools, version } = setup()
    await tools.saveToProject()
    expect(deps.maintenanceHint.value).toContain('重新读取')
    expect(deps.maintenanceHint.value).toContain('sc1000')
    expect(deps.maintenanceHint.value).toContain('sc1001')
    expect(version.value).toBe(42)
    expect(deps.dirty.value).toBe(true)
    expect(deps.invalidateSceneCache).not.toHaveBeenCalled()
    expect(tools.canSave.value).toBe(false)
  })
  it('uses only the explicit import endpoint after confirmation', async () => {
    const { deps, tools } = setup()
    vi.mocked(confirmAction).mockResolvedValueOnce(false)
    await tools.importSnapshotToProject()
    expect(maintenanceApi.importScenesSnapshot).not.toHaveBeenCalled()
    await tools.importSnapshotToProject()
    expect(maintenanceApi.importScenesSnapshot).toHaveBeenCalledWith({ ...snapshot('edited'), baseVersion: 42 })
    expect(maintenanceApi.saveSceneChanges).not.toHaveBeenCalled()
    expect(deps.dirty.value).toBe(false)
  })
  it('refuses an import whose draft changed during confirmation', async () => {
    const confirmation = deferred<boolean>()
    vi.mocked(confirmAction).mockReturnValueOnce(confirmation.promise)
    const { deps, tools } = setup()
    const save = tools.importSnapshotToProject()
    deps.scenes.value[0].title = 'changed while confirming'
    confirmation.resolve(true)
    await save
    expect(maintenanceApi.importScenesSnapshot).not.toHaveBeenCalled()
    expect(deps.maintenanceHint.value).toContain('确认期间草稿已变化')
  })
  it.each([403, 501])('retains drafts on HTTP %s, including server recovery instructions', async status => {
    vi.mocked(maintenanceApi.saveSceneChanges).mockRejectedValueOnce(new ApiClientError('拒绝', { kind: 'http', status,
      responseBody: { ok: false, recovery: '恢复前不要继续保存' } }))
    const { deps, tools } = setup()
    await tools.saveToProject()
    expect(deps.maintenanceHint.value).toContain('恢复前不要继续保存')
    expect(deps.dirty.value).toBe(true)
    expect(deps.adoptSceneState).not.toHaveBeenCalled()
  })
  it('keeps an unknown packaged-desktop state read-only', async () => {
    desktopFixture.current = { isPackaged: vi.fn().mockRejectedValue(new Error('unavailable')) } as never
    const { tools } = setup()
    await flushPromises()
    await tools.saveToProject()
    expect(tools.canSave.value).toBe(false)
    expect(maintenanceApi.saveSceneChanges).not.toHaveBeenCalled()
  })
})

describe('read-only impact previews', () => {
  it('shows names, full IDs, references and changed companions without saving', async () => {
    const { deps, tools } = setup()
    deps.curation.value.reviewSceneIds = ['sc001']
    await tools.previewChanges()
    expect(tools.preview.value).toEqual(impact())
    expect(tools.previewGroups.value.find(g => g.key === 'scenes-updated')?.items[0]).toEqual({ id: 'sc001', title: 'edited' })
    expect(tools.previewCompanions.value).toEqual(['策展有修改'])
    expect(deps.dirty.value).toBe(true)
    expect(maintenanceApi.saveSceneChanges).not.toHaveBeenCalled()
  })
  it('invalidates an old preview synchronously on draft or editor changes', async () => {
    const { tools, editKey } = setup()
    await tools.previewChanges()
    editKey.value = 'new form edit'
    expect(tools.preview.value).toBeNull()
    expect(tools.previewInvalidated.value).toBe(true)
  })
  it('discards a late aborted response without replacing a newer preview', async () => {
    const first = deferred<SceneChangesPreview>()
    const second = deferred<SceneChangesPreview>()
    vi.mocked(maintenanceApi.previewSceneChanges).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { deps, tools } = setup()
    const request1 = tools.previewChanges()
    const signal = vi.mocked(maintenanceApi.previewSceneChanges).mock.calls[0][1]?.signal
    deps.scenes.value[0].title = 'new edit'
    expect(signal?.aborted).toBe(true)
    const request2 = tools.previewChanges()
    second.resolve({ ...impact(), unknown: ['new preview'] })
    await request2
    first.resolve(impact())
    await request1
    expect(tools.preview.value?.unknown).toEqual(['new preview'])
  })
  it('rejects mismatched preview versions and exposes errors without clearing dirty state', async () => {
    vi.mocked(maintenanceApi.previewSceneChanges).mockResolvedValueOnce({ ...impact(), version: 99 })
    const { deps, tools } = setup()
    await tools.previewChanges()
    expect(tools.preview.value).toBeNull()
    expect(tools.previewError.value).toContain('版本')
    expect(deps.dirty.value).toBe(true)
  })
  it('highlights complete canonical IDs and escapes markup', () => {
    const { tools } = setup()
    tools.toolResult.value = { ok: false, output: '<script> sc999 sc1000 sc9007199254740991 sc000 sc0001 sc9007199254740992 sc1000suffix' }
    expect(tools.highlightedOutput.value).toContain('&lt;script&gt;')
    for (const id of ['sc999', 'sc1000', 'sc9007199254740991']) expect(tools.highlightedOutput.value).toContain(`class="hl-id">${id}</span>`)
    expect(tools.highlightedOutput.value.match(/class="hl-id"/g)).toHaveLength(3)
  })
})

const desktopFixture = vi.hoisted(() => ({ current: undefined as CompanionDesktopBridge | undefined }))
vi.mock('@/platform/desktop/capabilities', () => ({ getDesktopCapabilities: () => desktopFixture.current }))

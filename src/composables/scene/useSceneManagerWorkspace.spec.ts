import { defineComponent } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSceneManagerWorkspace } from './useSceneManagerWorkspace'
import type { SceneMaintenanceDeps } from './useSceneMaintenance'
import type { SceneMaintenanceSnapshot, SceneDraft } from '@/types/api'

const mock = vi.hoisted(() => ({
  getState: vi.fn(), load: vi.fn(), reload: vi.fn(), loadMetadata: vi.fn(async () => {}), confirm: vi.fn(),
  saveChanges: vi.fn(), preview: vi.fn(),
  maintenanceDeps: null as unknown as SceneMaintenanceDeps,
}))
vi.mock('@/api/maintenanceApi', () => ({ maintenanceApi: { getScenesState: mock.getState, saveSceneChanges: mock.saveChanges, previewSceneChanges: mock.preview } }))
vi.mock('@/stores/sceneStore', () => ({ useSceneStore: () => ({
  load: mock.load, reload: mock.reload, loadMetadata: mock.loadMetadata, popularCharacters: [], sceneBlueprints: [],
  scenes: [{ id: 'sc001', title: 'stale cache' }], tags: [], curation: {},
}) }))
vi.mock('@/composables/useConfirm', () => ({ confirmAction: mock.confirm }))
vi.mock('@/composables/useFocusTrap', () => ({ useFocusTrap: vi.fn() }))
vi.mock('vue-router', () => ({ onBeforeRouteLeave: vi.fn() }))
vi.mock('./useSceneShowcaseUpload', () => ({ useSceneShowcaseUpload: () => ({ loadHomeHeroes: vi.fn() }) }))
vi.mock('./useSceneMaintenance', async importOriginal => {
  const original = await importOriginal<typeof import('./useSceneMaintenance')>()
  return { useSceneMaintenance: (deps: SceneMaintenanceDeps) => {
    mock.maintenanceDeps = deps
    return original.useSceneMaintenance(deps)
  } }
})
const snapshot = (): SceneMaintenanceSnapshot => ({ scenes: [{ id: 'sc002', title: 'current', char: 'nene', story: 'fixture', tags: [], usage: [], rating: 'All',
  category: 'fixture', lora: '', emotion: '', season: '', time: '', timeOfDay: '', location: '', weather: '', camera: '', lighting: '', storyJa: '', prompt: '', negative: '' } satisfies SceneDraft], tags: [], curation: {}, blueprints: [] })
let wrapper: ReturnType<typeof mount> | undefined
beforeEach(() => {
  mock.confirm.mockResolvedValue(true)
  mock.getState.mockResolvedValue({ ok: true, version: 7, nextSceneId: 'sc1000', snapshot: snapshot() })
})
afterEach(() => { wrapper?.unmount(); vi.resetAllMocks() })
function setup() {
  let workspace!: ReturnType<typeof useSceneManagerWorkspace>
  wrapper = mount(defineComponent({ setup() { workspace = useSceneManagerWorkspace(); return () => null } }))
  return workspace
}
describe('scene editor snapshot loading', () => {
  it('loads content and its baseline from one response instead of pairing cached data with a new version', async () => {
    mock.getState.mockResolvedValue({ version: 7, snapshot: {
      scenes: [{ id: 'sc002', title: 'current' }], tags: [], curation: {}, blueprints: [],
    } })
    const workspace = setup()
    await flushPromises()
    expect(workspace.scenes.value[0].title).toBe('current')
    expect(mock.maintenanceDeps.baseVersion()).toBe(7)
    expect(mock.load).not.toHaveBeenCalled()
    expect(mock.reload).not.toHaveBeenCalled()
    expect(mock.loadMetadata).toHaveBeenCalledWith(true)
    workspace.dirty.value = true
    mock.confirm.mockResolvedValue(false)
    await workspace.loadFromStore(true)
    expect(mock.getState).toHaveBeenCalledTimes(1)
    expect(workspace.dirty.value).toBe(true)
  })
  it('keeps the authoritative snapshot when auxiliary metadata fails', async () => {
    mock.loadMetadata.mockRejectedValueOnce(new Error('metadata offline'))
    const workspace = setup()
    await flushPromises()
    expect(workspace.scenes.value[0].title).toBe('current')
    expect(workspace.loadError.value).toBe('')
    expect(workspace.dirty.value).toBe(false)
  })

  it('does not turn a failed state request into a writable cached baseline', async () => {
    mock.getState.mockRejectedValue(new Error('offline'))
    const workspace = setup()
    await flushPromises()
    expect(mock.maintenanceDeps.baseVersion()).toBeNull()
    expect(workspace.loadError.value).toBe('offline')
    expect(mock.load).not.toHaveBeenCalled()
    workspace.dirty.value = true
    expect(workspace.canSave.value).toBe(false)
  })
  it('keeps immutable full baselines separate from the API response and edited draft', async () => {
    const data = snapshot()
    data.curation.reviewSceneIds = ['sc002']
    mock.getState.mockResolvedValue({ version: 7, snapshot: data })
    const workspace = setup()
    await flushPromises()
    const baseline = mock.maintenanceDeps.baselineSnapshot()!
    expect(Object.isFrozen(baseline.scenes[0])).toBe(true)
    expect(Object.isFrozen(baseline.curation.reviewSceneIds)).toBe(true)
    data.scenes[0].title = 'changed response object'
    expect(workspace.scenes.value[0].title).toBe('current')
    workspace.scenes.value[0].title = 'edited draft'
    expect(baseline.scenes[0].title).toBe('current')
  })
  it('adopts the normalized receipt as the next complete baseline', async () => {
    const workspace = setup()
    await flushPromises()
    const saved = snapshot()
    saved.scenes[0].title = 'normalized'
    mock.saveChanges.mockResolvedValue({ ok: true, count: 1, backup: 'fixture', version: 8, snapshot: saved })
    workspace.scenes.value[0].title = 'edited'
    workspace.dirty.value = true
    await workspace.saveToProject()
    expect(mock.maintenanceDeps.baseVersion()).toBe(8)
    expect(mock.maintenanceDeps.baselineSnapshot()!.scenes[0].title).toBe('normalized')
    workspace.scenes.value[0].title = 'second edit'
    workspace.dirty.value = true
    await workspace.saveToProject()
    expect(mock.saveChanges.mock.calls[1][0]).toMatchObject({ baseVersion: 8, changeSet: { scenes: { upsert: [{ id: 'sc002', title: 'second edit' }], remove: [] } } })
  })
  it('retains a form opened and edited while a project save is running', async () => {
    const workspace = setup()
    await flushPromises()
    let resolve!: (value: unknown) => void
    mock.saveChanges.mockReturnValueOnce(new Promise(done => { resolve = done }))
    workspace.scenes.value[0].title = 'submitted'
    workspace.dirty.value = true
    const save = workspace.saveToProject()
    workspace.openEditModal('sc002')
    workspace.editing.value!.title = 'still typing'
    resolve({ ok: true, count: 1, backup: 'fixture', version: 8, snapshot: snapshot() })
    await save
    expect(workspace.editing.value!.title).toBe('still typing')
    expect(workspace.scenes.value[0].title).toBe('submitted')
    expect(workspace.dirty.value).toBe(true)
    expect(mock.maintenanceDeps.baseVersion()).toBe(7)
  })
  it('does not replace new edits made during a reload', async () => {
    const workspace = setup()
    await flushPromises()
    let resolve!: (value: unknown) => void
    mock.getState.mockReturnValueOnce(new Promise(done => { resolve = done }))
    const reload = workspace.loadFromStore(true)
    await flushPromises()
    workspace.scenes.value[0].title = 'edited while loading'
    resolve({ version: 99, snapshot: snapshot() })
    await reload
    expect(workspace.scenes.value[0].title).toBe('edited while loading')
    expect(mock.maintenanceDeps.baseVersion()).toBe(7)
    expect(workspace.dirty.value).toBe(true)
  })
  it('allocates distinct sc1000+ copies using the server lower bound', async () => {
    const workspace = setup()
    await flushPromises()
    await Promise.all([workspace.duplicateScene('sc002'), workspace.duplicateScene('sc002')])
    expect(workspace.scenes.value.map(s => s.id)).toEqual(['sc002', 'sc1000', 'sc1001'])
    expect(mock.maintenanceDeps.baseVersion()).toBe(7)
  })
  it('creates unique blueprint IDs and does not reuse a removed baseline identity', async () => {
    const data = snapshot()
    data.blueprints = [{ id: 'bp_001', title: 'one' }, { id: 'bp_003', title: 'three' }] as never
    mock.getState.mockResolvedValue({ version: 7, snapshot: data })
    const workspace = setup()
    await flushPromises()
    mock.maintenanceDeps.blueprints.value.shift()
    workspace.openBlueprintAddModal()
    expect(workspace.bpEditing.value!.id).toBe('bp_002')
    workspace.bpEditing.value!.title = 'two'
    workspace.bpEditing.value!.characterId = 'nene'
    workspace.bpPromptTokensInput.value = 'fixture'
    workspace.bpNegativeTokensInput.value = 'fixture'
    workspace.saveBlueprint()
    workspace.openBlueprintAddModal()
    expect(workspace.bpEditing.value!.id).toBe('bp_004')
  })
})

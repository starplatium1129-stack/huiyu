import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, type App } from 'vue'
import { useModelStudio } from './useModelStudio'
import { buildCalibratedProfile } from '@/live2d/modelCalibration'
import type { ModelInspection } from '@/live2d/modelInspector'
import type { Live2DModelHandle, Live2DStageSession } from '@/live2d/types'

const mocks = vi.hoisted(() => ({ connect: vi.fn(), inspect: vi.fn(), request: vi.fn() }))
vi.mock('@/live2d/modelPreview', () => ({ connectModelPreview: mocks.connect, createModelPreviewUrls: async () => ({ modelUrl: 'blob:fixture', release: vi.fn() }) }))
vi.mock('@/live2d/modelInspector', () => ({ inspectModelFiles: mocks.inspect }))
vi.mock('@/api/client', () => ({ apiClient: { request: mocks.request } }))
vi.mock('@/utils/runtimeEnvironment', () => ({ isLocalStudioHost: () => true }))
vi.mock('@/utils/companionRegistry', () => ({ getCompanionCharacter: () => ({ name: 'Fixture', personaPrompt: 'Neutral' }), resolveCompanionAvatar: () => ({ avatar: { modelPath: '/fixture.model3.json' } }) }))

const inspection = (): ModelInspection => ({ valid: true, entryPath: 'demo.model3.json', entries: [], fingerprint: 'fixture-hash', modelJson: {}, issues: [], totalBytes: 1,
  candidates: { parameters: [], expressions: [{ name: 'Smile', path: 'smile.exp3.json' }], motions: [{ group: 'Tap', index: 0, path: 'tap.motion3.json' }], hitAreas: [] } })
const profile = () => buildCalibratedProfile('fixture', [{ id: 'Mouth', min: -2, max: 2, default: 0 }], { id: 'Mouth', closed: 0, open: 1 }, [])
function modelFixture() {
  let tick = () => {}, active: string | null = null
  const model = { visible: true, enumerateParameters: () => ({ supported: true, parameters: [{ id: 'Mouth', index: 0, minimum: -2, maximum: 2, defaultValue: 0, value: 0.4 }] }),
    setParameterValueById: vi.fn(), focus: vi.fn(), stopAnimation: vi.fn(), expression: vi.fn().mockResolvedValue(true), motion: vi.fn().mockImplementation(async () => { active = 'Tap'; return true }),
    getActiveMotionGroup: () => active, onBeforeModelUpdate: (callback: () => void) => { tick = callback } } as unknown as Live2DModelHandle
  return { model, tick: () => tick(), end: () => { active = null } }
}
let studio: ReturnType<typeof useModelStudio>, app: App
beforeEach(() => {
  vi.useFakeTimers(); mocks.connect.mockReset(); mocks.inspect.mockReset(); mocks.request.mockReset(); localStorage.clear()
  app = createApp(defineComponent({ setup() { studio = useModelStudio('fixture'); return () => null } }))
  app.mount(document.createElement('div'))
  studio.inspection.value = inspection(); studio.identity.id = 'fixture'
  mocks.inspect.mockResolvedValue(inspection())
})
afterEach(() => { app.unmount(); vi.useRealTimers() })
async function load() {
  const fixture = modelFixture(), session = { destroy: vi.fn() } as unknown as Live2DStageSession
  mocks.connect.mockImplementation(async (_selector, _url, _signal, loaded) => { loaded(fixture.model); return session })
  await studio.preview()
  studio.mouth.id = 'Mouth'; studio.mouth.closed = 0; studio.mouth.open = 1
  studio.expressions.value = ['Smile']; studio.motions.value = [{ group: 'Tap', index: 0 }]
  return { ...fixture, session }
}
describe('model studio state ownership', () => {
  it('does not let a late preview destroy or replace the newer session', async () => {
    const fixture = modelFixture(), first = { destroy: vi.fn() }, second = { destroy: vi.fn() }
    let finish!: (session: unknown) => void
    mocks.connect.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const old = studio.preview()
    await Promise.resolve()
    mocks.connect.mockImplementationOnce(async (_selector, _url, _signal, loaded) => { loaded(fixture.model); return second })
    await studio.preview(); finish(first); await old
    expect(first.destroy).toHaveBeenCalledOnce(); expect(second.destroy).not.toHaveBeenCalled(); expect(studio.ready.value).toBe(true)
    studio.stopPreview(); expect(second.destroy).toHaveBeenCalledOnce()
  })
  it('restores baseline and cancels expression and motion tests on completion or stop', async () => {
    const fixture = await load()
    await studio.play('motion', 'Tap'); fixture.tick(); fixture.end(); fixture.tick()
    expect(fixture.model.stopAnimation).toHaveBeenCalled()
    expect(fixture.model.setParameterValueById).toHaveBeenLastCalledWith('Mouth', 0.4, 1)
    await studio.play('expression', 'Smile'); vi.advanceTimersByTime(5000)
    expect(fixture.model.setParameterValueById).toHaveBeenLastCalledWith('Mouth', 0.4, 1)
    studio.test('mouth'); studio.mouth.open = 999; fixture.tick()
    expect(studio.message.value).toContain('端点无效')
    expect(fixture.model.setParameterValueById).not.toHaveBeenCalledWith('Mouth', 999, 1)
  })
  it('rejects a structurally valid profile with nonexistent runtime parameters without changing current edits', async () => {
    await load()
    const bad = profile(); bad.parameterBindings.mouth!.id = 'Unknown'
    await studio.importProfile(new File([JSON.stringify({ fingerprint: 'fixture-hash', profile: bad })], 'profile.json'))
    expect(studio.mouth.id).toBe('Mouth'); expect(studio.mouth.open).toBe(1); expect(studio.message.value).toContain('端点无效')
  })
  it('validates drafts before applying any identity or binding and reports storage denial', async () => {
    await load()
    localStorage.setItem('aics-model-draft-fixture-hash', JSON.stringify({ identity: { id: 'replacement' }, mouth: { id: 'Unknown', closed: 0, open: 1 } }))
    studio.restoreDraft(); expect(studio.identity.id).toBe('fixture'); expect(studio.mouth.id).toBe('Mouth')
    vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => { throw new Error('quota') })
    studio.saveDraft(); expect(studio.message.value).toContain('草稿保存失败')
  })
  it('sends revision and fingerprint for rollback and ignores a response after switching models', async () => {
    studio.saved.value = { id: 'fixture', revision: 'r1', fingerprint: 'saved-hash', profile: profile() }
    let finish!: (value: unknown) => void
    mocks.request.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const pending = studio.rollback()
    expect(mocks.request).toHaveBeenCalledWith('/api/live2d-import/fixture/rollback', expect.objectContaining({ body: { revision: 'r1', fingerprint: 'saved-hash' } }))
    await studio.selectFiles([]); finish({ revision: 'r2', profile: profile() }); await pending
    expect(studio.saved.value).toBeNull(); expect(studio.needsReload.value).toBe(false)
  })
  it('does not clear busy when an older file inspection completes', async () => {
    let first!: (value: unknown) => void, second!: (value: unknown) => void
    mocks.inspect.mockImplementationOnce(() => new Promise(resolve => { first = resolve })).mockImplementationOnce(() => new Promise(resolve => { second = resolve }))
    const old = studio.selectFiles([]), current = studio.selectFiles([])
    first(inspection()); await old; expect(studio.busy.value).toBe(true)
    second(inspection()); await current; expect(studio.busy.value).toBe(false)
  })
  it('deactivates only the selected revision, releases its preview and leaves saved identity intact', async () => {
    const fixture = await load()
    const saved = { id: 'fixture', revision: 'r1', fingerprint: 'saved-hash', profile: profile() }
    studio.saved.value = saved
    mocks.request.mockResolvedValue({ ...saved, revision: 'r2', disabled: true })
    await studio.deactivate()
    expect(mocks.request).toHaveBeenCalledWith('/api/live2d-import/fixture', expect.objectContaining({ method: 'DELETE', body: { revision: 'r1', fingerprint: 'saved-hash' } }))
    expect(studio.saved.value).toMatchObject({ id: 'fixture', disabled: true })
    expect(studio.ready.value).toBe(false); expect(studio.needsReload.value).toBe(true)
    expect(fixture.session.destroy).toHaveBeenCalledOnce()
    expect(studio.message.value).toContain('文件、聊天和角色记忆均保留')
    mocks.connect.mockClear(); await studio.preview(); expect(mocks.connect).not.toHaveBeenCalled()
  })
  it('ignores a late deactivate result when a different folder is selected', async () => {
    const saved = { id: 'fixture', revision: 'r1', fingerprint: 'saved-hash', profile: profile() }
    studio.saved.value = saved
    let finish!: (value: unknown) => void
    mocks.request.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const pending = studio.deactivate()
    await studio.selectFiles([]); finish({ ...saved, disabled: true }); await pending
    expect(studio.saved.value).toBeNull(); expect(studio.needsReload.value).toBe(false)
  })
})

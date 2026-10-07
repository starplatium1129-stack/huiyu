import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, KeepAlive, nextTick, ref } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { apiClient } from '@/api/client'
import { generationApi } from '@/api/generationApi'
import { usePromptBuilderStore, type Scene } from '@/stores/promptBuilderStore'
import { useSceneStore } from '@/stores/sceneStore'
import { DRAW_ENGINE_SETTING, settingsRepository } from '@/storage/settingsRepository'
import { artworkRepository } from '@/storage/artworkRepository'
import { readTempResult } from '@/utils/tempResult'
import { usePromptWorkspace } from './usePromptWorkspace'
import type { AnimaSubmission } from '@/composables/generation/animaSessionContract'
import type { PromptGenerationContext } from './promptGenerationActions'
import type { SdResultSnapshot } from './sdResultActions'
import presetCatalog from '../../../data/presets.json'
import { parsePresetCatalog } from '@/utils/promptBuilderPersistence'

vi.mock('virtual:data-version', () => ({ DATA_VERSION: 0 }))
vi.mock('@/utils/tempResult', () => ({ clearTempResult: vi.fn(), readTempResult: vi.fn(() => null), writeTempResult: vi.fn(() => true) }))

const scene: Scene = { id: 'fixture-one', title: '隔离场景', char: 'nene', story: 'A quiet garden.', prompt: 'garden', recommendedSize: '1216x832' }
const secondScene: Scene = { ...scene, id: 'fixture-two', title: '隔离场景二', story: 'A sunny window.', prompt: 'window', recommendedSize: '832x1216' }
const wrappers: VueWrapper[] = []

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  localStorage.setItem('aics_pb_director_mode', 'pro')
  settingsRepository.set(DRAW_ENGINE_SETTING, 'sd')
  vi.mocked(readTempResult).mockReturnValue(null)
  // Every backend request is an isolated fixture; no local gateway or model is contacted.
  vi.spyOn(apiClient, 'request').mockResolvedValue({ ok: true, online: false, models: [], samplers: [], schedulers: [] })
})
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function setup(query = '', loadData: () => Promise<void> = async () => {}, restoreSavedDraft = false, cached = false) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const pb = usePromptBuilderStore()
  const catalog = useSceneStore()
  catalog.scenes = [scene, secondScene]
  catalog.curation = { personaCoreSceneIds: [scene.id], curatedSceneIds: [secondScene.id] }
  const load = vi.spyOn(pb, 'loadData').mockImplementation(loadData)
  const loadHistory = vi.spyOn(pb, 'loadHistory').mockResolvedValue()
  const restoreDraft = vi.spyOn(pb, 'restoreDraft')
  if (!restoreSavedDraft) restoreDraft.mockReturnValue(false)
  const saveDraft = vi.spyOn(pb, 'saveDraft').mockImplementation(() => {})
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/prompt-builder', component: { render: () => null } }] })
  await router.push('/prompt-builder' + query)
  await router.isReady()
  let workspace!: ReturnType<typeof usePromptWorkspace>
  const active = ref(true)
  const page = defineComponent({ setup() { workspace = usePromptWorkspace(); return () => h('div') } })
  const wrapper = mount(cached ? defineComponent({ setup: () => () => h(KeepAlive, null, { default: () => active.value ? h(page) : null }) }) : page, { global: { plugins: [pinia, router] } })
  wrappers.push(wrapper)
  // SD status and video tools load lazily during mount; flushPromises alone does
  // not wait for Vite to finish those imports before the lifecycle applies links.
  await vi.dynamicImportSettled()
  await flushPromises()
  return { workspace, pb, catalog, router, wrapper, active, load, loadHistory, restoreDraft, saveDraft }
}

describe('workspace ownership and panel boundaries', () => {
  it.each(['unmount', 'deactivate'])('does not apply a reference after %s while its helper is loading', async boundary => {
    const { workspace, pb, wrapper, active } = await setup('', undefined, false, boundary === 'deactivate')
    pb.manualTags = new Set(['smile'])
    const applying = workspace.handleInterrogateResult({ engine: 'wd14', tags: ['forest'] })
    if (boundary === 'unmount') wrapper.unmount()
    else { active.value = false; await nextTick() }
    await applying
    expect([...pb.manualTags]).toEqual(['smile'])
    expect(pb.referenceInput).toBeNull()
  })

  it('shows no-LoRA mode for a popular character on the configured MiaoMiao 2.9B checkpoint', async () => {
    const { workspace, pb } = await setup()
    const modelId = 'anima-miaomiao-2.9b-beta1.1'
    pb.modelProfiles = parsePresetCatalog(presetCatalog).modelProfiles
    pb.subject = { kind: 'popular', characterId: 'fixture-character', outfitId: 'default', blueprintId: null }
    workspace.animaSession.patchState({ family: 'anima', modelId, width: 832, height: 1216, steps: 31, cfg: 4, seed: 0, teaCache: true, teaCacheThresh: 0.08,
      models: [{ id: modelId, available: true, capabilities: { noLora: true, lora: false, negative: true, characterIdentity: true, experimental: false } }] })
    await nextTick()
    expect(workspace.renderBindings.animaNoLoraMode.value).toBe(true)
    expect(workspace.recipePreviewContext.animaRequest()).toMatchObject({ modelId, loraId: null, character: null,
      width: 832, height: 1216, steps: 31, cfg: 4, seed: 0, teaCache: true, teaCacheThresh: 0.08 })
    pb.setStudioSubject()
    workspace.animaSession.patchState({ modelId: 'anima-miaomiao-v1.6', loraId: 'L_NENE_V21_ANIMA', loraStrength: 0.75,
      width: 1216, height: 832, steps: 29, cfg: 4.5, seed: 42, teaCache: false,
      loras: [{ id: 'L_NENE_V21_ANIMA', available: true }] })
    await nextTick()
    expect(workspace.recipePreviewContext.animaRequest()).toMatchObject({ modelId: 'anima-miaomiao-v1.6',
      loraId: 'L_NENE_V21_ANIMA', character: 'nene', width: 1216, height: 832, steps: 29, cfg: 4.5, seed: 42, teaCache: false })
  })

  it('waits for initialization, then autosaves parameter-only and album edits', async () => {
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const { pb, saveDraft } = await setup('', () => waiting)
    pb.sdParams.cfg = 0; pb.story = 'Saved input not loaded yet'
    await nextTick()
    expect(saveDraft).not.toHaveBeenCalled()
    release(); await vi.dynamicImportSettled(); await flushPromises()
    expect(saveDraft).toHaveBeenCalled()
    saveDraft.mockClear()
    pb.sdParams.cfg = 8.5; pb.sdParams.steps = 41; pb.sdParams.seed = 0; pb.sdParams.seedLock = true
    pb.sdParams.sampler = 'Euler'; pb.sdParams.scheduler = 'Karras'; pb.projectId = 'next-album'; pb.markParamTouched('cfg')
    await nextTick()
    expect(saveDraft).toHaveBeenCalledOnce()
  })

  it('keeps a user-picked SD draft size, while explicit scenes and history own their dimensions', async () => {
    localStorage.setItem('aics_pb_last_draft', JSON.stringify({ updatedAt: 1, story: scene.story,
      sceneId: scene.id, sceneBaseStory: scene.story, sdParams: { size: '1024x1024' }, sdParamsTouched: ['size'] }))
    const { workspace, pb, saveDraft, router } = await setup('', undefined, true)
    expect(workspace.genBarSize.value).toBe('1024x1024')
    expect(saveDraft).toHaveBeenCalled()
    saveDraft.mockClear()
    workspace.genBarSize.value = '1344x896'
    await nextTick(); await nextTick()
    expect(pb.sdParams.size).toBe('1344x896'); expect(pb.sdParamsTouched.has('size')).toBe(true)
    expect(saveDraft).toHaveBeenCalled()
    pb.modelProfiles = [{ id: 'size-fixture', name: 'Size fixture', checkpoint_match: '.*', size: '1216x832' }]
    pb.sdModelName = 'new-checkpoint'; await nextTick(); await nextTick()
    expect(workspace.genBarSize.value).toBe('1344x896')
    expect(pb.sdParams.size).toBe('1344x896')
    workspace.renderBindings.resetSdParams(); await nextTick(); await nextTick()
    expect(workspace.genBarSize.value).toBe('1216x832')
    expect(pb.sdParams.size).toBe('1216x832')
    expect(pb.sdParamsTouched.has('size')).toBe(false)
    await router.push('/prompt-builder?scene=fixture-two'); await vi.dynamicImportSettled(); await flushPromises()
    expect(workspace.genBarSize.value).toBe(secondScene.recommendedSize)
    expect(pb.sdParamsTouched.has('size')).toBe(false)
    pb.history = [{ id: 'saved', engine: 'sd', character: 'nene', story: 'Saved scene', size: '1216x832', seed: 0 }]
    await router.push('/prompt-builder?regen=saved'); await vi.dynamicImportSettled(); await flushPromises()
    expect(workspace.genBarSize.value).toBe('1216x832')
    expect(pb.sdParams.size).toBe('1216x832')
  })

  it('hires freezes the completed recipe before cold loading, supports loading cancellation and refuses unknown recipes', async () => {
    const anima: AnimaSubmission = { family: 'anima', request: { prompt: 'recipe A', negative: 'negative A', profileId: 'profile A',
      modelId: 'model A', loraId: null, loraStrength: null, character: null, width: 832, height: 1216, steps: 28, cfg: 4.5, seed: 0 }, context: { characterId: 'role A' } }
    const { workspace, pb } = await setup()
    workspace.drawEngine.value = 'anima'
    workspace.animaSession.patchState({ online: true, family: 'anima', phase: 'succeeded', resultContext: anima.context,
      result: { url: 'blob:original-A', blob: new Blob(['original'], { type: 'image/png' }), metadata: { ...anima.request,
        id: 'original-A', engine: 'anima', seed: 0, sampler: 'original', scheduler: 'original', createdAt: 0, resultUrl: null } } })
    const source = vi.spyOn(workspace.animaSession, 'resultSubmission').mockReturnValue(anima)
    vi.mocked(apiClient.request).mockRejectedValue(new Error('isolated submission failure'))
    const loading = workspace.upscaleCurrentResult()
    expect(source).toHaveBeenCalledOnce(); expect(workspace.generationBusy.value).toBe(true)
    source.mockReturnValue({ ...anima, request: { ...anima.request, prompt: 'recipe B', modelId: 'model B' } })
    pb.story = 'recipe B'
    await loading
    const posts = () => vi.mocked(apiClient.request).mock.calls.filter(([url, options]) => url === '/api/anima/jobs' && options?.method === 'POST')
    expect(posts()).toHaveLength(1)
    expect(posts()[0]![1]!.body).toMatchObject({ prompt: 'recipe A', modelId: 'model A', seed: 0, hiresFix: true })
    expect(workspace.animaSession.restoreStashedResult()).toBe(true)
    source.mockReturnValue(anima)
    const cancelled = workspace.upscaleCurrentResult()
    workspace.cancelGeneration(); await cancelled
    expect(posts()).toHaveLength(1)
    expect(workspace.generationBusy.value).toBe(false)

    const { upscaleCurrentResultAction } = await import('./promptGenerationActions')
    const sd = { prompt: 'recipe A', negative: 'negative A', checkpoint: 'model A', sampler: 'Euler', size: '832x1216', seed: 0, cfg: 7, steps: 24,
      hiresFix: false, hiresScale: 1.5, denoisingStrength: 0.5, context: { char: 'nene' } } as SdResultSnapshot
    const current = { prompt: 'recipe B', model: 'model B', hiresFix: false }
    const generate = vi.fn().mockResolvedValue(undefined), run = vi.fn().mockResolvedValue('blob:hires')
    const capture = vi.fn(() => current), flash = vi.fn(), saved = vi.fn()
    const context = { pb: { flash, sdParams: current }, drawEngine: ref('anima'), generationBusy: ref(false),
      generateAnima: generate, captureJob: capture, applyManagedRoute: capture, runJob: run,
      sd: { errorMsg: ref('') }, sdErrorReport: ref(null), tempResultTools: { handleSdResult: saved },
    } as unknown as PromptGenerationContext
    await upscaleCurrentResultAction(context, { engine: 'anima', anima, sd: null })
    expect(generate).toHaveBeenCalledExactlyOnceWith({ hiresFix: true, hiresScale: 2, hiresDenoise: 0.35 }, anima)
    context.drawEngine.value = 'sd'
    await upscaleCurrentResultAction(context, { engine: 'sd', anima: null, sd })
    expect(run).toHaveBeenCalledExactlyOnceWith({ ...sd, hiresFix: true, hiresScale: 2, denoisingStrength: 0.35 })
    expect(saved).toHaveBeenCalledOnce(); expect(capture).not.toHaveBeenCalled()
    expect(current).toEqual({ prompt: 'recipe B', model: 'model B', hiresFix: false }); expect(sd.hiresFix).toBe(false)
    context.drawEngine.value = 'anima'
    await upscaleCurrentResultAction(context, { engine: 'anima', anima: null, sd: null })
    expect(generate).toHaveBeenCalledOnce()
    expect(flash).toHaveBeenLastCalledWith(expect.stringContaining('未知'))
  })
  it('projects live store fields and keeps draft subscription single across mode changes', async () => {
    const { workspace, pb, catalog, saveDraft } = await setup()
    const { renderBindings, styleBindings, healthBindings, deliveryBindings } = workspace
    expect(renderBindings.pb).not.toBe(pb)
    expect(Object.keys(healthBindings.pb)).toEqual(['directorMode', 'isPopular'])
    expect('generate' in deliveryBindings).toBe(false)
    renderBindings.pb.sdModelName = 'fixture-checkpoint'
    expect(pb.sdModelName).toBe('fixture-checkpoint')
    const replacementParams = { ...pb.sdParams, steps: 19 }
    renderBindings.pb.sdParams = replacementParams
    expect(pb.sdParams.steps).toBe(19)
    pb.directorMode = 'basic'
    expect(styleBindings.pb.directorMode).toBe('basic')
    expect(healthBindings.pb.directorMode).toBe('basic')
    workspace.setDirectorMode('pro')
    await flushPromises()
    saveDraft.mockClear()
    pb.story = 'One shared draft update.'
    await nextTick()
    expect(deliveryBindings.pb.story).toBe(pb.story)
    expect(saveDraft).toHaveBeenCalledOnce()
    const previousScenes = deliveryBindings.scenes.value
    catalog.sceneBlueprints = [...catalog.sceneBlueprints]
    expect(deliveryBindings.scenes.value).toBe(catalog.sceneBlueprints)
    expect(deliveryBindings.scenes.value).not.toBe(previousScenes)
  })

  it('selects studio scenes through one action with size, caption and style reset intact', async () => {
    const { workspace, pb } = await setup()
    const caption = vi.fn()
    workspace.deliveryBindings.voiceStudioRef.value = { setSuggestedCaption: caption }
    workspace.animaSession.patchState({ styleLoraId: 'fixture-style' })
    workspace.materialBindings.sceneLimit.value = 80
    workspace.materialBindings.selectScene(scene)
    expect(pb.sceneId).toBe(scene.id)
    expect(pb.story).toBe(scene.story)
    expect(workspace.genBarSize.value).toBe(scene.recommendedSize)
    expect(workspace.animaState.value.styleLoraId).toBe('')
    expect(workspace.materialBindings.sceneLimit.value).toBe(20)
    expect(caption).toHaveBeenCalledWith(scene.story)
  })

  it('replays changed scene links on the same instance and preserves the material ref', async () => {
    const { workspace, pb, router, restoreDraft, saveDraft } = await setup('?scene=fixture-one')
    const limit = workspace.materialBindings.sceneLimit
    expect(pb.sceneId).toBe(scene.id)
    expect(restoreDraft).not.toHaveBeenCalled()
    expect(saveDraft).toHaveBeenCalled()
    await router.push('/prompt-builder?scene=fixture-two')
    await flushPromises()
    expect(pb.sceneId).toBe(secondScene.id)
    expect(pb.story).toBe(secondScene.story)
    expect(workspace.genBarSize.value).toBe(secondScene.recommendedSize)
    expect(workspace.materialBindings.sceneLimit).toBe(limit)
    workspace.materialBindings.setSceneCollection('core')
    expect(workspace.materialBindings.availableScenes.value.map(item => item.id)).toEqual([scene.id])
    pb.sceneSearch = secondScene.title
    await nextTick()
    expect(workspace.materialBindings.availableScenes.value.map(item => item.id)).toEqual([secondScene.id])
  })

  it('keeps explicit generation parameters on failure and retries through the same job path', async () => {
    const { workspace, pb } = await setup()
    workspace.materialBindings.selectScene(scene)
    pb.sdParams = { ...pb.sdParams, steps: 23, cfg: 5.5, seed: 123, seedLock: true, hiresFix: false, faceDetailer: false }
    const request = vi.spyOn(generationApi, 'createJob').mockRejectedValue(new Error('isolated failure'))
    await workspace.callGenerate()
    expect(request).toHaveBeenCalledOnce()
    const submitted = request.mock.calls[0][0]
    // The current SD queue conveys identity through its prompt/LoRAs; its gateway
    // character field is empty. This refactor deliberately keeps that request contract.
    expect(submitted).toMatchObject({ character: '', width: 1216, height: 832, steps: 23, cfg: 5.5, seed: 123, hiresFix: false, faceDetailer: false })
    expect(submitted.prompt).toContain('garden')
    expect(workspace.generationBusy.value).toBe(false)
    expect(workspace.deliveryBindings.sdErrorReport.value).not.toBeNull()
    await workspace.callGenerate()
    expect(request.mock.calls[1][0]).toEqual(submitted)
  })

  it('does not continue delayed initialization after the workspace is destroyed', async () => {
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const { wrapper, loadHistory, restoreDraft } = await setup('?scene=fixture-one&generate=1', () => waiting)
    const generate = vi.spyOn(generationApi, 'createJob')
    wrapper.unmount()
    release()
    await flushPromises()
    expect(loadHistory).not.toHaveBeenCalled()
    expect(restoreDraft).not.toHaveBeenCalled()
    expect(generate).not.toHaveBeenCalled()
  })

  it('preserves a new failed attempt when startup image recovery finishes later', async () => {
    let release!: (image: Blob) => void
    vi.mocked(readTempResult).mockReturnValueOnce({ imageId: 'previous-image', engine: 'sd', prompt: 'Previous scene',
      negative: '', seed: 41, size: '832x1216', savedAt: 1 })
    const read = vi.spyOn(artworkRepository, 'getImage').mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const { workspace } = await setup()
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
    workspace.materialBindings.selectScene(scene)
    const generate = vi.spyOn(generationApi, 'createJob').mockRejectedValue(new Error('new attempt failed'))
    await workspace.callGenerate()
    expect(generate).toHaveBeenCalledOnce()
    expect(workspace.generationBusy.value).toBe(false)
    release(new Blob(['previous image'], { type: 'image/png' }))
    await flushPromises()
    expect(workspace.displayResultUrl.value).toBe('')
    expect(workspace.sd.taskState.value).toBe('failed')
    expect(workspace.deliveryBindings.sdErrorReport.value).not.toBeNull()
  })
})

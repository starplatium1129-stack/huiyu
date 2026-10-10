import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, effectScope, ref } from 'vue'
import { useAnimaInpaint, type AnimaInpaintDeps } from './useAnimaInpaint'
import { ANIMA_LORA_BY_CHARACTER } from './useAnimaSession'
import { apiClient } from '@/api/client'
import type { InpaintSubmitPayload } from '@/components/AnimaInpaintModal.vue'
import type { AnimaSubmission } from './animaSessionContract'

vi.mock('@/api/client', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/client')>(),
  apiClient: { request: vi.fn() },
}))

const cleanups: Array<() => void> = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.restoreAllMocks() })
function harness(popular = false) {
  const generate = vi.fn().mockResolvedValue(undefined)
  const flash = vi.fn()
  const deps = {
    pb: { char: 'nene', flash }, drawEngine: ref('anima'),
    animaState: ref({
      phase: 'idle', family: 'anima', modelId: 'character-model', width: 832, height: 1216, loraStrength: 0.75,
      models: [
        { id: 'character-model', sizes: ['832x1216'] },
        { id: 'base-model', sizes: ['1024x1024'], capabilities: { noLora: true } },
      ],
    }),
    generateAnima: generate,
    preparing: ref(false), captureAnimaSubmission: vi.fn(() => ({ family: 'anima', request: {
      prompt: 'original recipe', negative: 'original negative', profileId: 'fixture', modelId: 'character-model',
      loraId: ANIMA_LORA_BY_CHARACTER.nene, loraStrength: 0.75, width: 832, height: 1216, steps: 30, cfg: 4.5, character: 'nene',
    }, context: { characterId: 'original-role' } } satisfies AnimaSubmission)),
    isPopular: computed(() => popular), popularIdentityTokens: computed(() => ['example_character', 'blue_eyes']),
  } as unknown as AnimaInpaintDeps
  const scope = effectScope()
  const tools = scope.run(() => useAnimaInpaint(deps))!
  cleanups.push(() => scope.stop())
  tools.inpaintOpen.value = true
  return { deps, tools, generate, flash, scope }
}

const payload: InpaintSubmitPayload = {
  sourceHistoryId: 'source-artwork', imageBlob: new Blob(['original']), maskBlob: null, maskPrompt: 'clothing', maskThreshold: 0.4,
  newOutfitPrompt: 'blue jacket', negativePrompt: 'blur', denoisingStrength: 0.6, growMaskBy: 12, seed: 0,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(apiClient.request).mockResolvedValue({ ok: true, name: 'source.png' })
})

describe('换装提交按操作加载', () => {
  it('keeps the frozen Endfield binding through image upload and outfit changes', async () => {
    const { deps, tools, generate } = harness(true)
    deps.animaState.value.modelId = 'anima-miaomiao-v1.6'
    deps.animaState.value.models = [{ id: 'anima-miaomiao-v1.6', sizes: ['832x1216'], capabilities: { negative: true, lora: true, noLora: true, characterIdentity: true, experimental: false } }]
    vi.mocked(deps.captureAnimaSubmission).mockReturnValue({ family: 'anima', request: {
      prompt: 'rossi \\(arknights\\), white dress', negative: '', profileId: 'fixture', modelId: 'anima-miaomiao-v1.6',
      loraId: 'L_ENDFIELD_ALL_V1_ANIMA', loraStrength: 0.75, width: 832, height: 1216, steps: 30, cfg: 4.5, character: 'rossy_arknights',
    }, context: { characterId: 'rossy_arknights' } })
    await tools.handleInpaintSubmit(payload)
    expect(generate.mock.calls[0][0]).toMatchObject({ character: 'rossy_arknights', loraId: 'L_ENDFIELD_ALL_V1_ANIMA', loraStrength: 0.75 })
  })
  it('初始化不上传图片，确认后保留工作室角色、遮罩与完整生成参数', async () => {
    const { tools, generate, scope } = harness()
    const owned = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:owned-original')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    generate.mockImplementation(async () => { URL.revokeObjectURL('blob:original') })
    expect(apiClient.request).not.toHaveBeenCalled()
    vi.mocked(apiClient.request)
      .mockResolvedValueOnce({ ok: true, name: 'source.png' })
      .mockResolvedValueOnce({ ok: true, name: 'mask.png' })
    await tools.handleInpaintSubmit({ ...payload, maskBlob: new Blob(['mask']) })
    expect(apiClient.request).toHaveBeenCalledTimes(2)
    expect(generate).toHaveBeenCalledWith({
      prompt: 'ayachi_nene, blue jacket', modelId: 'character-model', negative: 'blur',
      initImage: 'source.png', maskImage: 'mask.png', denoisingStrength: 0.6, growMaskBy: 12,
      seed: 0, character: 'nene', loraId: ANIMA_LORA_BY_CHARACTER.nene, loraStrength: 0.75,
      width: 832, height: 1216, teaCache: true,
    }, expect.objectContaining({ family: 'anima', context: { characterId: 'original-role', parentId: 'source-artwork' } }))
    expect(tools.inpaintOpen.value).toBe(false)
    expect(owned).toHaveBeenCalledExactlyOnceWith(payload.imageBlob)
    expect(tools.inpaintOriginalUrl.value).toBe('blob:owned-original')
    expect(revoke).not.toHaveBeenCalledWith('blob:owned-original')
    scope.stop()
    expect(revoke).toHaveBeenCalledWith('blob:owned-original')
  })

  it('freezes model and LoRA state before the asynchronous source upload', async () => {
    const { deps, tools, generate } = harness()
    let resolveUpload!: (value: object | PromiseLike<object>) => void
    vi.mocked(apiClient.request).mockImplementationOnce(() => new Promise(resolve => { resolveUpload = resolve }))
    const pending = tools.handleInpaintSubmit(payload)
    deps.animaState.value.modelId = 'base-model'
    deps.animaState.value.loraStrength = 0.1
    await vi.waitFor(() => expect(apiClient.request).toHaveBeenCalled())
    resolveUpload({ ok: true, name: 'source.png' })
    await pending
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'character-model', loraStrength: 0.75 }), expect.objectContaining({ request: expect.objectContaining({ modelId: 'character-model' }) }))
  })

  it('keeps an external source explicitly parentless even if the caller changes its draft during preparation', async () => {
    const { tools, generate } = harness()
    const external = { ...payload, sourceHistoryId: null as string | number | null }
    const pending = tools.handleInpaintSubmit(external)
    external.sourceHistoryId = 'unrelated-later-artwork'
    await pending
    expect(generate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      context: expect.objectContaining({ parentId: null }),
    }))
  })

  it('热门角色沿用无 LoRA 绑定、身份与自动遮罩参数', async () => {
    const { tools, generate } = harness(true)
    await tools.handleInpaintSubmit({ ...payload, characterOverride: 'nene', targetWidth: 1024, targetHeight: 1024 })
    expect(generate).toHaveBeenCalledWith({
      prompt: 'example_character, blue_eyes, blue jacket', modelId: 'base-model',
      negative: 'blur, face, head, hair, duplicate person, extra person',
      initImage: 'source.png', maskPrompt: 'clothing', maskThreshold: 0.4,
      denoisingStrength: 0.6, growMaskBy: 12, seed: 0, character: null, loraId: null,
      loraStrength: null, width: 1024, height: 1024, teaCache: true,
    }, expect.objectContaining({ family: 'anima' }))
  })

  it('错误引擎不上传，上传失败不提交并保留重试弹窗', async () => {
    const { deps, tools, generate, flash } = harness()
    deps.drawEngine.value = 'krea2'
    await tools.handleInpaintSubmit(payload)
    expect(apiClient.request).not.toHaveBeenCalled()
    deps.drawEngine.value = 'anima'
    vi.mocked(apiClient.request).mockRejectedValueOnce(new Error('upload failed'))
    await tools.handleInpaintSubmit(payload)
    expect(generate).not.toHaveBeenCalled()
    expect(flash).toHaveBeenLastCalledWith('换装失败：upload failed')
    expect(tools.inpaintOpen.value).toBe(true)
  })

  it('preparation is single-flight and rejects late uploads after closing, changing engine or disposing', async () => {
    for (const boundary of ['loading', 'close', 'engine', 'dispose']) {
      vi.mocked(apiClient.request).mockClear()
      const { deps, tools, generate, scope } = harness()
      let finish!: (result: object) => void
      vi.mocked(apiClient.request).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      const pending = tools.handleInpaintSubmit(payload)
      if (boundary === 'loading') {
        tools.inpaintOpen.value = false; await pending
        expect(apiClient.request).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled()
        scope.stop(); vi.mocked(apiClient.request).mockReset()
        continue
      }
      await vi.waitFor(() => expect(apiClient.request).toHaveBeenCalledOnce())
      expect(deps.preparing.value).toBe(true)
      await tools.handleInpaintSubmit(payload)
      expect(apiClient.request).toHaveBeenCalledOnce()
      if (boundary === 'close') tools.inpaintOpen.value = false
      else if (boundary === 'engine') deps.drawEngine.value = 'krea2'
      else scope.stop()
      expect(vi.mocked(apiClient.request).mock.calls[0]![1]!.signal?.aborted).toBe(true)
      expect(deps.preparing.value).toBe(false)
      finish({ ok: true, name: 'late.png' }); await pending
      expect(generate).not.toHaveBeenCalled()
      expect(tools.inpaintOriginalUrl.value).toBeNull()
      scope.stop()
    }
  })
})

it('rejects native masked requests before upload and submits explicitly selected whole-image redraw', async () => {
  const { deps, tools, generate, flash } = harness(true)
  deps.animaState.value.provider = 'native'
  await tools.handleInpaintSubmit(payload)
  expect(apiClient.request).not.toHaveBeenCalled()
  expect(generate).not.toHaveBeenCalled()
  expect(flash).toHaveBeenLastCalledWith(expect.stringContaining('明确选择整图重绘'))
  const captured = deps.captureAnimaSubmission()!
  vi.mocked(deps.captureAnimaSubmission).mockReturnValueOnce({ ...captured, request: { ...captured.request, teaCache: true } })
  await tools.handleInpaintSubmit({ ...payload, editMode: 'whole' })
  expect(apiClient.request).not.toHaveBeenCalled()
  expect(flash).toHaveBeenLastCalledWith(expect.stringContaining('校准档'))
  await tools.handleInpaintSubmit({ ...payload, editMode: 'whole' })
  expect(apiClient.request).toHaveBeenCalledTimes(1)
  const request = generate.mock.calls[0][0]
  expect(request).toMatchObject({ initImage: 'source.png', denoisingStrength: 0.6, teaCache: false, negative: 'blur' })
  expect(request).not.toHaveProperty('maskPrompt')
  expect(request).not.toHaveProperty('maskThreshold')
  expect(request).not.toHaveProperty('maskImage')
  expect(request).not.toHaveProperty('growMaskBy')
})

it('submits native manual mask without automatic recognition fields', async () => {
  const { deps, tools, generate } = harness(true)
  deps.animaState.value.provider = 'native'
  vi.mocked(apiClient.request)
    .mockResolvedValueOnce({ ok: true, name: 'source.png' })
    .mockResolvedValueOnce({ ok: true, name: 'mask.png' })
  await tools.handleInpaintSubmit({ ...payload, editMode: 'masked', maskBlob: new Blob(['mask']) })
  expect(apiClient.request).toHaveBeenCalledTimes(2)
  const request = generate.mock.calls[0][0]
  expect(request).toMatchObject({ initImage: 'source.png', maskImage: 'mask.png', growMaskBy: 12, teaCache: false })
  expect(request).not.toHaveProperty('maskPrompt')
  expect(request).not.toHaveProperty('maskThreshold')
})

it('preserves explicitly enabled native TeaCache in inpaint and checks the resolved model profile', async () => {
  const { deps, tools, generate, flash } = harness(true)
  deps.animaState.value.provider = 'native'
  deps.animaState.value.models = deps.animaState.value.models.map(model => ({ ...model,
    capabilities: { negative: true, lora: true, characterIdentity: true, experimental: true, ...model.capabilities, teaCache: true },
    teaCacheProfile: { support: 'experimental-candidate', readiness: 'profile-files-only', validation: 'on-load', performanceVerified: false, qualityVerified: false },
  }))
  const captured = deps.captureAnimaSubmission()!
  vi.mocked(deps.captureAnimaSubmission).mockReturnValue({ ...captured, request: { ...captured.request, teaCache: true } })
  deps.animaState.value.models[1].teaCacheProfile!.readiness = 'missing'
  await tools.handleInpaintSubmit({ ...payload, editMode: 'whole' })
  expect(generate).not.toHaveBeenCalled()
  expect(flash).toHaveBeenLastCalledWith(expect.stringContaining('缺少所选模型'))
  deps.animaState.value.models[1].teaCacheProfile!.readiness = 'profile-files-only'
  await tools.handleInpaintSubmit({ ...payload, editMode: 'whole' })
  expect(generate.mock.calls[0][0]).toMatchObject({ modelId: 'base-model', teaCache: true })
})

it('submits native automatic masks only after local resource readiness and keeps the frozen mask parameters', async () => {
  const { deps, tools, generate } = harness(true)
  deps.animaState.value.provider = 'native'
  deps.animaState.value.automaticMaskAvailable = true
  const automatic = { ...payload, maskPrompt: 'jacket | sleeves', maskThreshold: 0.65, growMaskBy: 4 }
  const pending = tools.handleInpaintSubmit(automatic)
  automatic.maskPrompt = 'changed later'
  automatic.maskThreshold = 0.2
  await pending
  expect(apiClient.request).toHaveBeenCalledOnce()
  expect(generate.mock.calls[0][0]).toMatchObject({ initImage: 'source.png', maskPrompt: 'jacket | sleeves', maskThreshold: 0.65, growMaskBy: 4, teaCache: false })
  expect(generate.mock.calls[0][0]).not.toHaveProperty('maskImage')
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import { useAnimaInpaint, type AnimaInpaintDeps } from './useAnimaInpaint'
import { ANIMA_LORA_BY_CHARACTER } from './useAnimaSession'
import { apiClient } from '@/api/client'
import type { InpaintSubmitPayload } from '@/components/AnimaInpaintModal.vue'

vi.mock('@/api/client', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/client')>(),
  apiClient: { request: vi.fn() },
}))

function harness(popular = false) {
  const generate = vi.fn().mockResolvedValue(undefined)
  const flash = vi.fn()
  const deps = {
    pb: { char: 'nene', flash }, drawEngine: ref('anima'),
    animaState: ref({
      modelId: 'character-model', width: 832, height: 1216, loraStrength: 0.75,
      models: [
        { id: 'character-model', sizes: ['832x1216'] },
        { id: 'base-model', sizes: ['1024x1024'], capabilities: { noLora: true } },
      ],
    }),
    displayResultUrl: computed(() => 'blob:original'), generateAnima: generate,
    isPopular: computed(() => popular), popularIdentityTokens: computed(() => ['example_character', 'blue_eyes']),
  } as unknown as AnimaInpaintDeps
  const tools = useAnimaInpaint(deps)
  tools.inpaintOpen.value = true
  return { deps, tools, generate, flash }
}

const payload: InpaintSubmitPayload = {
  imageBlob: new Blob(['original']), maskBlob: null, maskPrompt: 'clothing', maskThreshold: 0.4,
  newOutfitPrompt: 'blue jacket', negativePrompt: 'blur', denoisingStrength: 0.6, growMaskBy: 12, seed: 0,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(apiClient.request).mockResolvedValue({ ok: true, name: 'source.png' })
})

describe('换装提交按操作加载', () => {
  it('初始化不上传图片，确认后保留工作室角色、遮罩与完整生成参数', async () => {
    const { tools, generate } = harness()
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
    })
    expect(tools.inpaintOpen.value).toBe(false)
    expect(tools.inpaintOriginalUrl.value).toBe('blob:original')
  })

  it('freezes model and LoRA state before the asynchronous source upload', async () => {
    const { deps, tools, generate } = harness()
    let resolveUpload!: (value: object | PromiseLike<object>) => void
    vi.mocked(apiClient.request).mockImplementationOnce(() => new Promise(resolve => { resolveUpload = resolve }))
    const pending = tools.handleInpaintSubmit(payload)
    await vi.waitFor(() => expect(apiClient.request).toHaveBeenCalled())
    deps.animaState.value.modelId = 'base-model'
    deps.animaState.value.loraStrength = 0.1
    resolveUpload({ ok: true, name: 'source.png' })
    await pending
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'character-model', loraStrength: 0.75 }))
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
    })
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
})

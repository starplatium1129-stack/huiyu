import { defineComponent, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { useGeneratedSceneCapture } from './useGeneratedSceneCapture'
import type { AnimaGenerationState, AnimaResultContext } from '@/types/anima'
import type { DrawEngine } from '@/types/promptHistory'
const fetchImage = vi.hoisted(() => vi.fn())
vi.mock('@/platform/runtimeUrl', () => ({ runtimeFetch: fetchImage }))
let wrapper: ReturnType<typeof mount>
afterEach(() => { wrapper?.unmount(); vi.restoreAllMocks(); vi.unstubAllGlobals(); fetchImage.mockReset() })
function setup(context: AnimaResultContext | null) {
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:owned'), revokeObjectURL: vi.fn() })
  const deps = { engine: ref<DrawEngine>('sd'), url: ref('blob:result'), busy: ref(false),
    anima: ref({} as AnimaGenerationState), sdContext: ref(context), sdPrompt: ref<string | undefined>('original prompt'), flash: vi.fn() }
  let flow!: ReturnType<typeof useGeneratedSceneCapture>
  wrapper = mount(defineComponent({ setup() { flow = useGeneratedSceneCapture(deps); return () => null } }))
  return { deps, flow }
}
it('freezes completed identity and recipe before image loading, then releases its own URL', async () => {
  let finish!: (value: Response) => void
  fetchImage.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve }))
  const { deps, flow } = setup({ char: 'nene', story: 'original story', history: { seed: 0, negative: '', cfg: 0, size: '1024x1024' } })
  const pending = flow.captureScene()
  deps.sdContext.value = { char: 'natsume', story: 'later story' }; deps.sdPrompt.value = 'later prompt'
  finish(new Response(new Blob(['image'], { type: 'image/png' })))
  await pending
  expect(flow.capturedScene.value?.recipe).toMatchObject({ character: 'nene', story: 'original story', prompt: 'original prompt', seed: 0, cfg: 0 })
  flow.closeSceneCapture()
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:owned')
})
it('refuses results without completed context instead of reading live form defaults', async () => {
  const { deps, flow } = setup(null)
  await flow.captureScene()
  expect(flow.capturedScene.value).toBeNull()
  expect(deps.flash).toHaveBeenCalled()
  expect(fetchImage).not.toHaveBeenCalled()
})

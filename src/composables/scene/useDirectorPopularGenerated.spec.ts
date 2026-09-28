import { reactive, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useDirectorPopular, type UseDirectorPopularInput } from './useDirectorPopular'

function setup() {
  const pb = reactive({ subject: { kind: 'studio' }, char: 'nene', sceneId: 'saved', directorMode: 'basic',
    activeScene: { generatedRecipe: { version: 1 } }, sceneBlueprints: [], isPopular: false, popularCharacters: [], sdModelName: '' })
  const input = { pb, drawEngine: ref('krea2'), animaState: ref({ modelId: 'original-krea', loraId: '' }), generationBusy: ref(false),
    sd: { models: ref([]), checkpoint: ref('') }, setDrawEngine: vi.fn(), applyModel: vi.fn(), patchAnimaState: vi.fn(),
    refreshAnimaBackend: vi.fn().mockResolvedValue(undefined), applyRecommendedSize: vi.fn(), flash: vi.fn(), sdSize: ref('1024x1024'),
  } as unknown as UseDirectorPopularInput
  return { pb, input, flow: useDirectorPopular(input) }
}
describe('saved scene recommendation ownership', () => {
  it('only refreshes recommendations for generated scenes instead of replacing their original Krea model', async () => {
    const { input, flow } = setup()
    flow.syncManagedRoute()
    await vi.dynamicImportSettled()
    expect(input.setDrawEngine).not.toHaveBeenCalled()
    expect(input.applyModel).not.toHaveBeenCalled()
    await flow.applyManagedRoute({ silent: true })
    expect(input.applyModel).not.toHaveBeenCalled()
  })
  it('drops an old asynchronous recommendation after the user selects another scene', async () => {
    const { input, flow, pb } = setup()
    const pending = flow.applyManagedRoute()
    pb.sceneId = 'another-saved'
    await pending
    expect(input.setDrawEngine).not.toHaveBeenCalled()
    expect(input.patchAnimaState).not.toHaveBeenCalled()
  })
  it('still permits explicitly applying a recommendation to the current generated scene', async () => {
    const { input, flow } = setup()
    await flow.applyManagedRoute()
    expect(input.setDrawEngine).toHaveBeenCalledWith('anima', expect.anything())
    expect(input.applyModel).toHaveBeenCalled()
  })
})

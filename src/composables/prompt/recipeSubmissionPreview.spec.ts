import { expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { previewRecipeSubmission, type RecipePreviewContext } from './recipeSubmissionPreview'
import { useDirectorEngine, type UseDirectorEngineInput } from '@/composables/scene/useDirectorEngine'

it('does not turn a historical SD recipe into a new submission preview', () => {
  const request = vi.fn()
  expect(previewRecipeSubmission({ engine: ref('sd'), animaRequest: request })).toBeNull()
  expect(request).not.toHaveBeenCalled()
})
it('Anima preview returns the same request while keeping form state and validation feedback untouched', () => {
  const patch = vi.fn(), flash = vi.fn()
  const profile = ref({ id: 'fixture', engine: 'krea2', model_id: 'fixture' })
  const input = { pb: { isPopular: false, char: 'nene', showMatureScenes: false }, drawEngine: ref('krea2'),
    animaState: ref({ family: 'krea2', modelId: 'fixture', models: [], loras: [], width: 1024, height: 1024, steps: 20, cfg: 0, seed: 0 }),
    modelProfile: profile, modelProfileView: profile, livePrompt: ref('compiled caption'), effectiveNegative: ref(''),
    patchAnimaState: patch, flash } as unknown as UseDirectorEngineInput
  const engine = useDirectorEngine(input)
  const context = { engine: input.drawEngine, animaRequest: () => engine.buildAnimaRequest(true) } satisfies RecipePreviewContext
  const preview = previewRecipeSubmission(context)
  expect(preview).toMatchObject({ engine: 'krea2', seed: 0, cfg: 0, prompt: 'compiled caption', negative: '' })
  expect(patch).not.toHaveBeenCalled()
  expect(flash).not.toHaveBeenCalled()
  expect(engine.buildAnimaRequest()).toMatchObject({ prompt: preview?.prompt, negative: preview?.negative, cfg: preview?.cfg })
  expect(patch).toHaveBeenCalledOnce()
  profile.value.model_id = 'unavailable'
  flash.mockClear(); patch.mockClear()
  expect(previewRecipeSubmission(context)).toBe(null)
  expect(flash).not.toHaveBeenCalled()
  expect(patch).not.toHaveBeenCalled()
})

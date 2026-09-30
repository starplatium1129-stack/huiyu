import { onBeforeUnmount, onDeactivated, ref, shallowRef, type Ref } from 'vue'
import type { AnimaGenerationState, AnimaResultContext } from '@/types/anima'
import type { DrawEngine, HistorySnapshot } from '@/types/promptHistory'
import type { CapturedSceneFacts } from './generatedSceneCaptureAction'

export interface GeneratedSceneCapture {
  recipe: HistorySnapshot
  image: Blob
  previewUrl: string
}

interface Dependencies {
  engine: Ref<DrawEngine>
  url: Ref<string>
  busy: Ref<boolean>
  anima: Ref<AnimaGenerationState>
  sdContext: Ref<AnimaResultContext | null>
  sdPrompt: Ref<string | undefined>
  flash: (message: string) => void
}

/** Own the clicked result, including its image, independently of later form edits. */
export function useGeneratedSceneCapture(deps: Dependencies) {
  const capturedScene = shallowRef<GeneratedSceneCapture | null>(null)
  const capturingScene = ref(false)
  let controller: AbortController | null = null

  function closeSceneCapture() {
    controller?.abort()
    controller = null
    if (capturedScene.value) URL.revokeObjectURL(capturedScene.value.previewUrl)
    capturedScene.value = null
  }
  onBeforeUnmount(closeSceneCapture)
  onDeactivated(closeSceneCapture)

  async function captureScene() {
    if (capturingScene.value || capturedScene.value || deps.busy.value || !deps.url.value) return
    const url = deps.url.value
    const engine = deps.engine.value
    const result = engine === 'sd' ? null : deps.anima.value.result
    const context = engine === 'sd' ? deps.sdContext.value : deps.anima.value.resultContext
    const meta = result?.metadata
    const prompt = engine === 'sd' ? deps.sdPrompt.value : meta?.prompt
    // Never substitute current panel settings for missing result facts.
    if (!context || !prompt || (engine !== 'sd' && (!result || !meta))) {
      deps.flash('这张图缺少完整的生成记录，请使用新生成的成片创建场景')
      return
    }
    // Freeze before loading the click-only action; panel edits during the import
    // must not change the selected result's identity or recipe.
    const facts: CapturedSceneFacts = JSON.parse(JSON.stringify({ context, meta, prompt }))
    const imageBlob = result?.blob
    const abort = new AbortController()
    controller = abort
    capturingScene.value = true
    const timeout = setTimeout(() => abort.abort(), 30_000)
    try {
      const { loadGeneratedSceneCapture } = await import('./generatedSceneCaptureAction')
      if (abort.signal.aborted) return
      const captured = await loadGeneratedSceneCapture(facts, url, abort.signal, imageBlob)
      if (!captured || abort.signal.aborted) return
      capturedScene.value = { ...captured, previewUrl: URL.createObjectURL(captured.image) }
    } catch (error) {
      if (controller === abort) deps.flash(error instanceof Error ? error.message : '无法读取成片')
    } finally {
      clearTimeout(timeout)
      if (controller === abort) controller = null
      capturingScene.value = false
    }
  }
  return { capturedScene, capturingScene, captureScene, closeSceneCapture }
}

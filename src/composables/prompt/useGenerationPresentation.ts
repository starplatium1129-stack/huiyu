import { computed } from 'vue'
import type { AnimaPhase } from '@/types/anima'
import type { useDirectorEngine } from '@/composables/scene/useDirectorEngine'
import { useTaskCenter } from '@/composables/useTaskCenter'

export interface GenerationPresentation {
  phase: AnimaPhase | 'preparing'
  message: string
  progress: number | null
  needsReview: boolean
  completed: boolean
  canRetryCancellation: boolean
  review(): void
}

/** Presentation follows receipts and preparation; it never advances task state. */
export function useGenerationPresentation(engine: Pick<ReturnType<typeof useDirectorEngine>,
  'generationPhase' | 'generationStatusText' | 'generationProgress' | 'generationNeedsReview' | 'generationError'>,
  preparation: () => string, completed: () => boolean, review: () => void = openGenerationTasks,
) {
  return computed<GenerationPresentation>(() => {
    const preparing = preparation(), phase = preparing ? 'preparing' : engine.generationPhase.value
    const needsReview = !preparing && engine.generationNeedsReview.value
    const value = engine.generationProgress.value
    // Provider node names remain diagnostic data, not workbench progress copy.
    const runningMessage = phase === 'running' && !needsReview ? '正在绘制…' : ''
    return {
      phase, needsReview, review, completed: !preparing && phase === 'succeeded' && completed(),
      canRetryCancellation: phase === 'cancelling' && Boolean(engine.generationError.value),
      message: preparing || runningMessage || engine.generationStatusText.value || ({ submitting: '正在提交生成…', cancelling: '正在停止，等待确认…' } as Partial<Record<AnimaPhase, string>>)[phase as AnimaPhase] || '',
      progress: phase === 'running' && typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null,
    }
  })
}

export function openGenerationTasks() { useTaskCenter().opened.value = true }

import { useTrackedTask } from '@/composables/useTaskCenter'
import { generationTask } from '@/utils/generationTask'
import type { useAnimaSession } from './useAnimaSession'
import type { useSDGenerate } from './useSDGenerate'

export function useDrawingTaskTracking(sd: ReturnType<typeof useSDGenerate>, anima: ReturnType<typeof useAnimaSession>) {
  useTrackedTask(() => {
    const state = anima.state.value
    const phase = state.phase
    const task = generationTask(phase === 'running' ? state.backendStatus || phase : phase, state.progress)
    return { kind: 'image', title: state.family === 'krea2' ? 'Krea 2 绘图' : 'Anima 绘图', status: task.taskStatus, stage: task.stage, route: '/prompt-builder', resultRoute: state.result ? '/prompt-builder' : undefined, message: state.errorMsg || state.progressText || task.label, progress: task.progress }
  }, { cancel: anima.cancel })
  useTrackedTask(() => {
    const task = generationTask(sd.taskState.value, sd.progress.value, 'percent')
    return { kind: 'image', title: 'SD 绘图', route: '/prompt-builder', resultRoute: sd.resultUrl.value ? '/prompt-builder' : undefined, status: task.taskStatus, stage: task.stage, message: sd.errorMsg.value || sd.statusText.value, progress: task.progress }
  }, { cancel: sd.cancel })
}

export type GenerationStage = 'idle' | 'submitting' | 'queued' | 'loading' | 'generating' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'unknown'
export type GenerationStatus = 'idle' | 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'
const stages: Record<string, GenerationStage> = {
  idle: 'idle', pending: 'queued', queued: 'queued', submitting: 'submitting', loading: 'loading',
  running: 'generating', generating: 'generating', cancelling: 'cancelling',
  succeeded: 'completed', completed: 'completed', failed: 'failed', cancelled: 'cancelled',
}
export const GENERATION_STAGE_LABELS: Record<GenerationStage, string> = {
  idle: '待开始', submitting: '提交中', queued: '排队中', loading: '模型加载中', generating: '生成中',
  cancelling: '取消中', completed: '已完成', failed: '失败', cancelled: '已停止', unknown: '待检查',
}

/** Backend phase is authoritative; never infer model loading from elapsed time. */
export function generationTask(state: string, progress?: number | null, unit: 'fraction' | 'percent' = 'fraction') {
  const stage = stages[state] ?? 'unknown'
  const status: GenerationStatus = stage === 'submitting' || stage === 'queued' ? 'pending'
    : stage === 'generating' || stage === 'loading' || stage === 'cancelling' ? 'running'
    : stage === 'completed' ? 'completed' : stage
  const active = status === 'pending' || status === 'running'
  return {
    stage, status, active,
    // Task center's legacy summaries keep their persisted status vocabulary.
    taskStatus: active ? 'running' as const : status === 'completed' ? 'succeeded' as const : status === 'unknown' ? 'interrupted' as const : status,
    progress: typeof progress === 'number' && Number.isFinite(progress)
      ? Math.max(0, Math.min(100, progress * (unit === 'fraction' ? 100 : 1))) : null,
    label: GENERATION_STAGE_LABELS[stage],
  }
}

export function canExecuteVideo(model: { available: boolean; executable: boolean; modes: readonly string[] } | null | undefined, mode: string, online: boolean) {
  return online && model?.available === true && model.executable === true && model.modes.includes(mode)
}

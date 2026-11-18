import { computed, type Ref } from 'vue'
import type { VideoJob } from '@/api/videoApi'

export function formatSeconds(total: number) {
  const safe = Math.max(0, Math.round(total))
  const minutes = Math.floor(safe / 60)
  const seconds = safe % 60
  return minutes ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`
}

export function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(timestamp)
}

export function useVideoJobProgress(job: Readonly<Ref<VideoJob | null>>) {
  const progressPercent = computed(() => {
    const current = job.value
    if (current?.status === 'succeeded') return 100
    if (!current || current.needsReview || current.status !== 'running' || typeof current.progress !== 'number') return null
    return Math.max(0, Math.min(100, Math.round(current.progress * 100)))
  })

  /** 运行时间异常预警：超过预估 1.5× 提示、2.5× 判疑似卡死。 */
  const progressWarning = computed<{ level: 'warn' | 'danger'; text: string } | null>(() => {
    const current = job.value
    if (!current || current.needsReview || current.status !== 'running' || !current.estimatedSeconds) return null
    const ratio = current.elapsedSeconds / current.estimatedSeconds
    if (ratio >= 2.5) {
      return {
        level: 'danger',
        text: `运行时间异常：已运行 ${formatSeconds(current.elapsedSeconds)}，超过预估 ${formatSeconds(current.estimatedSeconds)} 的 2.5 倍。请查看任务日志，必要时取消任务。`,
      }
    }
    if (ratio >= 1.5) {
      return {
        level: 'warn',
        text: `运行时间异常：已 ${formatSeconds(current.elapsedSeconds)}，预估 ${formatSeconds(current.estimatedSeconds)}。可查看任务日志确认进度。`,
      }
    }
    return null
  })

  const jobStatusLabel = computed(() => job.value?.needsReview ? '状态待核对' : ({
    queued: '排队中',
    running: '生成中',
    cancelling: '取消中',
    succeeded: '已完成',
    failed: '生成失败',
    cancelled: '已取消',
  })[job.value?.status || 'queued'])
  return { progressPercent, progressWarning, jobStatusLabel }
}

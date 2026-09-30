import { SD_PENDING_QUEUE_KEY } from '@/utils/storageKeys'
import { profileDraftStorage, profileRuntimeActive, flushProfileWrites } from '@/platform/web/profileStorage'
import type { SDQueueJob } from '@/composables/generation/useSDQueue'

function authority() {
  if (!profileRuntimeActive()) throw new Error('工作区队列尚未连接，请重新连接后再操作')
}
function decode(raw: string | null): SDQueueJob[] {
  if (!raw) return []
  const value = JSON.parse(raw)
  if (value?.version !== 1 || !Array.isArray(value.jobs) || value.jobs.some((job: SDQueueJob) =>
    !job || typeof job.id !== 'string' || typeof job.prompt !== 'string'
    || (job.attempt && (typeof job.attempt.key !== 'string' || !job.attempt.key || typeof job.attempt.submitted !== 'boolean')))) {
    throw new Error('已保存的队列无法读取，请保留窗口并检查工作区')
  }
  return value.jobs
}
export function createPendingSdQueueStorage() {
  let observed: string | null = null
  return {
    read() { authority(); observed = profileDraftStorage.getItem(SD_PENDING_QUEUE_KEY); return decode(observed) },
    async persist(jobs: readonly SDQueueJob[]) {
      authority()
      // A profile refresh may advance its shared revision independently of this
      // page. Do not borrow that revision to overwrite a changed queue body.
      if (profileDraftStorage.getItem(SD_PENDING_QUEUE_KEY) !== observed) throw new Error('待处理队列已更新，请刷新窗口后重试')
      const next = JSON.stringify({ version: 1, jobs })
      profileDraftStorage.setItem(SD_PENDING_QUEUE_KEY, next)
      observed = next
      await flushProfileWrites()
    },
  }
}

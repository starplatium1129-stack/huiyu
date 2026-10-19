import { fetchResultImage, waitForDirectImageJob } from '@/api/directImageJobs'
import { acceptDirectImageRequest, cancelDirectImageRequest } from '@/api/directImageRequests'
import { DirectRequestRejected } from '@/api/directGenerationRequests'
import { AcceptedTaskTerminalError, TaskSubmissionRejected } from '@/api/acceptedTaskOutcome'
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'
import { getDesktopRuntime, onDesktopRuntime } from '@/platform/desktop/runtime'
import { imageMediaSession } from '@/platform/imageMediaSession'
import { withArtworkStaging } from '@/storage/artworkSession'
import { ref, onScopeDispose, type Ref } from 'vue'
import { useTrackedTask } from '@/composables/useTaskCenter'
import { importVideoImage, uploadVideoImage, type VideoImageUploadResponse } from '@/api/videoApi'
import { artworkRepository } from '@/storage/artworkRepository'
import { hasRuntimeTasks, submitRuntimeTask, getRuntimeTaskByKey, waitForRuntimeTask, fetchRuntimeResult, runtimeResultPath, cancelRuntimeTaskKey } from '@/api/runtimeTasks'
import { readFirstFrameRequest, type FirstFrameRequest } from '@/types/firstFrameRequest'
import type { ShotDraft } from './shotListTypes'

const KREA2_SIZE_BY_ASPECT = {
  landscape: { width: 1536, height: 1024 }, portrait: { width: 1024, height: 1536 }, square: { width: 1024, height: 1024 },
} as const
type VideoAspect = keyof typeof KREA2_SIZE_BY_ASPECT
function authority(transport: FirstFrameRequest['transport']) {
  if (transport === 'direct') return JSON.stringify([location.origin, runtimeResourceIdentity()])
  const workspace = getDesktopRuntime().bootstrap?.runtime?.workspace
  return JSON.stringify([workspace?.workspaceId, workspace?.principalId])
}

/** Each shot owns a saved acceptance key; generation, observation and mounting are separate. */
export function useShotFirstFrames(options: {
  shots: Ref<ShotDraft[]>; frameRequests: Map<ShotDraft, AbortController>
  persist: () => Promise<void>; onError: (message: string) => void
}) {
  const firstFrameBusy = ref(false), firstFrameProgress = ref('')
  const taskStatus = ref<'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled'>('idle')
  let controller: AbortController | null = null, disposed = false
  let active: FirstFrameRequest | null = null
  async function cancelFirstFrames() {
    controller?.abort()
    taskStatus.value = 'cancelled'
    const request = active
    if (!request) return
    try {
      if (request.authority !== authority(request.transport)) throw new Error('首帧连接已更换，未向新连接发送取消，请核对原请求。')
      if (request.transport === 'runtime') await cancelRuntimeTaskKey(request.key)
      else await cancelDirectImageRequest('krea2', request.key, runtimeResourceIdentity())
    } catch (error) { options.onError(error instanceof Error ? error.message : '取消意图尚未确认，请重新查询原请求；不会重新生成。') }
  }
  // Leaving only releases observations. The saved request remains recoverable.
  onScopeDispose(() => { disposed = true; controller?.abort() })
  useTrackedTask(() => ({ kind: 'image', title: '分镜首帧生成', route: '/video-studio?mode=shots', status: taskStatus.value, message: firstFrameProgress.value }), { cancel: cancelFirstFrames })

  async function generateFirstFrames(shots: ShotDraft[], aspect: VideoAspect) {
    if (disposed || firstFrameBusy.value) return
    const pending = shots.map((shot, index) => ({ shot, index }))
      .filter(({ shot }) => (shot.firstFramePrompt || shot.firstFrameRequest) && !shot.imageName && !shot.imageId
        && options.shots.value.includes(shot) && !options.frameRequests.has(shot))
      .map(item => {
        const owner = new AbortController()
        options.frameRequests.set(item.shot, owner)
        return { ...item, owner, previous: [item.shot.imageId, item.shot.imageName, item.shot.imageUrl] }
      })
    if (!pending.length) {
      options.onError('没有待生成首帧的镜头；已有图片但尚未挂载时，请在镜头上重试读取，不会重新生成。')
      return
    }
    firstFrameBusy.value = true; taskStatus.value = 'running'
    controller = new AbortController()
    const signal = controller.signal
    const repository = artworkRepository, runtime = runtimeResourceIdentity()
    const mediaSession = imageMediaSession()
    let mediaCurrent = true
    const sameSource = () => mediaCurrent && repository === artworkRepository && mediaSession === imageMediaSession()
    const stopRuntime = onDesktopRuntime(() => { if (!sameSource()) mediaCurrent = false })
    let failed = 0, completed = 0
    try {
      await withArtworkStaging(async () => {
        signal.throwIfAborted()
        for (let i = 0; i < pending.length; i++) {
          signal.throwIfAborted()
          if (runtime !== runtimeResourceIdentity() || !sameSource())
            throw new Error('首帧连接已更换，已停止后续镜头；请在原连接核对原请求。')
          const { shot, owner, previous } = pending[i]
          const current = () => !disposed && !signal.aborted && !owner.signal.aborted
            && sameSource() && runtime === runtimeResourceIdentity()
            && (!active || active.authority === authority(active.transport))
            && options.frameRequests.get(shot) === owner && options.shots.value.includes(shot)
            && [shot.imageId, shot.imageName, shot.imageUrl].every((value, index) => value === previous[index])
          if (!current()) continue
          const frameSignal = AbortSignal.any([signal, owner.signal])
          firstFrameProgress.value = `${i + 1}/${pending.length}`
          let ownedImageId = '', fresh = false, submitting = false, attached = false
          try {
            let request = shot.firstFrameRequest && readFirstFrameRequest(shot.firstFrameRequest)
            if (!request || request.state === 'failed' || request.state === 'cancelled') {
              const transport = hasRuntimeTasks() ? 'runtime' : 'direct'
              request = { key: crypto.randomUUID(), transport, authority: authority(transport), state: 'pending',
                input: { prompt: shot.firstFramePrompt || '', modelId: 'krea2-turbo-fp8', ...KREA2_SIZE_BY_ASPECT[aspect] } }
              request = readFirstFrameRequest(request)
              shot.firstFrameRequest = request; fresh = true
              // Fail closed before POST if this row cannot retain its identity.
              await options.persist()
            }
            active = request
            if (request.authority !== authority(request.transport) || (request.transport === 'runtime') !== hasRuntimeTasks())
              throw new Error('首帧请求属于原工作区或连接，请返回原连接核对；不会创建替代任务。')
            frameSignal.throwIfAborted()
            if (!current()) continue
            let blob: Blob, upload: VideoImageUploadResponse, resultAlias = ''
            const markSubmitting = () => { frameSignal.throwIfAborted(); submitting = true }
            if (request.transport === 'runtime') {
              const accepted = fresh
                ? await submitRuntimeTask('creative', request.input, request.key, { role: 'storyboard-first-frame', shotIndex: pending[i].index }, { signal: frameSignal, onSubmitting: markSubmitting })
                : await getRuntimeTaskByKey(request.key, frameSignal)
              if (!accepted) throw new Error('首帧接收状态尚未确认，请再次查询原请求；不会重新生成。')
              const task = await waitForRuntimeTask(accepted.taskId, frameSignal, () => {})
              if (!current()) continue
              shot.firstFrameRequest = { ...request, state: 'succeeded' }; await options.persist()
              if (!current()) continue
              blob = await fetchRuntimeResult(runtimeResultPath(task), frameSignal, task)
              resultAlias = task.resultRefs.find(value => value.index === 0)?.alias || ''
              if (!resultAlias) throw new Error('首帧任务缺少图片凭据')
              if (!current()) continue
              upload = await importVideoImage(task.taskId, resultAlias, 0, frameSignal)
            } else {
              const accepted = await acceptDirectImageRequest('krea2', request.input, request.key, { signal: frameSignal, resume: !fresh, onSubmitting: markSubmitting })
              const job = await waitForDirectImageJob('krea2', accepted.id, frameSignal, { timeoutMs: 240_000, intervalMs: 2500, immediate: true })
              if (!current()) continue
              shot.firstFrameRequest = { ...request, state: 'succeeded' }; await options.persist()
              if (!current()) continue
              blob = await fetchResultImage(job.resultUrl, frameSignal)
              if (!current()) continue
              upload = await uploadVideoImage(blob, undefined, frameSignal)
            }
            if (!current() || repository !== artworkRepository || request.authority !== authority(request.transport)) continue
            const imageId = resultAlias || (ownedImageId = await repository.putImage(blob))
            if (!current()) continue
            const imageUrl = URL.createObjectURL(blob)
            if (shot.imageUrl) URL.revokeObjectURL(shot.imageUrl)
            shot.imageName = upload.name; shot.imageUrl = imageUrl; shot.imageId = imageId
            ownedImageId = ''
            attached = true
            await options.persist()
            completed++
          } catch (error) {
            if (fresh && !submitting) { shot.firstFrameRequest = undefined; await options.persist() }
            if (signal.aborted) throw signal.reason
            if (attached) throw error
            if (!current()) continue
            const rejected = fresh && error instanceof TaskSubmissionRejected && error.requestKey === shot.firstFrameRequest?.key
            if (rejected || error instanceof AcceptedTaskTerminalError || error instanceof DirectRequestRejected) {
              if (shot.firstFrameRequest) shot.firstFrameRequest.state = error instanceof AcceptedTaskTerminalError ? error.status : error instanceof DirectRequestRejected && error.code === 'IMAGE_REQUEST_CANCELLED' ? 'cancelled' : 'failed'
              await options.persist(); failed++; continue
            }
            // Unknown acceptance, observation or result delivery retains the key
            // and stops this batch. The next click only queries this same request.
            throw error
          } finally {
            // A changed workspace cannot authorize cleanup of the old workspace.
            if (ownedImageId && sameSource() && runtime === runtimeResourceIdentity()
              && (!active || active.authority === authority(active.transport)))
              await repository.deleteImage(ownedImageId).catch(error => console.warn('[shots] unattached first frame cleanup failed', ownedImageId, error))
            if (options.frameRequests.get(shot) === owner) options.frameRequests.delete(shot)
            active = null
          }
        }
        if (!disposed && !signal.aborted) {
          if (failed || completed) options.onError(failed ? `${failed} 个镜头首帧失败；重按只重试确证失败项，其余先查询原任务。` : '')
          taskStatus.value = failed ? 'failed' : completed ? 'succeeded' : 'cancelled'
        }
      })
    } catch (error) {
      if (!disposed && !signal.aborted) { taskStatus.value = 'failed'; options.onError(error instanceof Error ? error.message : '首帧生成失败') }
    } finally {
      stopRuntime()
      for (const { shot, owner } of pending) if (options.frameRequests.get(shot) === owner) options.frameRequests.delete(shot)
      controller = null; active = null; firstFrameBusy.value = false; firstFrameProgress.value = ''
    }
  }
  return { firstFrameBusy, firstFrameProgress, generateFirstFrames }
}

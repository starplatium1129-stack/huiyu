import { ApiClientError, apiClient } from './client'
import { acceptVideoRequest, cancelVideoRequest } from './videoRequests'
import { fetchVideoStatus, uploadStudioDialogueAudio, uploadVideoImage, type VideoJob } from './videoApi'
import { videoJobResponse } from './videoApiResponse'
import { hasRuntimeTasks } from './runtimeTaskAuthority'
import {
  decodeStudioVideoBoard,
  gpuQueue,
  type StudioVideoBatch,
  type StudioVideoBoard,
  type StudioVideoPort,
  type StudioVideoRun,
  type StudioVideoTemplate,
} from './studioVideoApi'
import { kvGet, kvUpdate } from '@/platform/web/kvStore'
import { browserStudioVideoKey, recoverLegacyStudioClips } from '@/platform/web/legacyStudioClips'
import { runtimeFetch, runtimeResourceIdentity } from '@/platform/runtimeUrl'
import { newTaskRequestDraft } from '@/storage/taskRequestDraft'
import { tempResultOwner, sameTempResultOwner } from '@/utils/tempResult'
import { imageBlobDigest } from '@/utils/imageBlobDigest'
import type { StudioProjectRepository } from '@/storage/studioProjectRepository'

const wan = 'wan2.2-i2v-a14b-gguf'
const portrait = 'musetalk-1.5'
const modelFor = (mode: StudioVideoRun['settings']['mode']) => (mode === 'dialogue' ? portrait : wan)
const templates: StudioVideoTemplate[] = [
  { id: 'wan22-flf', version: 1, label: 'Wan 2.2 首尾帧', mode: 'first-last' },
  { id: 'wan22-i2v', version: 1, label: 'Wan 2.2 单图', mode: 'first' },
  {
    id: 'dialogue-audio',
    version: 1,
    label: '角色对白 · 配音驱动',
    mode: 'dialogue',
    steps: { fast: 1, standard: 1, quality: 1 },
  },
]
const active = (r: StudioVideoRun) => r.status === 'queued' || r.status === 'running'
function rejected(message: string) {
  return new ApiClientError(message, { kind: 'http', status: 400, responseBody: { submissionNotAccepted: true } })
}

/** The GPU and receipt belong to the native service. IndexedDB keeps the frozen shot and the imported clip. */
export function captureBrowserStudioVideoApi(
  projectId: string,
  repo: StudioProjectRepository
): StudioVideoPort | null {
  let owner: ReturnType<typeof tempResultOwner>
  try {
    owner = tempResultOwner()
  } catch {
    return null
  }
  if (owner.kind !== 'web' || hasRuntimeTasks()) return null
  const resource = runtimeResourceIdentity()
  const key = browserStudioVideoKey(projectId, owner.sourceProfileId)
  function check(signal: AbortSignal) {
    signal.throwIfAborted()
    repo.assertCurrent()
    if (hasRuntimeTasks() || !sameTempResultOwner(owner) || runtimeResourceIdentity() !== resource)
      throw new Error('原浏览器资料或本机连接已变化，请重新打开原项目。')
  }
  function rows(value: unknown): StudioVideoRun[] {
    if (value === null) return []
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('runs' in value))
      throw new Error('这个项目的浏览器视频记录无法读取。')
    return decodeStudioVideoBoard({ templates, runs: value.runs }, projectId).runs
  }
  const read = async () => rows(await kvGet(key))
  async function change(signal: AbortSignal, edit: (saved: StudioVideoRun[]) => StudioVideoRun[]) {
    check(signal)
    return (
      await kvUpdate(key, (raw) => {
        check(signal)
        return { version: 1, runs: edit(rows(raw)) }
      })
    ).runs
  }
  function request(run: StudioVideoRun, input: Record<string, unknown> = {}) {
    return {
      ...newTaskRequestDraft('video', input, false),
      key: 'studio-video-' + run.batchId,
      submitted: true,
      ...(run.taskId ? { taskId: run.taskId } : {}),
    }
  }
  const availability = new Map<string, { checkedAt: number; reason: string }>()
  async function modelStatus(signal: AbortSignal, modelId: string) {
    const cached = availability.get(modelId)
    if (cached && Date.now() - cached.checkedAt < 20_000) return cached.reason
    try {
      const status = await fetchVideoStatus(signal, modelId)
      check(signal)
      const model = status.models.find((m) => m.id === modelId)
      const unavailable =
        status.provider !== 'native'
          ? '请在本机视频设置启用原生引擎。'
          : !model?.available || !model.executable
            ? model?.reason ||
              (modelId === portrait ? '请先准备 MuseTalk 1.5 对白模型。' : '请先准备 Wan 2.2 A14B 图生视频模型。')
            : ''
      availability.set(modelId, { checkedAt: Date.now(), reason: unavailable })
      return unavailable
    } catch (e) {
      check(signal)
      return e instanceof Error ? e.message : '本机视频模型暂时无法读取。'
    }
  }
  async function settle(before: StudioVideoRun, next: StudioVideoRun, signal: AbortSignal) {
    if (
      before.status === next.status &&
      before.taskId === next.taskId &&
      before.clipVersionId === next.clipVersionId &&
      before.cancelRequested === next.cancelRequested &&
      before.gpuRetry?.attempt === next.gpuRetry?.attempt &&
      before.gpuRetry?.cause === next.gpuRetry?.cause &&
      before.error === next.error
    )
      return next
    const { liveProgress, ...durable } = next
    const saved = await change(signal, (current) =>
      current.map((r) => {
        if (r.id !== before.id || !active(r)) return r
        if (r.taskId && durable.taskId && r.taskId !== durable.taskId)
          throw new Error('视频接收编号与已保存的记录不同。')
        if (r.status === 'running' && durable.status === 'queued') return r
        return {
          ...durable,
          taskId: r.taskId || durable.taskId,
          cancelRequested: r.cancelRequested || durable.cancelRequested,
        }
      })
    )
    const stored = saved.find((r) => r.id === before.id)
    return stored && active(stored) ? { ...stored, liveProgress } : stored || next
  }
  async function applyJob(run: StudioVideoRun, job: VideoJob, signal: AbortSignal) {
    check(signal)
    const modelId = modelFor(run.settings.mode)
    if (
      job.provider !== 'native' ||
      job.modelId !== modelId ||
      job.seed !== run.settings.seed ||
      (run.taskId && run.taskId !== job.id)
    )
      throw new Error('视频与原镜头回执不一致。')
    const info = job as VideoJob & {
      previewDataUrl?: string
      progressText?: string
      resultBytes?: number
      resultSha256?: string
      metadata?: { gpuRetry?: StudioVideoRun['gpuRetry'] }
    }
    const next = {
      ...run,
      taskId: job.id,
      gpuRetry: info.metadata?.gpuRetry ?? run.gpuRetry,
      liveProgress: { value: job.progress, message: info.progressText, previewDataUrl: info.previewDataUrl },
      error: job.error,
    }
    if (job.needsReview || job.unknown)
      return settle(
        run,
        { ...next, status: 'running', liveProgress: { ...next.liveProgress, message: '正在核对原任务' } },
        signal
      )
    if (job.status === 'succeeded') {
      const path = '/api/video/jobs/' + encodeURIComponent(job.id) + '/result'
      if (!job.resultAvailable || job.resultUrl !== path) throw new Error('成片正在保存，稍后可继续取回。')
      const versionId = 'studio-clip-' + run.id
      const snapshot = await repo.getProject(projectId)
      const saved = snapshot.versions.find((v) => v.id === versionId)
      if (
        saved &&
        (saved.source.kind !== 'generation' ||
          saved.source.taskId !== job.id ||
          (info.resultSha256 && saved.sha256 !== info.resultSha256))
      )
        throw new Error('成片编号已被其他素材占用。')
      if (!saved) {
        const result = await runtimeFetch(path, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
          redirect: 'error',
        })
        if (!result.ok) throw new Error('视频已生成，读取成片暂时失败。')
        const blob = await result.blob()
        check(signal)
        if (
          (typeof info.resultBytes === 'number' && info.resultBytes !== blob.size) ||
          (info.resultSha256 && (await imageBlobDigest(blob, () => check(signal))).sha256 !== info.resultSha256)
        )
          throw new Error('片段原件校验失败，稍后会重新取回。')
        await repo.importAsset({
          versionId,
          title: run.shotTitle.slice(0, 65) + ' · 视频',
          kind: 'clip',
          blob,
          source: {
            kind: 'generation',
            taskId: job.id,
            outputIndex: 0,
            modelId,
            inputVersionIds: [run.firstVersionId, run.lastVersionId, run.audioVersionId].filter(
              (id): id is string => !!id
            ),
            prompt: run.settings.prompt,
            seed: job.seed,
            width: job.width,
            height: job.height,
          },
        })
      }
      const shot = snapshot.shots.find((item) => item.id === run.shotId)
      if (
        shot &&
        shot.revision === run.shotRevision &&
        shot.currentClipVersionId !== versionId &&
        repo.selectBrowserClip
      ) {
        try {
          await repo.selectBrowserClip(shot, versionId, job.id)
        } catch (error) {
          check(signal)
          const latest = (await repo.getProject(projectId)).shots.find((item) => item.id === shot.id)
          if (!latest || (latest.revision === shot.revision && latest.currentClipVersionId !== versionId))
            throw error
        }
      }
      return settle(run, { ...next, status: 'succeeded', clipVersionId: versionId }, signal)
    }
    return settle(
      run,
      {
        ...next,
        status: job.status === 'cancelling' ? 'running' : job.status,
        cancelRequested: run.cancelRequested || job.status === 'cancelling',
      },
      signal
    )
  }
  async function observe(run: StudioVideoRun, signal: AbortSignal): Promise<StudioVideoRun> {
    const draft = request(run)
    const receipt = await apiClient.request<Record<string, unknown>>(
      '/api/video/requests/' + encodeURIComponent(draft.key),
      {
        signal,
        cache: 'no-store',
        cachePolicy: 'bypass',
        timeoutMs: 15_000,
      }
    )
    check(signal)
    if (receipt.ok !== true || receipt.requestKey !== draft.key) throw new Error('视频接收凭据不匹配。')
    if (receipt.rejected && typeof receipt.rejected === 'object' && 'message' in receipt.rejected)
      return settle(
        run,
        {
          ...run,
          status:
            'code' in receipt.rejected && receipt.rejected.code === 'VIDEO_REQUEST_CANCELLED'
              ? 'cancelled'
              : 'failed',
          error: String(receipt.rejected.message),
        },
        signal
      )
    if (receipt.job === null)
      return receipt.cancelRequested === true
        ? settle(run, { ...run, status: 'cancelled' }, signal)
        : { ...run, statusLabel: '等待原请求回执' }
    return applyJob(run, videoJobResponse(receipt, run.taskId || undefined).job, signal)
  }
  let recoveredLegacy = false
  async function list(signal: AbortSignal): Promise<StudioVideoBoard> {
    check(signal)
    const [saved, motionIssue, audioIssue] = await Promise.all([
      read(),
      modelStatus(signal, wan),
      modelStatus(signal, portrait),
    ])
    const runs: StudioVideoRun[] = []
    for (const run of saved) {
      if (!active(run)) {
        runs.push(run)
        continue
      }
      try {
        runs.push(await observe(run, signal))
      } catch (e) {
        check(signal)
        runs.push({
          ...run,
          statusLabel: '等待核对',
          liveProgress: { message: e instanceof Error ? e.message : '稍后会再读取任务。' },
        })
      }
    }
    check(signal)
    if (!recoveredLegacy)
      recoveredLegacy = await recoverLegacyStudioClips(repo, projectId, runs, () => check(signal))
    check(signal)
    return { templates, runs, modelIssues: { first: motionIssue, 'first-last': motionIssue, dialogue: audioIssue } }
  }
  async function submit(batch: StudioVideoBatch, signal: AbortSignal): Promise<StudioVideoBoard> {
    check(signal)
    const previous = (await read()).find((r) => r.batchId === batch.id)
    if (previous) return list(signal)
    if (batch.shots.length !== 1 || batch.shots[0]?.framePlan)
      throw rejected('浏览器项目可逐镜生成。批量补帧与调度请使用桌面工作区。')
    const choice = batch.shots[0]!
    const modelId = modelFor(choice.mode)
    const reason = await modelStatus(signal, modelId)
    if (reason) throw rejected(reason)
    const data = await repo.getProject(projectId)
    const shot = data.shots.find((s) => s.id === choice.shotId)
    if (
      !shot ||
      shot.revision !== choice.expectedRevision ||
      !shot.firstVersionId ||
      (choice.mode === 'first-last' && !shot.lastVersionId) ||
      (choice.mode === 'dialogue' && !shot.audioVersionId)
    )
      throw rejected('镜头资料已改变，请重新核对首尾帧。')
    const { mode, camera, motion, quality, resolution, seconds } = choice
    const seed = choice.seed ?? crypto.getRandomValues(new Uint32Array(1))[0] >>> 1
    const prompt = choice.prompt?.trim() || shot.prompt.trim() || shot.title
    const lastId = mode === 'first-last' ? shot.lastVersionId : null
    const audioId = mode === 'dialogue' ? shot.audioVersionId : null
    const template = templates.find((t) => t.mode === mode && (!choice.templateId || t.id === choice.templateId))
    if (!template) throw rejected('当前浏览器引擎未提供这个模板。')
    const names: string[] = []
    let audio: Awaited<ReturnType<typeof uploadStudioDialogueAudio>> | undefined
    try {
      for (const id of [shot.firstVersionId, lastId]) {
        if (!id) continue
        const version = data.versions.find((v) => v.id === id)
        if (
          !version ||
          !['image/png', 'image/jpeg', 'image/webp'].includes(version.mime) ||
          version.bytes > 20 * 1024 * 1024
        )
          throw rejected('视频帧请绑定 20 MiB 以内的 PNG、JPEG 或 WebP。')
        const original = await repo.readOriginal(version, signal)
        check(signal)
        const uploaded = await uploadVideoImage(original, 'studio-frame', signal)
        if (uploaded.bytes !== original.size) throw rejected('上传后的帧图大小不一致。')
        names.push(uploaded.name)
      }
      if (audioId) {
        const version = data.versions.find((v) => v.id === audioId)
        if (!version || version.mime !== 'audio/wav' || version.bytes > 20 * 1024 * 1024)
          throw rejected('对白配音需要 20 MiB 以内的 PCM WAV。')
        const original = await repo.readOriginal(version, signal)
        check(signal)
        audio = await uploadStudioDialogueAudio(original, signal)
      }
    } catch (e) {
      check(signal)
      throw rejected(e instanceof Error ? e.message : '镜头原件尚未准备好。')
    }
    const latest = (await repo.getProject(projectId)).shots.find((s) => s.id === shot.id)
    if (latest?.revision !== shot.revision) throw rejected('准备原图期间镜头已改变，请刷新后重新选择。')
    const run: StudioVideoRun = {
      id: batch.id,
      batchId: batch.id,
      projectId,
      shotId: shot.id,
      shotTitle: shot.title,
      shotRevision: shot.revision,
      firstVersionId: shot.firstVersionId,
      lastVersionId: lastId,
      audioVersionId: audioId,
      settings: { mode, camera, motion, quality, resolution, seconds, seed, prompt },
      templateId: template.id,
      templateVersion: template.version,
      status: 'queued',
      createdAt: Date.now(),
      taskId: null,
      clipVersionId: null,
    }
    let inserted = false
    await change(signal, (saved) => {
      if (saved.some((r) => r.batchId === batch.id)) return saved
      if (saved.some((r) => r.shotId === shot.id && active(r))) throw rejected('这个镜头已经有一条在途任务。')
      inserted = true
      return [run, ...saved]
    })
    if (inserted) {
      const draft = request(run, {
        modelId,
        image: names[0],
        ...(lastId ? { lastFrame: names[1] } : {}),
        aspectRatio: 'original',
        ...(audio
          ? {
              drivingAudio: audio.name,
              audioFrames: audio.audioFrames,
              duration: [2, 3, 5, 10, 15].find((s) => s * 25 >= audio.audioFrames),
              steps: 1,
            }
          : { wanResolution: resolution, duration: seconds, steps: quality === 'quality' ? 8 : 4 }),
        seed,
        prompt,
        camera: { fixed: 'still', push: 'push', pull: 'pull', pan: 'pan-tripod', track: 'track-lateral' }[camera],
        motion: { low: 'subtle', medium: 'natural', high: 'expressive' }[motion],
        quality: quality === 'quality' ? 'fine' : quality,
      })
      try {
        check(signal)
        const job = await acceptVideoRequest(draft, { signal })
        if ('shots' in job) throw new Error('镜头回执类型不匹配。')
        await applyJob(run, job, signal)
      } catch {
        check(signal) /* The saved identity is reconciled by list, including definitive rejections. */
      }
    }
    return list(signal)
  }
  return {
    kind: 'browser',
    journalKey: key + '-pending',
    list,
    submit,
    async selectCurrent(shotId, runId, expectedRevision, signal) {
      check(signal)
      const run = (await read()).find(
        (item) => item.id === runId && item.shotId === shotId && item.status === 'succeeded'
      )
      if (!run?.clipVersionId || !run.taskId || !repo.selectBrowserClip)
        throw new Error('这个镜头没有可恢复的成片。')
      const shot = (await repo.getProject(projectId)).shots.find((item) => item.id === shotId)
      if (!shot) throw new Error('原镜头已失效。')
      if (shot.currentClipVersionId !== run.clipVersionId) {
        if (shot.revision !== expectedRevision) throw new Error('镜头资料已改变，请刷新后重新选择片段。')
        check(signal)
        await repo.selectBrowserClip(shot, run.clipVersionId, run.taskId)
      }
      return list(signal)
    },
    async cancel(id, signal) {
      check(signal)
      const run = (await read()).find((r) => r.id === id)
      if (run && active(run)) {
        const job = await cancelVideoRequest(request(run), signal)
        if (job && 'shots' in job) throw new Error('取消回执类型不匹配。')
        if (job) {
          const cancelling = await settle(run, { ...run, cancelRequested: true }, signal)
          if (active(cancelling)) await applyJob(cancelling, job, signal)
        } else await settle(run, { ...run, status: 'cancelled' }, signal)
      }
      return list(signal)
    },
    async queue(signal, paused) {
      check(signal)
      const result = await gpuQueue(signal, paused)
      check(signal)
      return result
    },
    async preview() {
      throw new Error('浏览器中间帧由原生服务直接返回。')
    },
  }
}

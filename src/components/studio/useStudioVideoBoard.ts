import { computed, onActivated, onDeactivated, onMounted, onScopeDispose, ref, shallowRef } from 'vue'
import { ApiClientError } from '@/api/client'
import { captureBrowserStudioVideoApi } from '@/api/browserStudioVideoApi'
import {
  captureStudioVideoApi,
  validVideoBatch,
  validStudioExportInput,
  type StudioExportInput,
  type StudioExportRecord,
  type GpuQueue,
  type StudioVideoBatch,
  type StudioVideoBoard,
  type StudioVideoInput,
  type StudioVideoRun,
} from '@/api/studioVideoApi'
import {
  profileLocalStorage,
  profileDraftStorage,
  writeProfileDraft,
  writeProfileLocal,
} from '@/platform/web/profileStorage'
import type { StudioProjectRepository, StudioProjectSnapshot } from '@/storage/studioProjectRepository'

interface BoardProps {
  data: StudioProjectSnapshot
  repo: StudioProjectRepository
  refresh: () => Promise<void>
}
type Submission = StudioVideoBatch | StudioExportInput
function accepted(board: StudioVideoBoard, submission: Submission) {
  return 'options' in submission
    ? board.exports?.some((item) => item.id === submission.id)
    : board.runs.some((run) => run.batchId === submission.id)
}
export const activeRun = (run: StudioVideoRun) => run.status === 'queued' || run.status === 'running'
export const videoError = (error: unknown) => (error instanceof Error ? error.message : '分镜视频暂时无法读取。')

export function useStudioVideoBoard(props: BoardProps) {
  const api =
    captureStudioVideoApi(props.data.project.id) ?? captureBrowserStudioVideoApi(props.data.project.id, props.repo)
  const journal = api?.kind === 'browser' ? profileDraftStorage : profileLocalStorage
  const writeJournal = api?.kind === 'browser' ? writeProfileDraft : writeProfileLocal
  const board = shallowRef<StudioVideoBoard>(),
    queue = shallowRef<GpuQueue>()
  const pending = shallowRef<Submission | null>(null)
  const reading = ref(false),
    busy = ref(false),
    notice = ref(''),
    error = ref(''),
    queueError = ref(''),
    readError = ref('')
  const journalError = ref('')
  const prepared = new Set<string>()
  const life = new AbortController()
  let active = false,
    timer: ReturnType<typeof setTimeout> | undefined,
    observer: AbortController | undefined
  const activeShots = computed(() => new Set(board.value?.runs.filter(activeRun).map((run) => run.shotId)))
  function check() {
    life.signal.throwIfAborted()
    props.repo.assertCurrent()
  }
  function readPending() {
    if (!api) return null
    const raw = journal.getItem(api.journalKey)
    if (!raw) return null
    try {
      const data: unknown = JSON.parse(raw)
      if (validVideoBatch(data) || validStudioExportInput(data)) return data
    } catch {
      /* A damaged receipt must not hide the project history. */
    }
    throw new Error('上次提交的批次记录无法读取，请先核对项目生成历史。')
  }
  async function clearPending(id: string) {
    check()
    if (!api || pending.value?.id !== id) return
    if (readPending()?.id === id) await writeJournal(api.journalKey, null).confirm()
    check()
    pending.value = readPending()
  }
  async function accept(next: StudioVideoBoard) {
    check()
    const firstRead = !board.value
    const previous = new Set(board.value?.runs.filter(activeRun).map((run) => run.id))
    const ended = next.runs.filter((run) => previous.has(run.id) && !activeRun(run))
    const activeExports = new Set(
      board.value?.exports
        ?.filter((item) => item.status === 'running' || item.status === 'queued')
        .map((item) => item.id)
    )
    const endedExports =
      next.exports?.filter(
        (item) => activeExports.has(item.id) && item.status !== 'running' && item.status !== 'queued'
      ) || []
    board.value = next
    readError.value = ''
    const saved = pending.value
    if (saved && accepted(next, saved)) await clearPending(saved.id)
    check()
    const known = new Set(props.data.versions.map((version) => version.id))
    const bindings: string[] = []
    for (const run of next.runs) {
      for (const child of run.preparation?.tasks || []) {
        const binding = run.id + '-' + child.slot
        if (child.status === 'succeeded' && !prepared.has(binding)) bindings.push(binding)
      }
    }
    if (
      bindings.length ||
      ended.length ||
      endedExports.length ||
      (firstRead &&
        api?.kind === 'browser' &&
        props.data.shots.some((shot) => shot.currentClipVersionId === undefined)) ||
      next.exports?.some((item) => item.clipVersionId && !known.has(item.clipVersionId)) ||
      next.runs.some((run) =>
        [run.firstVersionId, run.lastVersionId, run.clipVersionId].some((id) => id && !known.has(id))
      )
    ) {
      await props.refresh()
      check()
      bindings.forEach((id) => prepared.add(id))
    }
    if (ended.length)
      notice.value =
        ended.length === 1 && ended[0]!.status === 'succeeded'
          ? `「${ended[0]!.shotTitle}」已生成，视频已存入素材库。`
          : `${ended.length} 个镜头任务已结束，可在生成历史中查看。`
    if (endedExports.length)
      notice.value = endedExports.some((item) => item.status === 'succeeded')
        ? '整片导出已完成，可以播放或保存视频文件。'
        : '整片导出已结束，可查看导出记录。'
  }
  function schedule() {
    clearTimeout(timer)
    if (!active || !api || document.hidden) return
    const exporting = board.value?.exports?.some((item) => item.status === 'running' || item.status === 'queued')
    timer = setTimeout(observe, activeShots.value.size || exporting || pending.value ? 2500 : 10_000)
  }
  async function observe() {
    if (!api || !active || document.hidden || observer || busy.value) return
    clearTimeout(timer)
    const request = new AbortController()
    observer = request
    reading.value = true
    const signal = AbortSignal.any([request.signal, life.signal])
    try {
      check()
      try {
        pending.value = readPending()
        journalError.value = ''
      } catch (e) {
        pending.value = null
        journalError.value = videoError(e)
      }
      await Promise.all([
        api
          .list(signal)
          .then(async (value) => {
            if (!signal.aborted) await accept(value)
          })
          .catch((e) => {
            if (!signal.aborted) readError.value = videoError(e)
          }),
        api
          .queue(signal)
          .then((value) => {
            if (!signal.aborted) {
              queue.value = value
              queueError.value = ''
            }
          })
          .catch((e) => {
            if (!signal.aborted) {
              queue.value = undefined
              queueError.value = videoError(e)
            }
          }),
      ])
    } catch (e) {
      if (!signal.aborted) readError.value = videoError(e)
    } finally {
      if (observer === request) {
        observer = undefined
        reading.value = false
        schedule()
      }
    }
  }
  function stopReading() {
    clearTimeout(timer)
    observer?.abort()
    observer = undefined
    reading.value = false
  }
  function visibility() {
    if (document.hidden) stopReading()
    else void observe()
  }
  function start() {
    if (active) return
    active = true
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('focus', observe)
    void observe()
  }
  function stop() {
    active = false
    stopReading()
    document.removeEventListener('visibilitychange', visibility)
    window.removeEventListener('focus', observe)
  }
  onMounted(start)
  onActivated(start)
  onDeactivated(stop)
  onScopeDispose(() => {
    stop()
    life.abort()
  })

  async function change(operation: () => Promise<void>) {
    if (!api || busy.value) return
    stopReading()
    busy.value = true
    notice.value = ''
    error.value = ''
    try {
      check()
      await operation()
    } catch (e) {
      if (!life.signal.aborted) error.value = videoError(e)
    } finally {
      busy.value = false
      if (active) void observe()
    }
  }
  async function send(batch: Submission) {
    if (!api) return
    try {
      let next: StudioVideoBoard
      if ('options' in batch) {
        if (!api.submitExport) throw new Error('当前工作区未连接整片导出。')
        next = await api.submitExport(batch, life.signal)
      } else next = await api.submit(batch, life.signal)
      if (!accepted(next, batch)) throw new Error('尚未取得提交回执。')
      await accept(next)
      notice.value =
        'options' in batch
          ? `已提交 ${batch.shots.length} 个镜头的整片导出。`
          : `已提交 ${batch.shots.length} 个镜头。`
    } catch (e) {
      check()
      if (e instanceof ApiClientError && e.kind === 'http' && e.responseBody?.submissionNotAccepted === true) {
        await clearPending(batch.id)
        await props.refresh()
        throw e
      }
      throw new Error(`${videoError(e)} 可以继续核对或重送原批次。`)
    }
  }
  const enqueue = (prepare: () => Promise<Submission>) =>
    change(async () => {
      if (!api) return
      pending.value = readPending()
      if (pending.value) throw new Error('请先核对上次提交的批次。')
      const batch = await prepare()
      check()
      if (!validVideoBatch(batch) && !validStudioExportInput(batch)) throw new Error('请检查所选镜头、版本与设置。')
      await writeJournal(api.journalKey, JSON.stringify(batch)).confirm()
      check()
      pending.value = readPending()
      if (pending.value?.id !== batch.id) throw new Error('另一窗口已更改待提交的批次，请先核对项目历史。')
      await send(batch)
    })
  const submit = (prepare: () => Promise<StudioVideoInput[]>) =>
    enqueue(async () => ({ id: crypto.randomUUID(), shots: await prepare() }))
  const submitExport = (prepare: () => Promise<Omit<StudioExportInput, 'id'>>) =>
    enqueue(async () => ({ id: crypto.randomUUID(), ...(await prepare()) }))
  const retry = () =>
    change(async () => {
      const saved = readPending()
      if (!saved || !api) return
      pending.value = saved
      const next = await api.list(life.signal)
      await accept(next)
      if (accepted(next, saved)) {
        notice.value = '已找到原批次。'
        return
      }
      await send(saved)
    })
  const cancel = (run: StudioVideoRun) =>
    change(async () => {
      if (!api || run.projectId !== props.data.project.id || !activeRun(run)) return
      const next = await api.cancel(run.id, life.signal)
      await accept(next)
      notice.value =
        next.runs.find((item) => item.id === run.id)?.status === 'cancelled'
          ? '这条镜头任务已取消。'
          : '已请求取消，正在核对镜头状态。'
    })
  const pause = () =>
    change(async () => {
      if (!api || !queue.value) return
      queue.value = await api.queue(life.signal, !queue.value.paused)
      queueError.value = ''
      notice.value = queue.value.paused ? '本机队列已暂停接续任务，正在执行的镜头会继续生成。' : '本机队列已继续。'
    })
  const selectCurrent = (run: StudioVideoRun) =>
    change(async () => {
      if (!api || run.projectId !== props.data.project.id || !run.clipVersionId || run.status !== 'succeeded')
        return
      const shot = props.data.shots.find((item) => item.id === run.shotId)
      if (!shot || shot.currentClipVersionId === run.clipVersionId) return
      try {
        await accept(await api.selectCurrent(shot.id, run.id, shot.revision, life.signal))
      } finally {
        check()
        await props.refresh()
      }
      notice.value = `已替换「${shot.title}」在时间线上的成片。`
    })
  const cancelExport = (record: StudioExportRecord) =>
    change(async () => {
      if (
        !api?.cancelExport ||
        record.projectId !== props.data.project.id ||
        !['queued', 'running'].includes(record.status)
      )
        return
      await accept(await api.cancelExport(record.id, life.signal))
      notice.value = '已请求取消这次整片导出。'
    })
  const refreshBoard = () =>
    change(async () => {
      if (!api) return
      await props.refresh()
      await accept(await api.list(life.signal))
    })
  return {
    api,
    board,
    queue,
    pending,
    activeShots,
    reading,
    busy,
    notice,
    error,
    readError,
    queueError,
    journalError,
    observe,
    submit,
    submitExport,
    cancelExport,
    selectCurrent,
    refreshBoard,
    retry,
    cancel,
    pause,
  }
}

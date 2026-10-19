import { computed, onScopeDispose, reactive, ref, shallowRef, watch } from 'vue'
import { qwenModels, qwenStatus, uploadQwenImage, type QwenModelStatus } from '@/api/qwenApi'
import { cancelRuntimeTaskKey, fetchRuntimeResult, getRuntimeTask, getRuntimeTaskByKey, hasRuntimeTasks,
  runtimeResultPath, submitRuntimeTask, taskMessage, waitForRuntimeTask, type TaskRecord } from '@/api/runtimeTasks'
import { newTaskRequestDraft, readTaskRequestDraft, type TaskRequestDraft } from '@/storage/taskRequestDraft'
import { assertRequestOwner, clearRequestDraft, writeRequestDraft } from '@/storage/requestDraft'
import { QWEN_REQUEST_DRAFT_KEY as slot } from '@/utils/storageKeys'
import { imageMediaSession } from '@/platform/imageMediaSession'
import { archiveTaskResult } from '@/composables/tasks/taskArtwork'
import { inspectMangaImage, mangaInputSize, prepareMangaImage, type MangaImage } from '@/composables/manga/mangaImage'
import { downloadMangaPng } from '@/composables/manga/mangaResult'
import { artworkRepository } from '@/storage/artworkRepository'

const message = (cause: unknown) => cause instanceof Error ? cause.message : '操作未完成，请重试'
const terminal = (task: TaskRecord | null) => !!task && task.upstreamSettled && task.recoveryState === 'normal'
  && ['succeeded', 'failed', 'cancelled'].includes(task.status)
export function useQwenStudio() {
  const form = reactive({ modelId: 'qwen-image-2.1-turbo', prompt: '', negative: '', width: 1024, height: 1024, steps: 40, cfg: 4, seed: 0 })
  const randomSeed = ref(true), resize = ref(false), source = shallowRef<MangaImage | null>(null), sourceUrl = ref('')
  const references = shallowRef<{ id: string; image: MangaImage; url: string }[]>([])
  const restoredInputMissing = ref(false)
  const models = shallowRef<QwenModelStatus[]>([]), checking = ref(false), ready = ref(false), statusError = ref('')
  const task = shallowRef<TaskRecord | null>(null), request = shallowRef<TaskRequestDraft | null>(null)
  const result = shallowRef<TaskRecord | null>(null), resultBlob = shallowRef<Blob | null>(null), resultUrl = ref('')
  const busy = ref(false), importing = ref(false), observing = ref(false), cancelling = ref(false), saving = ref(false), saved = ref(false)
  const error = ref(''), notice = ref(''), sourceChanged = ref(false)
  const lifetime = new AbortController(), owner = imageMediaSession()
  let cancelled = false
  watch(imageMediaSession, value => { if (value !== owner) sourceChanged.value = true }, { flush: 'sync' })
  const check = () => {
    lifetime.signal.throwIfAborted()
    if (sourceChanged.value || imageMediaSession() !== owner) throw new Error('工作区或运行时连接已变化，请重新打开页面；原任务仍保留在任务中心')
    if (request.value) assertRequestOwner(request.value, hasRuntimeTasks())
  }
  const selected = computed(() => models.value.find(model => model.id === form.modelId))
  const turbo = computed(() => form.modelId === 'qwen-image-2.1-turbo')
  const unresolved = computed(() => !!request.value && !terminal(task.value) || !!task.value && !terminal(task.value))
  const locked = computed(() => !ready.value || busy.value || importing.value || observing.value || saving.value || cancelling.value || unresolved.value)
  const inputSize = computed(() => source.value ? mangaInputSize(source.value) : null)
  const needsResize = computed(() => inputSize.value?.resized || references.value.some(value => mangaInputSize(value.image).resized))
  const issue = computed(() => sourceChanged.value ? '请重新打开页面以连接当前工作区' : !hasRuntimeTasks() ? '请先启用本机私人工作区'
    : !selected.value?.available ? selected.value?.unavailableReason || statusError.value || '请先准备所选 Qwen 模型'
      : restoredInputMissing.value ? '再次编辑前请重新导入原图和参考图，或明确切换到文生图'
        : !form.prompt.trim() ? '填写画面描述或编辑指令' : needsResize.value && !resize.value ? '请勾选缩小输入图片副本' : '')
  const canRun = computed(() => !locked.value && !issue.value)
  const progress = computed(() => typeof task.value?.metadata.progress === 'number' ? Math.round(Math.max(0, Math.min(1, task.value.metadata.progress)) * 100) : null)
  const taskText = computed(() => task.value ? taskMessage(task.value) : request.value ? '接收状态待确认，请查询原操作或请求取消' : '')
  function setUrl(target: typeof sourceUrl, blob: Blob | null) {
    if (target.value) URL.revokeObjectURL(target.value)
    target.value = blob ? URL.createObjectURL(blob) : ''
  }
  function accept(value: TaskRecord) {
    if (value.kind !== 'qwen' || value.provider !== 'native' || value.input.family !== 'qwen-image') throw new Error('任务类型与 Qwen 创作不符')
    if (!task.value || value.taskId !== task.value.taskId || value.revision >= task.value.revision) task.value = structuredClone(value)
  }
  async function refresh() {
    if (checking.value) return
    checking.value = true; statusError.value = ''
    try { check(); const values = await qwenStatus(lifetime.signal); check(); models.value = values }
    catch (cause) { if (!lifetime.signal.aborted) { models.value = []; statusError.value = message(cause) } }
    finally { checking.value = false }
  }
  async function loadSource(file: File) {
    if (locked.value) return
    importing.value = true; error.value = ''
    try { check(); const image = await inspectMangaImage(file, file.name); check(); source.value = image; restoredInputMissing.value = false; resize.value = false; setUrl(sourceUrl, image.blob) }
    catch (cause) { if (!lifetime.signal.aborted) error.value = message(cause) }
    finally { importing.value = false }
  }
  function removeReference(id: string) {
    if (locked.value) return
    const removed = references.value.find(value => value.id === id)
    if (removed) URL.revokeObjectURL(removed.url)
    references.value = references.value.filter(value => value.id !== id)
  }
  function removeSource() {
    if (locked.value) return
    for (const value of references.value) URL.revokeObjectURL(value.url)
    references.value = []; source.value = null; restoredInputMissing.value = false; resize.value = false; setUrl(sourceUrl, null)
  }
  async function addReferences(files: File[]) {
    if (locked.value || !source.value || !files.length) return
    importing.value = true; error.value = ''
    try {
      check()
      if (files.length + references.value.length > 3) throw new Error('最多添加三张参考图，加上原图共四张；请减少选择后重试')
      const images: MangaImage[] = []
      for (const file of files) { images.push(await inspectMangaImage(file, file.name)); check() }
      references.value = [...references.value, ...images.map(image => ({ id: crypto.randomUUID(), image, url: URL.createObjectURL(image.blob) }))]
      resize.value = false
    } catch (cause) { if (!lifetime.signal.aborted) error.value = message(cause) }
    finally { importing.value = false }
  }
  async function observe() {
    if (observing.value || !request.value && !task.value) return
    observing.value = true; error.value = ''
    try {
      check()
      if (request.value) {
        const found = await getRuntimeTaskByKey(request.value.key, lifetime.signal); check()
        if (!found) throw new Error('尚未找到原请求，请在任务中心核对，或请求取消后开始新的创作')
        accept(found); request.value.taskId = found.taskId
        await writeRequestDraft(slot, request.value); check()
      }
      if (!task.value) return
      const completed = await waitForRuntimeTask(task.value.taskId, lifetime.signal, check,
        { timeoutMs: 11 * 60_000, onDetail: value => { check(); accept(value) } })
      check(); accept(completed)
      if (!completed.resultRefs.some(output => output.index === 0 && output.mime === 'image/png')) throw new Error('任务尚无完整 PNG 结果')
      if (result.value?.taskId !== completed.taskId) { saved.value = false; setUrl(resultUrl, null); resultBlob.value = null }
      result.value = structuredClone(completed)
      const blob = await fetchRuntimeResult(runtimeResultPath(completed), lifetime.signal, completed); check()
      if (!blob.size || blob.type.split(';')[0] !== 'image/png') throw new Error('结果不是有效的 PNG 图片')
      resultBlob.value = blob; setUrl(resultUrl, blob); notice.value = '结果已保存在任务中心，可导出或存入我的作品'
    } catch (cause) { if (!lifetime.signal.aborted) error.value = message(cause) }
    finally { observing.value = false }
  }
  async function cancel() {
    cancelled = true
    const key = request.value?.key || task.value?.requestKey
    if (!key || cancelling.value || terminal(task.value)) return
    cancelling.value = true; error.value = ''
    try {
      check(); const value = await cancelRuntimeTaskKey(key, lifetime.signal); check()
      if (value) { accept(value); notice.value = '取消请求已记录，等待后端确认'; if (!observing.value) void observe() }
      else if (request.value) {
        await clearRequestDraft(slot, request.value); check(); request.value = null
        notice.value = '取消意图已保存，原请求不会再执行'
      }
    } catch (cause) { if (!lifetime.signal.aborted) error.value = '取消尚未确认：' + message(cause) }
    finally { cancelling.value = false }
  }
  async function releaseRequest() {
    if (request.value) { await clearRequestDraft(slot, request.value); check(); request.value = null }
  }
  async function run() {
    if (!canRun.value) return
    busy.value = true; cancelled = false; error.value = ''; notice.value = ''
    try {
      check()
      if (!qwenModels.some(model => model.value === form.modelId) || form.prompt.trim().length > 12000 || form.negative.length > 8000) throw new Error('模型或提示词参数无效')
      if (![form.width, form.height].every(n => Number.isInteger(n) && n >= 512 && n <= 2816 && n % 32 === 0)) throw new Error('宽高需为 512—2816 内的 32 倍数')
      if (!randomSeed.value && (!Number.isInteger(form.seed) || form.seed < 0 || form.seed > 2147483647)) throw new Error('种子需为 0—2147483647 的整数')
      const negative = turbo.value ? '' : form.negative.trim()
      if (!turbo.value && (!Number.isInteger(form.steps) || form.steps < 1 || form.steps > 100
        || negative && (!Number.isFinite(form.cfg) || form.cfg <= 1 || form.cfg > 20))) throw new Error('步数需为 1—100；有负向描述时 CFG 需大于 1 且不超过 20')
      const input: Record<string, unknown> = { modelId: form.modelId, prompt: form.prompt.trim(), negative,
        width: form.width, height: form.height, steps: turbo.value ? 8 : form.steps, cfg: negative ? form.cfg : 1,
        ...(randomSeed.value ? {} : { seed: form.seed }) }
      await releaseRequest(); task.value = null
      if (source.value) {
        const blob = await prepareMangaImage(source.value, resize.value); check()
        if (cancelled) return
        input.initImage = await uploadQwenImage(blob, lifetime.signal); check()
        const names: string[] = []
        for (const value of references.value) {
          if (cancelled) break
          const reference = await prepareMangaImage(value.image, resize.value); check()
          if (cancelled) break
          names.push(await uploadQwenImage(reference, lifetime.signal)); check()
        }
        if (names.length) input.referenceImages = names
      }
      if (cancelled) { notice.value = '已取消，尚未提交任务'; return }
      request.value = newTaskRequestDraft('qwen', input, true)
      request.value.submitted = true
      await writeRequestDraft(slot, request.value); check()
      if (cancelled) { await cancel(); return }
      const value = await submitRuntimeTask('qwen', input, request.value.key, undefined, { signal: lifetime.signal, onSubmitting: check })
      check(); accept(value); request.value.taskId = value.taskId
      await writeRequestDraft(slot, request.value); check()
      if (cancelled) await cancel()
      void observe()
    } catch (cause) { if (!lifetime.signal.aborted) error.value = message(cause) }
    finally { busy.value = false }
  }
  async function exportResult(kind: 'save' | 'download') {
    const output = result.value
    if (!output || saving.value || busy.value || importing.value || kind === 'save' && saved.value) return
    saving.value = true; error.value = ''
    try {
      check()
      if (kind === 'save') { await archiveTaskResult(output.taskId); check(); saved.value = true; notice.value = '已存入我的作品' }
      else if (resultBlob.value) { const downloaded = await downloadMangaPng(resultBlob.value, `绘遇-Qwen-${output.taskId}.png`); check(); if (downloaded) notice.value = 'PNG 已导出' }
    } catch (cause) { if (!lifetime.signal.aborted) error.value = message(cause) }
    finally { saving.value = false }
  }
  async function initialize(modelId?: string, taskId?: string, artworkId?: string) {
    try {
      check()
      if (qwenModels.some(model => model.value === modelId)) form.modelId = modelId!
      request.value = readTaskRequestDraft(slot)
      if (request.value) {
        if (request.value.kind !== 'qwen') throw new Error('保存的请求不是 Qwen 创作，请核对任务中心')
        check()
        const found = await getRuntimeTaskByKey(request.value.key, lifetime.signal); check()
        if (found) accept(found)
        if (terminal(task.value)) await releaseRequest()
      }
      if (taskId && !request.value) {
        const found = await getRuntimeTask(taskId, lifetime.signal); check(); accept(found)
      } else if (taskId && taskId !== task.value?.taskId) {
        notice.value = '上次操作尚未确认，已恢复原请求；其他结果可在任务中心查看'
      }
      const input = request.value?.input || task.value?.input
      if (input) {
        for (const key of Object.keys(form) as (keyof typeof form)[]) {
          const value = input[key]
          if (typeof value === typeof form[key]) Object.assign(form, { [key]: value })
        }
        randomSeed.value = typeof input.seed !== 'number'
        if (input.initImage) {
          restoredInputMissing.value = true
          notice.value += `${notice.value ? '。' : ''}原编辑任务使用已保护的输入；再次编辑前请重新导入原图和参考图`
        }
      }
      if (artworkId) {
        if (unresolved.value) notice.value = '上次操作尚未确认，已恢复原请求；结束后可从作品册再次打开编辑'
        else {
          try {
            const artwork = await artworkRepository.readArtwork(artworkId); check()
            if (!artwork?.image_id) throw new Error('作品原图不可用，请重新导入本地图片')
            const blob = await artworkRepository.getImage(artwork.image_id, lifetime.signal); check()
            if (!blob) throw new Error('作品原图无法读取，请重新导入本地图片')
            source.value = await inspectMangaImage(blob, artwork.sceneTitle || '作品原图'); check()
            setUrl(sourceUrl, source.value.blob); restoredInputMissing.value = false; form.prompt = ''; task.value = null
            if (qwenModels.some(model => model.value === artwork.checkpoint)) form.modelId = artwork.checkpoint!
            notice.value = '已导入作品副本，请填写编辑指令；原作品保持不变'
          } catch (cause) { check(); error.value = message(cause) }
        }
      }
      ready.value = true
      void refresh()
      if (request.value || task.value) void observe()
    } catch (cause) { if (!lifetime.signal.aborted) error.value = message(cause) }
  }
  onScopeDispose(() => { lifetime.abort(); setUrl(sourceUrl, null); setUrl(resultUrl, null); for (const value of references.value) URL.revokeObjectURL(value.url) })
  return { form, randomSeed, resize, source, sourceUrl, references, needsResize, restoredInputMissing, selected, turbo, checking, statusError, task, request, result, resultUrl, resultBlob,
    busy, importing, observing, cancelling, saving, saved, error, notice, locked, unresolved, issue, canRun, inputSize, progress, taskText,
    refresh, loadSource, removeSource, addReferences, removeReference, run, cancel, observe, exportResult, initialize }
}

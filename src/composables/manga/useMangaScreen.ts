import { computed, onScopeDispose, reactive, ref, shallowRef, watch } from 'vue'
import { ApiClientError } from '@/api/client'
import { defaultMangaParameters, mangaManifest, mangaStatus, uploadMangaImage,
  type MangaJob, type MangaOperation, type MangaRequest, type MangaStatus, type MangaRewrite } from '@/api/mangaApi'
import { imageMediaSession } from '@/platform/imageMediaSession'
import { onDesktopRuntime } from '@/platform/desktop/runtime'
import { inspectMangaImage, mangaInputSize, prepareMangaImage, readMangaSource, type MangaImage } from './mangaImage'
import { mangaResult } from './mangaResult'
import { useMangaLines } from './useMangaLines'
import type { ArtworkRecord } from '@/types/artwork'
import { cancelRuntimeTaskKey, getRuntimeTaskByKey, hasRuntimeTasks, submitRuntimeTask, waitForRuntimeTask } from '@/api/runtimeTasks'
import { fetchMangaTaskResult, mangaTaskView } from '@/api/mangaTasks'
import { MANGA_REQUEST_DRAFT_KEY } from '@/utils/storageKeys'
import { readTaskRequestDraft, newTaskRequestDraft, type TaskRequestDraft } from '@/storage/taskRequestDraft'
import { assertRequestOwner, clearRequestDraft, writeRequestDraft } from '@/storage/requestDraft'
import { sameTempResultOwner, tempResultOwner } from '@/utils/tempResult'
import { mangaTaskContext } from '@/application/artwork/mangaTaskResult'

const terminal = (job: MangaJob | null) => !!job && job.task.upstreamSettled && job.task.recoveryState === 'normal' && ['succeeded', 'failed', 'cancelled'].includes(job.status)
const message = (error: unknown) => error instanceof Error ? error.message : '操作失败，请稍后重试'
export function useMangaScreen(onSaved: () => void) {
  const parameters = reactive(defaultMangaParameters()), operation = ref<MangaOperation>('lite')
  const redraw = ref(false)
  const rewrite = reactive<MangaRewrite>({modelId:mangaManifest.rewrite.defaultModel, prompt:mangaManifest.rewrite.defaultPrompt, width:1024, height:1024, seed:0})
  const source = shallowRef<MangaImage | null>(null), sourceUrl = ref(''), resize = ref(false)
  const result = shallowRef<ReturnType<typeof mangaResult> | null>(null), resultUrl = ref('')
  const status = shallowRef<MangaStatus | null>(null), statusError = ref(''), checking = ref(false)
  const error = ref(''), notice = ref(''), loading = ref(false), submitting = ref(false), observing = ref(false), cancelling = ref(false)
  const exporting = ref(false), saved = ref(false), downloaded = ref(false), acceptanceUnknown = ref(false)
  const job = shallowRef<MangaJob | null>(null), preview = ref<'original' | 'lineart' | 'result' | 'compare'>('original')
  const lineLoading = ref(false)
  const request = shallowRef<TaskRequestDraft | null>(null), taskIssue = ref('')
  const requestKey = computed(() => request.value?.key || '')
  const lifetime = new AbortController()
  const inputOwner = imageMediaSession()
  let owner = inputOwner, inputCurrent = true
  // A reconnect must not revive preparation that crossed a disconnected visit.
  const stopRuntime = onDesktopRuntime(() => { if (inputOwner !== imageMediaSession()) inputCurrent = false })
  watch(imageMediaSession, session => { if (session !== inputOwner) inputCurrent = false }, { flush:'sync' })
  let sourceRead: AbortController | null = null, parent: ArtworkRecord | undefined, cancelRequested = false, resultRecipe = '', submittedRecipe = '', lineRecipe = ''
  const pending = computed(() => !!job.value && !terminal(job.value))
  const awaitingResult = computed<boolean>(() => job.value?.status === 'succeeded' && (job.value.operation === 'lineart'
    ? lines.expected.value?.id !== job.value.id : result.value?.job.id !== job.value.id))
  const locked = computed(() => loading.value || lineLoading.value || submitting.value || pending.value || observing.value || exporting.value || acceptanceUnknown.value || awaitingResult.value)
  const check = () => {
    lifetime.signal.throwIfAborted()
    if (request.value) assertRequestOwner(request.value, hasRuntimeTasks())
    if (owner !== imageMediaSession()) throw new Error('运行时或作品库连接已变化，请关闭窗口后重新打开')
  }
  const checkInput = () => {
    check()
    if (!inputCurrent || inputOwner !== imageMediaSession()) throw new Error('原图所属会话已变化，请关闭窗口后重新导入；原任务可继续查询')
  }
  const lines = useMangaLines({signal:lifetime.signal, check, checkInput, locked:() => locked.value, loading:lineLoading, exporting, source:() => parent, onSaved})
  const autoLines = computed(() => lines.mode.value === 'auto')
  // Mode changes keep visible switches consistent with the steps being submitted.
  watch(redraw, enabled => { if (enabled && operation.value !== 'finish') operation.value = 'comic' }, {flush:'sync'})
  watch(lines.mode, mode => { if (mode !== 'none' && !mangaManifest.operations[operation.value].includes('finish')) operation.value = 'lite' }, {flush:'sync'})
  watch(operation, value => {
    if (value !== 'comic' && value !== 'finish') redraw.value = false
    if (!mangaManifest.operations[value].includes('finish')) lines.mode.value = 'none'
  }, {flush:'sync'})
  watch(lines.previewAvailable, available => { if (!available && preview.value === 'lineart') preview.value = 'original' })
  const inputSize = computed(() => source.value ? mangaInputSize(source.value) : null)
  const extractionIssue = computed(() => {
    if (!source.value) return '请先导入原图'
    if (taskIssue.value) return taskIssue.value
    if (!status.value?.available) return '原生漫画服务尚未就绪'
    if (!status.value.lineart.available) return status.value.lineart.unavailableReason || '自动线稿模型尚未就绪'
    if (inputSize.value?.resized && !resize.value) return '请先勾选缩小处理副本'
    return ''
  })
  const lineMismatch = computed(() => !!lines.imported.value && !!inputSize.value &&
    (lines.imported.value.width !== inputSize.value.width || lines.imported.value.height !== inputSize.value.height))
  const lineIssue = computed(() => {
    if (autoLines.value && !status.value?.lineart.available) return '自动线稿模型尚未就绪，请查看上方原因'
    if (lines.mode.value !== 'external') return ''
    if (redraw.value) return '使用外部线稿前，请先关闭 Qwen 重绘，避免线稿与重绘画面错位'
    if (!lines.imported.value) return '请导入线稿图片'
    if (!lines.inputReady.value) return '线稿预览尚未就绪，请重新生成预览'
    if (lineMismatch.value && !lines.stretch.value) return '线稿尺寸与处理图不同，请明确选择缩放对齐，或导入同尺寸线稿'
    return ''
  })
  const recipe = computed(() => Object.fromEntries([
    ['operation', operation.value], ...mangaManifest.operations[operation.value].map(group => [group, parameters[group as keyof typeof parameters]]),
    ['autoLines', autoLines.value], ...(redraw.value ? [['rewrite', rewrite]] : []),
    ...(lines.mode.value === 'external' ? [['penLinesPolarity', lines.polarity.value], ['penLinesFit', lines.stretch.value ? 'stretch' : 'exact']] : []),
  ]) as Omit<MangaRequest, 'initImage'>)
  const recipeSignature = computed(() => JSON.stringify([recipe.value, lines.signature.value]))
  const modelIssue = computed(() => {
    if (redraw.value && !status.value?.rewrite.find(m => m.id === rewrite.modelId)?.available) return '所选 Qwen 重绘模型尚未就绪，请查看模型说明'
    return ''
  })
  const dirty = computed(() => !!result.value && (recipeSignature.value !== resultRecipe || !!job.value && job.value.operation !== 'lineart' && result.value.job.id !== job.value.id))
  const lineDirty = computed(() => !!lines.expected.value && (lines.expected.value.id !== job.value?.id
    || lines.expected.value.operation !== 'lineart' && recipeSignature.value !== lineRecipe))
  const progress = computed(() => submitting.value || job.value?.progress == null ? null : Math.round(job.value.progress * 100))
  function setUrl(target: typeof sourceUrl, blob: Blob | null) {
    if (target.value) URL.revokeObjectURL(target.value)
    target.value = blob ? URL.createObjectURL(blob) : ''
  }
  async function refreshStatus() {
    if (checking.value) return
    checking.value = true; statusError.value = ''
    try {
      check(); taskIssue.value = hasRuntimeTasks() ? '' : '请先启用本机私人工作区，漫画与线稿任务需要持久化保存'
      const value = await mangaStatus(lifetime.signal); check(); status.value = value
    }
    catch (e) { if (!lifetime.signal.aborted) {
      status.value = null
      statusError.value = e instanceof ApiClientError && e.status === 404
        ? '当前运行的后端尚未提供漫画接口，请更新并重启原生后端后重新检查。'
        : e instanceof ApiClientError && e.code === 'NATIVE_ENGINE_REQUIRED'
          ? '请在控制室启用原生后端并重启；漫画处理仅使用原生接口。' : message(e)
    } }
    finally { checking.value = false }
  }
  async function loadSource(input: File | { url: string; artwork?: ArtworkRecord }) {
    if (locked.value) return
    sourceRead?.abort(); const controller = new AbortController(); sourceRead = controller
    const signal = AbortSignal.any([controller.signal, lifetime.signal])
    loading.value = true; error.value = ''; notice.value = ''
    try {
      checkInput()
      const artwork = input instanceof File ? undefined : input.artwork
      const blob = input instanceof File ? input : await readMangaSource(input.url, artwork, signal)
      const image = await inspectMangaImage(blob, input instanceof File ? input.name : artwork?.sceneTitle || '当前作品')
      signal.throwIfAborted(); checkInput()
      if (request.value) { await clearRequestDraft(MANGA_REQUEST_DRAFT_KEY, request.value); checkInput(); request.value = null }
      source.value = image; parent = artwork ? structuredClone(artwork) : undefined; resize.value = false
      const scale = Math.sqrt(1024 * 1024 / (image.width * image.height))
      rewrite.width = Math.max(512, Math.min(2016, Math.round(image.width * scale / 32) * 32))
      rewrite.height = Math.max(512, Math.min(2016, Math.round(image.height * scale / 32) * 32))
      setUrl(sourceUrl, blob); setUrl(resultUrl, null); result.value = null; job.value = null
      lines.reset()
      preview.value = 'original'; saved.value = false; downloaded.value = false
    } catch (e) { if (!signal.aborted) error.value = message(e) }
    finally { if (sourceRead === controller) { loading.value = false; sourceRead = null } }
  }
  function validate() {
    if (lineIssue.value) throw new Error(lineIssue.value)
    if (modelIssue.value) throw new Error(modelIssue.value)
    if (redraw.value) {
      if (!rewrite.prompt.trim() || rewrite.prompt.length > 12000) throw new Error('请填写不超过 12000 字符的重绘指令')
      if (![rewrite.width, rewrite.height].every(v => Number.isInteger(v) && v >= 512 && v <= 2816 && v % 32 === 0)
        || rewrite.width * rewrite.height > mangaManifest.maxInputPixels) throw new Error('重绘宽高需为 512—2816 内的 32 倍数，总像素不超过 2097152')
      if (!Number.isInteger(rewrite.seed) || rewrite.seed < 0 || rewrite.seed > 2147483647) throw new Error('种子需为 0—2147483647 的整数')
    }
    for (const group of mangaManifest.operations[operation.value]) {
      const rules = mangaManifest.parameters[group as keyof typeof parameters]
      for (const [key, rule] of Object.entries(rules)) {
        const value = parameters[group as keyof typeof parameters][key]
        if ('choices' in rule ? !(rule.choices as readonly unknown[]).includes(value) :
          typeof value !== 'number' || !Number.isFinite(value) || value < rule.min || value > rule.max || 'integer' in rule && !Number.isInteger(value))
          throw new Error('有参数超出允许范围，请检查数值后再处理')
      }
    }
    if (operation.value === 'levels' || operation.value === 'lite') {
      if (Number(parameters.levels.white) <= Number(parameters.levels.black)) throw new Error('色阶白场需大于黑场')
    }
    if (mangaManifest.operations[operation.value].includes('finish')) {
      if (Number(parameters.finish.white_point) <= Number(parameters.finish.black_point)) throw new Error('网点白场需大于黑场')
      if (Number(parameters.finish.dark_tone) < Number(parameters.finish.light_tone)) throw new Error('暗部网点浓度不能小于亮部')
    }
  }
  async function observe() {
    if (observing.value || !job.value && !requestKey.value) return
    observing.value = true; error.value = ''
    try {
      if (request.value) {
        assertRequestOwner(request.value, hasRuntimeTasks())
        owner = imageMediaSession()
        const accepted = await getRuntimeTaskByKey(requestKey.value, lifetime.signal); check()
        if (!accepted) throw new Error('接收状态仍待确认，请在任务中心查询原操作，勿重复提交')
        if (accepted.kind !== request.value.kind) throw new Error('原请求与任务类型不符，请在任务中心核对')
        job.value = mangaTaskView(accepted); acceptanceUnknown.value = false
        request.value.taskId = accepted.taskId
        await writeRequestDraft(MANGA_REQUEST_DRAFT_KEY, request.value); check()
      }
      if (!job.value) throw new Error('原任务身份尚未找到，请核对任务中心')
      const id = job.value.id
      await waitForRuntimeTask(id, lifetime.signal, check, { timeoutMs: 11 * 60_000, onDetail: task => {
        check()
        // The cancellation command can publish a newer receipt during a GET.
        if (job.value?.id !== id || task.revision >= job.value.task.revision) job.value = mangaTaskView(task)
      } })
      check()
      const current = job.value
      if (current.status === 'cancelled') { notice.value = '后端已确认取消'; return }
      if (current.operation === 'lineart') {
        await lines.accept(current); check()
        preview.value = 'lineart'
        notice.value = '独立提取任务已结束，可在线稿预览旁保存。待主力机验证。'; return
      }
      const blob = await fetchMangaTaskResult(current, lifetime.signal); check()
      const width = current.metadata.width, height = current.metadata.height
      if (typeof width !== 'number' || typeof height !== 'number' || width <= 0 || height <= 0) throw new Error('结果尺寸缺失，请更新原生后端')
      result.value = mangaResult(blob, current); setUrl(resultUrl, blob)
      resultRecipe = submittedRecipe; preview.value = 'result'; saved.value = false; downloaded.value = false
      if (current.lineart) lineRecipe = submittedRecipe
      await lines.accept(current); check()
      notice.value = '漫画结果已返回，可对比或保存副本。适配仍待主力机验证。'
    } catch (e) {
      if (!lifetime.signal.aborted) {
        if (job.value?.status === 'cancelled') notice.value = '后端已确认取消'
        else error.value = message(e)
      }
    }
    finally { observing.value = false }
  }
  async function cancel() {
    cancelRequested = true
    notice.value = '已请求取消，等待任务状态确认'
    if (!requestKey.value || terminal(job.value) || cancelling.value) return
    cancelling.value = true; error.value = ''
    try {
      if (request.value) assertRequestOwner(request.value, hasRuntimeTasks())
      owner = imageMediaSession()
      check(); const receipt = await cancelRuntimeTaskKey(requestKey.value); check()
      if (!receipt && request.value) {
        await clearRequestDraft(MANGA_REQUEST_DRAFT_KEY, request.value)
        request.value = null; acceptanceUnknown.value = false
        notice.value = '取消意图已写稳，原请求尚未接收且不会再执行'; return
      }
      if (receipt) { job.value = mangaTaskView(receipt); acceptanceUnknown.value = false }
      if (receipt?.status === 'cancelled') { notice.value = '后端已确认取消' }
      else { notice.value = '已请求取消，等待后端确认'; if (!observing.value) void observe() }
    }
    catch (e) { if (!lifetime.signal.aborted) error.value = `取消尚未确认：${message(e)}` }
    finally { cancelling.value = false }
  }
  async function run(kind: 'manga' | 'lineart' = 'manga') {
    if (locked.value || !source.value || !status.value?.available) return
    error.value = ''; notice.value = ''; lines.notice.value = ''; submitting.value = true; cancelRequested = false
    try {
      checkInput()
      const sourceOwner = tempResultOwner()
      if (request.value) {
        if (!terminal(job.value)) throw new Error('请先查询原任务，确认结束后再处理')
        await clearRequestDraft(MANGA_REQUEST_DRAFT_KEY, request.value); checkInput(); request.value = null
      }
      if (!hasRuntimeTasks()) throw new Error('请先启用本机私人工作区，漫画与线稿任务需要持久化保存')
      if (kind === 'lineart') { if (extractionIssue.value) throw new Error(extractionIssue.value) }
      else validate()
      const recipeSnapshot: Omit<MangaRequest, 'initImage'> = kind === 'lineart'
        ? {operation:'lineart', autoLines:true} : JSON.parse(JSON.stringify(recipe.value))
      const signature = recipeSignature.value
      const blob = await prepareMangaImage(source.value, resize.value); checkInput()
      if (cancelRequested) { notice.value = '已取消，尚未提交任务'; return }
      const name = await uploadMangaImage(blob, lifetime.signal); checkInput()
      if (cancelRequested) { notice.value = '已取消，尚未提交任务'; return }
      const payload: MangaRequest = { ...recipeSnapshot, initImage:name }
      if (kind !== 'lineart' && lines.mode.value === 'external' && lines.imported.value) {
        payload.penLines = await uploadMangaImage(lines.imported.value.blob, lifetime.signal); checkInput()
        if (cancelRequested) { notice.value = '已取消，尚未提交任务'; return }
      }
      submittedRecipe = signature; job.value = null
      const input = {...payload}
      if (!sameTempResultOwner(sourceOwner)) throw new Error('漫画输入所属工作区已改变，尚未提交')
      const owned = newTaskRequestDraft(kind, input, true, mangaTaskContext(parent), { recipe: signature })
      request.value = owned
      // After this durable marker, refresh/reconnect can only query this key.
      request.value.submitted = true
      await writeRequestDraft(MANGA_REQUEST_DRAFT_KEY, request.value); checkInput()
      if (cancelRequested) { await cancel(); return }
      const value = await submitRuntimeTask(kind, input, requestKey.value, mangaTaskContext(parent),
        {signal:lifetime.signal, onSubmitting:checkInput})
      checkInput(); assertRequestOwner(owned, hasRuntimeTasks())
      if (request.value?.key !== owned.key) return
      job.value = mangaTaskView(value); acceptanceUnknown.value = false
      owned.taskId = value.taskId
      await writeRequestDraft(MANGA_REQUEST_DRAFT_KEY, owned); check()
      if (cancelRequested) await cancel()
      void observe()
    } catch (e) {
      if (!lifetime.signal.aborted) {
        acceptanceUnknown.value = Boolean(request.value && !terminal(job.value))
        error.value = acceptanceUnknown.value ? `任务接收状态未知，已阻止重复提交。可查询原操作或到任务中心核对。详情：${message(e)}` : message(e)
      }
    } finally { submitting.value = false }
  }
  async function exportResult(kind: 'save' | 'download') {
    if (!result.value || exporting.value || submitting.value || pending.value || observing.value) return
    exporting.value = true; error.value = ''
    try {
      check()
      if (kind === 'save') { await result.value.save(); saved.value = true; notice.value = '已另存漫画副本，可在我的作品中查看'; onSaved() }
      else if (await result.value.download()) { downloaded.value = true; notice.value = '已发起 PNG 保存' }
      check()
    } catch (e) { if (!lifetime.signal.aborted) error.value = message(e) }
    finally { exporting.value = false }
  }
  function beforeUnload(event: BeforeUnloadEvent) {
    if (exporting.value || lines.unsaved.value) {
      event.preventDefault(); event.returnValue = ''
    }
  }
  window.addEventListener('beforeunload', beforeUnload)
  onScopeDispose(() => {
    window.removeEventListener('beforeunload', beforeUnload)
    stopRuntime(); lifetime.abort(); sourceRead?.abort(); setUrl(sourceUrl, null); setUrl(resultUrl, null)
  })
  async function importLine(file: File) { if (await lines.prepare(file)) preview.value = 'lineart' }
  function restoreRequest(): boolean {
    try {
      request.value = readTaskRequestDraft(MANGA_REQUEST_DRAFT_KEY)
      if (!request.value) return false
      if (request.value.transport !== 'runtime' || !['manga', 'lineart'].includes(request.value.kind)) throw new Error('原漫画请求类型无效，已保留记录')
      submittedRecipe = typeof request.value.details?.recipe === 'string' ? request.value.details.recipe : ''
      acceptanceUnknown.value = true
      notice.value = '正在恢复原漫画或线稿任务；不会重新上传或提交'
    } catch (e) { acceptanceUnknown.value = true; error.value = message(e) }
    return true
  }
  const canStartNew = computed(() => terminal(job.value) && !submitting.value && !observing.value && !exporting.value)
  async function startNew() {
    if (!canStartNew.value || !request.value) return
    try {
      check(); await clearRequestDraft(MANGA_REQUEST_DRAFT_KEY, request.value); check()
      request.value = null; job.value = null; acceptanceUnknown.value = false
      result.value = null; setUrl(resultUrl, null); lines.reset(); preview.value = 'original'
      notice.value = '原任务和结果仍保留在任务中心，可导入图片开始新的处理'
    } catch (e) { error.value = message(e) }
  }
  return { parameters, operation, redraw, rewrite, modelIssue, lines, lineLoading, lineMismatch, lineIssue, lineDirty, extractionIssue, importLine, source, sourceUrl, resize, inputSize, result, resultUrl, status, statusError, checking,
    error, notice, loading, submitting, observing, cancelling, exporting, saved, downloaded, acceptanceUnknown, job, preview, taskIssue,
    pending, awaitingResult, locked, dirty, progress, refreshStatus, loadSource, restoreRequest, canStartNew, startNew, observe, cancel, run, exportResult }
}

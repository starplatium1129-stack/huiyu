import { computed, onScopeDispose, reactive, ref, shallowRef, watch } from 'vue'
import { qwenModels, qwenStatus, uploadQwenImage, readQwenTaskInput, type QwenModelStatus } from '@/api/qwenApi'
import { MOSS_MODEL_ID, mossModels, mossStatus } from '@/api/mossApi'
import { compileMossPrompt, MOSS_NEGATIVE } from '@/utils/mossPrompt'
import { fetchRuntimeResult, getRuntimeTask, hasRuntimeTasks,
  runtimeResultPath, taskMessage, type TaskRecord } from '@/api/runtimeTasks'
import { useAcceptedTaskSession, taskSettled as terminal } from '@/composables/tasks/useAcceptedTaskSession'
import { MOSS_REQUEST_DRAFT_KEY, QWEN_REQUEST_DRAFT_KEY, QWEN_EDITOR_REQUEST_DRAFT_KEY } from '@/utils/storageKeys'
import { imageMediaSession } from '@/platform/imageMediaSession'
import { onDesktopRuntime } from '@/platform/desktop/runtime'
import { archiveTaskResult } from '@/composables/tasks/taskArtwork'
import { inspectMangaImage, mangaInputSize, prepareMangaImage, type MangaImage } from '@/composables/manga/mangaImage'
import { downloadMangaPng } from '@/composables/manga/mangaResult'
import { createQwenDraftStorage, qwenParentId, type QwenDraftState } from '@/storage/qwenStudioDraft'
import { taskArtworkId } from '@/application/artwork/taskResultIdentity'
import { artworkRepository } from '@/storage/artworkRepository'

const message = (cause: unknown) => cause instanceof Error ? cause.message : '操作未完成，请重试'
export function useQwenStudio(mode: 'qwen' | 'moss' = 'qwen', editor = false) {
  const moss = mode === 'moss', family = moss ? 'moss-image' : 'qwen-image'
  const modelOptions = moss ? mossModels : qwenModels, label = moss ? 'MOSS' : 'Qwen'
  const slot = editor ? QWEN_EDITOR_REQUEST_DRAFT_KEY : moss ? MOSS_REQUEST_DRAFT_KEY : QWEN_REQUEST_DRAFT_KEY
  const alignment = moss ? 16 : 32, maxSize = moss ? 1536 : 2816
  const form = reactive({ modelId: moss ? MOSS_MODEL_ID : 'qwen-image-2.1-turbo', prompt: '', negative: moss ? MOSS_NEGATIVE : '',
    width: moss ? 768 : 1024, height: moss ? 1280 : 1024, steps: moss ? 50 : 40, cfg: moss ? 3.5 : 4, seed: 0,
    mossAcceleration: 'off' as 'off' | 'spectrum' })
  const randomSeed = ref(true), resize = ref(false), source = shallowRef<MangaImage | null>(null), sourceUrl = ref('')
  const references = shallowRef<{ id: string; image: MangaImage; url: string }[]>([])
  const restoredInputMissing = ref(false), parentId = ref<string | number | null>(null)
  const draftStatus = ref(''), draftFailed = ref(false), draftRecoveryNeeded = ref(false), draftRecoveryError = ref('')
  const draftStorage = createQwenDraftStorage(mode, editor)
  let draftTimer: ReturnType<typeof setTimeout> | undefined, draftActive = false, draftVersion = 0
  const persistDraft = async () => {
    if (!draftActive || sourceChanged.value) return false
    const version = ++draftVersion
    draftStatus.value = '正在保存草稿…'
    try {
      await draftStorage.save({ form: { ...form }, randomSeed: randomSeed.value, resize: resize.value, parentId: parentId.value,
        resultTaskId: result.value?.taskId || task.value?.taskId || null, source: source.value, references: references.value.map(value => ({ id: value.id, image: value.image })) })
      if (version === draftVersion) { draftFailed.value = false; draftStatus.value = '草稿已保存，重新打开可继续' }
      return version === draftVersion && !lifetime.signal.aborted
    } catch (cause) {
      if (version === draftVersion) { draftFailed.value = true; draftStatus.value = '草稿尚未保存：' + message(cause) }
      return false
    }
  }
  const models = shallowRef<QwenModelStatus[]>([]), checking = ref(false), ready = ref(false), initializing = ref(false), statusError = ref('')
  const result = shallowRef<TaskRecord | null>(null), resultBlob = shallowRef<Blob | null>(null), resultUrl = ref('')
  const busy = ref(false), importing = ref(false), observing = ref(false), cancelling = ref(false), saving = ref(false), saved = ref(false)
  const error = ref(''), notice = ref(''), sourceChanged = ref(false)
  const lifetime = new AbortController(), owner = imageMediaSession()
  let cancelled = false
  const invalidateSource = () => { if (imageMediaSession() !== owner) sourceChanged.value = true }
  // Workspace and connection publications are not Vue refs; reconnect cannot revive this visit.
  const stopRuntime = onDesktopRuntime(invalidateSource)
  watch(imageMediaSession, invalidateSource, { flush: 'sync' })
  const check = () => {
    lifetime.signal.throwIfAborted()
    if (sourceChanged.value || imageMediaSession() !== owner) throw new Error('工作区或运行时连接已变化，请重新打开页面；原任务仍保留在任务中心')
  }
  const session = useAcceptedTaskSession({ slot, kinds: [mode], signal: lifetime.signal, check, validate: validateTask })
  const { task, request, unresolved, accept, release: releaseRequest } = session
  watch([form, randomSeed, resize, source, references, parentId, result], () => {
    if (!draftActive) return
    clearTimeout(draftTimer); draftVersion++; draftStatus.value = '草稿待保存…'
    draftTimer = setTimeout(() => { void persistDraft() }, 400)
  }, { deep: true, flush: 'sync' })
  const selected = computed(() => models.value.find(model => model.id === form.modelId))
  const turbo = computed(() => form.modelId === 'qwen-image-2.1-turbo')
  const locked = computed(() => !ready.value || busy.value || importing.value || observing.value || saving.value || cancelling.value || unresolved.value)
  const inputSize = computed(() => source.value ? mangaInputSize(source.value) : null)
  const needsResize = computed(() => inputSize.value?.resized || references.value.some(value => mangaInputSize(value.image).resized))
  const issue = computed(() => sourceChanged.value ? '请重新打开页面以连接当前工作区' : !hasRuntimeTasks() ? '请先启用本机私人工作区'
    : !selected.value?.available ? selected.value?.unavailableReason || statusError.value || `请先准备所选 ${label} 模型`
      : restoredInputMissing.value ? '原任务输入未恢复，请重新读取输入，或移除输入改为文生图'
        : !form.prompt.trim() ? '填写画面描述或编辑指令' : needsResize.value && !resize.value ? '请勾选缩小输入图片副本' : '')
  const canRun = computed(() => !locked.value && !issue.value)
  const progress = computed(() => typeof task.value?.metadata.progress === 'number' ? Math.round(Math.max(0, Math.min(1, task.value.metadata.progress)) * 100) : null)
  const taskText = computed(() => task.value ? taskMessage(task.value) : request.value ? '接收状态待确认，请查询原操作或请求取消' : '')
  function setUrl(target: typeof sourceUrl, blob: Blob | null) {
    if (target.value) URL.revokeObjectURL(target.value)
    target.value = blob ? URL.createObjectURL(blob) : ''
  }
  function validateTask(value: TaskRecord) {
    if (value.kind !== mode || value.provider !== 'native' || value.input.family !== family) throw new Error(`任务类型与 ${label} 创作不符`)
    const context = value.metadata.context
    if (context !== undefined && context !== null && (typeof context !== 'object' || Array.isArray(context))) throw new Error('图像任务来源信息无效')
    const parent = (context as Record<string, unknown> | null | undefined)?.parentId
    if (parent !== undefined && parent !== null && !qwenParentId(parent)) throw new Error('来源作品身份无效')
  }
  async function refresh() {
    if (checking.value) return
    checking.value = true; statusError.value = ''
    try { check(); const values = await (moss ? mossStatus : qwenStatus)(lifetime.signal); check(); models.value = values }
    catch (cause) { if (!lifetime.signal.aborted) { models.value = []; statusError.value = message(cause) } }
    finally { checking.value = false }
  }
  async function loadSource(file: File) {
    if (moss || locked.value) return
    importing.value = true; error.value = ''
    try { check(); const image = await inspectMangaImage(file, file.name); check(); source.value = image; parentId.value = null; draftActive = !draftRecoveryNeeded.value; restoredInputMissing.value = false; resize.value = false; setUrl(sourceUrl, image.blob) }
    catch (cause) { if (!lifetime.signal.aborted) error.value = message(cause) }
    finally { importing.value = false; if (draftActive) void persistDraft() }
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
    references.value = []; source.value = null; parentId.value = null; draftActive = !draftRecoveryNeeded.value; restoredInputMissing.value = false; resize.value = false; setUrl(sourceUrl, null); void persistDraft()
  }
  function moveReference(id: string, offset: -1 | 1) {
    if (locked.value) return
    const index = references.value.findIndex(value => value.id === id), destination = index + offset
    if (index < 0 || destination < 0 || destination >= references.value.length) return
    const next = [...references.value], [value] = next.splice(index, 1)
    next.splice(destination, 0, value!); references.value = next
    notice.value = `参考图已移至图 ${destination + 2}`
  }
  async function restoreTaskInputs(value: TaskRecord) {
    if (!value.input.initImage) {
      for (const item of references.value) URL.revokeObjectURL(item.url)
      references.value = []; source.value = null; setUrl(sourceUrl, null); restoredInputMissing.value = false
      return
    }
    restoredInputMissing.value = true
    const images: MangaImage[] = []
    const count = 1 + (Array.isArray(value.input.referenceImages) ? value.input.referenceImages.length : 0)
    if (count > 4) throw new Error('原任务输入数量无效')
    for (let index = 0; index < count; index++) {
      const blob = await readQwenTaskInput(value, index, lifetime.signal); check()
      images.push(await inspectMangaImage(blob, index === 0 ? '原任务原图' : `原任务参考图 ${index}`)); check()
    }
    for (const item of references.value) URL.revokeObjectURL(item.url)
    source.value = images[0]!; setUrl(sourceUrl, source.value.blob)
    references.value = images.slice(1).map(image => ({ id: crypto.randomUUID(), image, url: URL.createObjectURL(image.blob) }))
    restoredInputMissing.value = false
  }
  async function retryInputs() {
    if (!task.value || importing.value || busy.value) return
    importing.value = true; error.value = ''
    try { check(); await restoreTaskInputs(task.value); draftActive = !draftRecoveryNeeded.value; void persistDraft(); notice.value = '已恢复原任务的原图及参考图' }
    catch (cause) { if (!lifetime.signal.aborted) error.value = message(cause) }
    finally { importing.value = false }
  }
  async function continueResult() {
    if (moss || locked.value || !result.value || !resultBlob.value) return
    importing.value = true; error.value = ''
    try {
      check(); const output = result.value, image = await inspectMangaImage(resultBlob.value, '上一轮编辑结果'); check()
      await releaseRequest(); check()
      for (const value of references.value) URL.revokeObjectURL(value.url)
      references.value = []; source.value = image; setUrl(sourceUrl, image.blob); restoredInputMissing.value = false
      draftActive = !draftRecoveryNeeded.value; parentId.value = taskArtworkId(output.taskId, 0); form.prompt = ''; task.value = null; resize.value = false
      notice.value = '已将当前结果作为新原图，请填写下一步指令；上一轮结果仍可导出或入册'
    } catch (cause) { if (!lifetime.signal.aborted) error.value = message(cause) }
    finally { importing.value = false }
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
      const completed = await session.observe()
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
      const value = await session.cancel()
      if (value) { notice.value = '取消请求已记录，等待后端确认'; if (!observing.value) void observe() }
      else notice.value = '取消意图已保存，原请求不会再执行'
    } catch (cause) { if (!lifetime.signal.aborted) error.value = '取消尚未确认：' + message(cause) }
    finally { cancelling.value = false }
  }
  async function run(recipe?: { negative: string; context: Record<string, unknown> }) {
    if (!canRun.value) return
    busy.value = true; cancelled = false; error.value = ''; notice.value = ''
    try {
      check()
      if (!modelOptions.some(model => model.value === form.modelId) || form.prompt.trim().length > 12000 || (recipe?.negative ?? form.negative).length > 8000) throw new Error('模型或提示词参数无效')
      if (![form.width, form.height].every(n => Number.isInteger(n) && n >= 512 && n <= maxSize && n % alignment === 0)) throw new Error(`宽高需为 512—${maxSize} 内的 ${alignment} 倍数`)
      if (!randomSeed.value && (!Number.isInteger(form.seed) || form.seed < 0 || form.seed > 2147483647)) throw new Error('种子需为 0—2147483647 的整数')
      const negative = turbo.value ? '' : (recipe?.negative ?? form.negative).trim()
      if (!turbo.value && (!Number.isInteger(form.steps) || form.steps < 1 || form.steps > 100
        || !moss && negative && (!Number.isFinite(form.cfg) || form.cfg <= 1 || form.cfg > 20))) throw new Error('步数需为 1—100；有负向描述时 CFG 需大于 1 且不超过 20')
      if (moss && (!Number.isFinite(form.cfg) || form.cfg < 0 || form.cfg > 20)) throw new Error('CFG 需为 0—20 内的数值')
      if (moss && (form.mossAcceleration !== 'off' && form.mossAcceleration !== 'spectrum'
        || form.mossAcceleration === 'spectrum' && !selected.value?.mossSpectrum)) throw new Error('当前后端尚未提供 MOSS Spectrum，请更新并重启或关闭缓存加速')
      const compiled = moss ? compileMossPrompt(form.prompt, negative) : { prompt: form.prompt.trim(), negative }
      if (compiled.prompt.length > 12000) throw new Error('加入模型质量词后的提示词超过 12000 字符，请精简描述')
      if (moss && (source.value || references.value.length)) throw new Error('MOSS 当前仅支持文生图，请移除编辑输入')
      const input: Record<string, unknown> = { modelId: form.modelId, ...compiled,
        ...(moss ? { mossAcceleration: form.mossAcceleration } : {}),
        width: form.width, height: form.height, steps: turbo.value ? 8 : form.steps, cfg: moss || negative ? form.cfg : 1,
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
      await session.submit(mode, input, { ...structuredClone(recipe?.context ?? {}), parentId: parentId.value, editor: !!source.value }, undefined, () => cancelled)
      if (cancelled) await cancel()
      void observe()
    } catch (cause) { if (!lifetime.signal.aborted) error.value = message(cause) }
    finally { busy.value = false }
  }
  async function exportResult(kind: 'save' | 'download') {
    const output = result.value, blob = resultBlob.value
    if (!output || saving.value || busy.value || importing.value || kind === 'save' && saved.value) return
    const isCurrent = () => result.value?.taskId === output.taskId
    saving.value = true; error.value = ''
    try {
      check()
      if (kind === 'save') {
        await archiveTaskResult(output.taskId); check()
        if (isCurrent()) { saved.value = true; notice.value = '已存入我的作品' }
      } else if (blob) {
        const downloaded = await downloadMangaPng(blob, `绘遇-${label}-${output.taskId}.png`); check()
        if (downloaded && isCurrent()) notice.value = 'PNG 已导出'
      }
    } catch (cause) { if (!lifetime.signal.aborted && isCurrent()) error.value = message(cause) }
    finally { saving.value = false }
  }
  async function clearResult() {
    if (locked.value) return
    try {
      await releaseRequest(); task.value = null; result.value = null; resultBlob.value = null; saved.value = false; setUrl(resultUrl, null)
      void persistDraft()
    } catch (cause) { if (!lifetime.signal.aborted) error.value = message(cause) }
  }
  function applyDraft(draft: QwenDraftState) {
    Object.assign(form, draft.form); randomSeed.value = draft.randomSeed; resize.value = draft.resize; parentId.value = draft.parentId
    source.value = draft.source; setUrl(sourceUrl, draft.source?.blob ?? null)
    for (const value of references.value) URL.revokeObjectURL(value.url)
    references.value = draft.references.map(value => ({ ...value, url: URL.createObjectURL(value.image.blob) }))
    restoredInputMissing.value = false; draftStatus.value = '已恢复上次创作草稿'
  }
  async function recoverDraft() {
    if (locked.value) return
    importing.value = true; draftActive = false
    try {
      check(); const draft = await draftStorage.restore(lifetime.signal); check()
      if (!draft) throw new Error('旧草稿记录不存在，可保留恢复槽后保存当前创作')
      await releaseRequest(); task.value = null; result.value = null; resultBlob.value = null; setUrl(resultUrl, null)
      applyDraft(draft); draftRecoveryNeeded.value = false; draftRecoveryError.value = ''; draftActive = true
      if (draft.resultTaskId) {
        try { const found = await getRuntimeTask(draft.resultTaskId, lifetime.signal); check(); accept(found); void observe() }
        catch (cause) { check(); notice.value = '草稿已恢复，上次结果可到任务中心核对：' + message(cause) }
      }
    } catch (cause) { if (!lifetime.signal.aborted) draftRecoveryError.value = message(cause) }
    finally { importing.value = false }
  }
  async function preserveAndSaveDraft() {
    if (locked.value || !draftRecoveryNeeded.value || restoredInputMissing.value) return
    importing.value = true
    try {
      check()
      await draftStorage.save({ form: { ...form }, randomSeed: randomSeed.value, resize: resize.value, parentId: parentId.value,
        resultTaskId: result.value?.taskId || task.value?.taskId || null, source: source.value,
        references: references.value.map(value => ({ id: value.id, image: value.image })) }, true)
      check(); draftRecoveryNeeded.value = false; draftRecoveryError.value = ''; draftFailed.value = false; draftActive = true
      draftStatus.value = '当前创作已保存，旧草稿保留在恢复槽'
    } catch (cause) { if (!lifetime.signal.aborted) draftRecoveryError.value = message(cause) }
    finally { importing.value = false }
  }
  async function initialize(modelId?: string, taskId?: string, artworkId?: string) {
    if (initializing.value || ready.value) return
    initializing.value = true; error.value = ''
    try {
      check()
      let draft: QwenDraftState | null = null
      try { draft = await draftStorage.restore(lifetime.signal); check() }
      catch (cause) {
        check(); draftRecoveryNeeded.value = true; draftRecoveryError.value = message(cause)
        draftStatus.value = '旧草稿仍保留，当前创作尚未自动保存'
      }
      if (draft) applyDraft(draft)
      if (modelOptions.some(model => model.value === modelId)) form.modelId = modelId!
      session.restore()
      if (request.value) {
        await session.resolve()
        if (terminal(task.value)) await releaseRequest()
      }
      if (!taskId && !artworkId && !task.value && !request.value && draft?.resultTaskId) {
        try { const found = await getRuntimeTask(draft.resultTaskId, lifetime.signal); check(); accept(found) }
        catch (cause) { check(); notice.value = '上次结果未能读取，可到任务中心核对：' + message(cause) }
      }
      if (taskId && !request.value) {
        const found = await getRuntimeTask(taskId, lifetime.signal); check(); accept(found)
      } else if (taskId && taskId !== task.value?.taskId) {
        notice.value = '上次操作尚未确认，已恢复原请求；其他结果可在任务中心查看'
      }
      const input = request.value?.input || (taskId || !draft ? task.value?.input : undefined)
      if (input) {
        for (const key of Object.keys(form) as (keyof typeof form)[]) {
          const value = input[key]
          if (typeof value === typeof form[key]) Object.assign(form, { [key]: value })
        }
        randomSeed.value = typeof input.seed !== 'number'
        if (moss) form.mossAcceleration = input.mossAcceleration === 'spectrum' ? 'spectrum' : 'off'
        const context = request.value?.context || task.value?.metadata.context
        parentId.value = context && typeof context === 'object' && qwenParentId((context as Record<string, unknown>).parentId)
          ? (context as Record<string, unknown>).parentId as string | number : null
        if (task.value) {
          try { await restoreTaskInputs(task.value) }
          catch (cause) { check(); restoredInputMissing.value = !!input.initImage; error.value = message(cause) }
        } else if (input.initImage && !source.value) restoredInputMissing.value = true
      }
      if (artworkId && !moss) {
        if (unresolved.value) notice.value = '上次操作尚未确认，已恢复原请求；结束后可从作品册再次打开编辑'
        else {
          try {
            const artwork = await artworkRepository.readArtwork(artworkId); check()
            if (!artwork?.image_id) throw new Error('作品原图不可用，请重新导入本地图片')
            if (!qwenParentId(artwork.id)) throw new Error('来源作品身份无效，请在作品册核对')
            const blob = await artworkRepository.getImage(artwork.image_id, lifetime.signal); check()
            if (!blob) throw new Error('作品原图无法读取，请重新导入本地图片')
            source.value = await inspectMangaImage(blob, artwork.sceneTitle || '作品原图'); check()
            for (const value of references.value) URL.revokeObjectURL(value.url)
            references.value = []; parentId.value = artwork.id
            setUrl(sourceUrl, source.value.blob); restoredInputMissing.value = false; form.prompt = ''; task.value = null
            if (qwenModels.some(model => model.value === artwork.checkpoint)) form.modelId = artwork.checkpoint!
            notice.value = '已导入作品副本，请填写编辑指令；原作品保持不变'
          } catch (cause) { check(); error.value = message(cause) }
        }
      }
      draftActive = !restoredInputMissing.value && !draftRecoveryNeeded.value; ready.value = true
      if (draftActive) void persistDraft()
      void refresh()
      if (request.value || task.value) void observe()
    } catch (cause) { if (!lifetime.signal.aborted) error.value = message(cause) }
    finally { initializing.value = false }
  }
  onScopeDispose(() => { stopRuntime(); clearTimeout(draftTimer); void persistDraft(); lifetime.abort(); setUrl(sourceUrl, null); setUrl(resultUrl, null); for (const value of references.value) URL.revokeObjectURL(value.url) })
  return { modelOptions, alignment, maxSize, form, randomSeed, resize, source, sourceUrl, references, needsResize, restoredInputMissing, selected, turbo, checking, statusError, task, request, result, resultUrl, resultBlob,
    busy, importing, observing, cancelling, saving, saved, error, notice, locked, unresolved, issue, canRun, inputSize, progress, taskText,
    ready, initializing, draftRecoveryNeeded, draftRecoveryError, recoverDraft, preserveAndSaveDraft, draftStatus, draftFailed, persistDraft, parentId, continueResult, retryInputs, moveReference, refresh, loadSource, removeSource, addReferences, removeReference, run, cancel, observe, exportResult, clearResult, initialize }
}

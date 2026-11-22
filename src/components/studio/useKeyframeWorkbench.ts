import { computed, nextTick, onMounted, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { cancelKeyframe, generateKeyframe, listKeyframeModels } from '@/api/keyframeApi'
import { AcceptedTaskTerminalError, TaskSubmissionRejected } from '@/api/acceptedTaskOutcome'
import { DirectRequestRejected } from '@/api/directGenerationRequests'
import type { captureStudioProjectRepository, StudioAssetVersion, StudioProjectSnapshot } from '@/storage/studioProjectRepository'
import { assetLabels, projectAssetIndex, referenceIssue } from './projectAssets'
import {
  batchJobs,
  candidatePrompt,
  canvasSupported,
  canvases,
  cloneData,
  editableSeed,
  keyframeModelId,
  newKeyframeDraft,
  pendingCandidate,
  readKeyframeDraft,
  variationLines,
  type Candidate,
  type WorkbenchForm,
} from './keyframeDraft'

interface Options {
  data: StudioProjectSnapshot
  repo: ReturnType<typeof captureStudioProjectRepository>
  refresh: () => Promise<void>
}

async function neutralVersionId(characterVersionId: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(characterVersionId))
  return 'neutral-' + Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function useKeyframeWorkbench(props: Options) {
  let project = props.data.project
  const notice = ref(''),
    writeError = ref(''),
    loadingModels = ref(false),
    starting = ref(false),
    saving = ref(false),
    busy = ref(false),
    cancelling = ref(false)
  const draft = ref(newKeyframeDraft())
  try {
    draft.value = readKeyframeDraft(project.workbench)
  } catch (e) {
    writeError.value = message(e)
  }
  const models = shallowRef<Awaited<ReturnType<typeof listKeyframeModels>>>([]),
    modelError = ref('')
  const model = computed(() => models.value.find((item) => item.id === draft.value.form.modelId))
  const preferredModel = computed(() =>
    models.value.find((item) => item.id === keyframeModelId && item.available)
    ?? models.value.find((item) => item.id === 'flux-kontext-dev' && item.available)
  )
  const remaining = computed(
    () => batchJobs(draft.value.batch).some(pendingCandidate)
  )
  const locked = computed(() => starting.value || busy.value || cancelling.value || remaining.value || !!writeError.value)
  const lifetime = new AbortController()
  let observer: AbortController | undefined, flight: Promise<void> | undefined, modelRead: AbortController | undefined
  let writeTail: Promise<void> = Promise.resolve(),
    timeout: ReturnType<typeof setTimeout> | undefined,
    dirty = false,
    disposed = false
  function message(e: unknown) {
    return e instanceof Error ? e.message : '操作未完成，请重试'
  }
  function persist(): Promise<void> {
    clearTimeout(timeout)
    timeout = undefined
    if (writeError.value) return Promise.reject(new Error(writeError.value))
    const value: Record<string, unknown> = { ...cloneData(draft.value) }
    dirty = false
    saving.value = true
    const save = writeTail.then(async () => {
      if (writeError.value) throw new Error(writeError.value)
      props.repo.assertCurrent()
      project = await props.repo.saveWorkbench(project, value)
    })
    writeTail = save.catch((e) => {
      writeError.value = message(e)
    })
    const settled = writeTail
    void settled.then(() => {
      if (writeTail === settled) saving.value = false
    })
    return save
  }
  watch(
    () => [draft.value.form, draft.value.guide],
    () => {
      if (disposed || writeError.value) return
      dirty = true
      clearTimeout(timeout)
      timeout = setTimeout(() => {
        void persist().catch(() => {})
      }, 300)
    },
    { deep: true, flush: 'sync' }
  )
  async function flushDraft() {
    if (dirty) await persist()
    await writeTail
    if (writeError.value) throw new Error(writeError.value)
  }
  async function loadModels() {
    modelRead?.abort()
    const read = (modelRead = new AbortController())
    loadingModels.value = true
    modelError.value = ''
    try {
      const list = await listKeyframeModels(read.signal)
      if (!read.signal.aborted) {
        models.value = list
        if (!project.workbench && !dirty && !remaining.value && !model.value?.available) {
          const first = preferredModel.value
          if (first) draft.value.form.modelId = first.id
        }
      }
    } catch (e) {
      if (!read.signal.aborted) modelError.value = message(e)
    } finally {
      if (modelRead === read) loadingModels.value = false
    }
  }
  function addReferences(ids: string[]) {
    if (locked.value) {
      notice.value = '完成或取消当前批次后可更改参考图。'
      return
    }
    const form = draft.value.form,
      next = [...form.references]
    for (const id of ids) {
      const version = byId(id)
      const issue = referenceIssue(version)
      if (issue) {
        notice.value = issue
        return
      }
      if (!next.includes(id)) next.push(id)
    }
    const limit = model.value?.maxReferences ?? 4
    if (next.length > limit) {
      notice.value = `这个模型最多使用 ${limit} 张参考图。`
      return
    }
    form.references = next
    notice.value = ''
  }
  function moveReference(index: number, step: number) {
    const refs = draft.value.form.references
    if (locked.value || index + step < 0 || index + step >= refs.length) return
    const [id] = refs.splice(index, 1)
    if (id) refs.splice(index + step, 0, id)
  }
  const byId = (id: string) => projectAssetIndex(props.data).versions.get(id)
  async function executeCandidate(
    job: Candidate, form: WorkbenchForm, index: number, count: number, signal: AbortSignal,
    prepared?: StudioAssetVersion
  ): Promise<StudioAssetVersion | undefined> {
    signal.throwIfAborted()
    props.repo.assertCurrent()
    const existing = byId(job.versionId)
    if (!pendingCandidate(job)) return existing
    if (existing) {
      job.state = 'done'
      await persist()
      return existing
    }
    const canvas = canvases[form.canvas]
    const images: Blob[] = []
    const resume = job.state === 'sent'
    const stage = form.keyframe?.neutralAnchor ? '正在整理干净立绘' : `候选 ${index + 1}/${count}`
    notice.value = `${stage} · ${resume ? '正在接回原任务' : '准备参考图'}`
    if (!resume) {
      for (const id of form.references) {
        const version = prepared?.id === id ? prepared : byId(id)
        if (!version) throw new Error('有一张参考图已无法读取')
        images.push(await props.repo.readOriginal(version, signal))
        signal.throwIfAborted()
      }
    }
    const prompt = candidatePrompt(form, index)
    const result = await generateKeyframe(
      {
        modelId: form.modelId,
        prompt,
        seed: job.seed,
        steps: form.steps,
        width: canvas.width,
        height: canvas.height,
        images,
        requestKey: job.requestKey,
        resume,
        beforeSubmit: async () => {
          signal.throwIfAborted()
          job.state = 'sent'
          await persist()
          signal.throwIfAborted()
        },
      },
      signal,
      (progress) => {
        if (!signal.aborted) notice.value = `${stage} · ${progress}`
      }
    ).catch(async error => {
      if (!signal.aborted && (error instanceof AcceptedTaskTerminalError
        || error instanceof TaskSubmissionRejected || error instanceof DirectRequestRejected)) {
        job.state = error instanceof AcceptedTaskTerminalError && error.status === 'cancelled' ? 'cancelled' : 'failed'
        const batch = draft.value.batch
        if (batch?.preparation?.job.versionId === job.versionId) {
          for (const candidate of batch.jobs) {
            if (candidate.state === 'ready') candidate.state = 'cancelled'
          }
        }
        await persist()
      }
      throw error
    })
    images.length = 0
    signal.throwIfAborted()
    props.repo.assertCurrent()
    const title = form.variationTitles?.[index] || form.title || assetLabels[form.kind]
    const version = await props.repo.importAsset({
      title: count > 1 ? `${title.slice(0, 150)} · ${index + 1}` : title.slice(0, 160),
      kind: form.kind,
      blob: result.blob,
      versionId: job.versionId,
      source: {
        kind: 'generation',
        taskId: result.taskId,
        outputIndex: 0,
        inputVersionIds: [...form.references],
        modelId: form.modelId,
        seed: job.seed,
        width: canvas.width,
        height: canvas.height,
        prompt,
        ...(form.keyframe ? { keyframe: form.keyframe } : {}),
      },
    }).catch(async error => {
      // Another project can finish preparing this same source first.
      if (!form.keyframe?.neutralAnchor) throw error
      signal.throwIfAborted()
      await props.refresh()
      await nextTick()
      const saved = byId(job.versionId)
      if (saved?.source.kind === 'generation' && saved.source.keyframe?.neutralAnchor
        && saved.source.keyframe.characterVersionId === form.keyframe.characterVersionId) return saved
      throw error
    })
    signal.throwIfAborted()
    job.state = 'done'
    await persist()
    await props.refresh()
    return version
  }
  async function execute(signal: AbortSignal) {
    const batch = draft.value.batch
    if (!batch) return
    const prep = batch.preparation
    let prepared: StudioAssetVersion | undefined
    const needsPrepared = batch.jobs.some(pendingCandidate)
    if (prep && (needsPrepared || pendingCandidate(prep.job))) {
      prepared = await executeCandidate(prep.job, prep.form, 0, 1, signal)
      if (!prepared && needsPrepared) {
        await props.refresh()
        await nextTick()
        prepared = byId(prep.job.versionId)
      }
      if (!prepared && needsPrepared) throw new Error('找不到已整理的立绘，请取消剩余候选后重试')
      const current = draft.value.form
      if (prepared && current.references[0] === prep.form.references[0] && current.prompt === batch.form.prompt
        && current.variations === batch.form.variations) current.references[0] = prepared.id
    }
    for (const [index, job] of batch.jobs.entries()) {
      await executeCandidate(job, batch.form, index, batch.jobs.length, signal, prepared)
    }
    const incomplete = batch.jobs.filter(job => job.state !== 'done').length
    notice.value = batch.form.kind === 'character' ? '干净立绘已准备好。'
      : incomplete === batch.jobs.length && prep?.job.state === 'done' ? '已保存干净立绘，剩余候选已取消。'
      : incomplete ? `已收入生成成功的候选，有 ${incomplete} 张未完成。` : '候选已收入素材库。'
  }
  function run(): Promise<void> {
    if (flight) return flight
    if (disposed || cancelling.value || writeError.value || !remaining.value) return Promise.resolve()
    busy.value = true
    observer = new AbortController()
    const signal = observer.signal
    flight = (async () => {
      try {
        if (draft.value.batch?.paused) {
          draft.value.batch.paused = false
          await persist()
        }
        await execute(signal)
      } catch (e) {
        if (!signal.aborted && !disposed) notice.value = message(e)
      } finally {
        busy.value = false
        flight = undefined
        observer = undefined
      }
    })()
    return flight
  }
  function jobsFor(form: WorkbenchForm, pendingVersionId?: string): Candidate[] {
    const capabilities = models.value.find(item => item.id === form.modelId)
    if (!form.prompt.trim() || !form.references.length || !capabilities?.available)
      throw new Error('请选择已就绪的模型、参考图和编辑指令。')
    const digests = new Set<string>()
    for (const id of form.references) {
      if (id === pendingVersionId) continue
      const version = byId(id)
      const issue = referenceIssue(version)
      if (issue || !version) throw new Error(issue)
      if (digests.has(version.sha256)) throw new Error('参考图中有相同的原件，请去掉重复图片。')
      digests.add(version.sha256)
    }
    if (form.references.length > capabilities.maxReferences || !canvasSupported(capabilities, form.canvas))
      throw new Error('这个模型不支持当前画幅或参考图数量，请调整后生成')
    if (form.steps !== undefined && (!Number.isInteger(form.steps) || form.steps < 1 || form.steps > 100
        || (form.modelId === keyframeModelId && form.steps !== capabilities.defaultSteps)))
      throw new Error('当前模型不支持这个采样步数')
    const count = variationLines(form).length || form.count
    if (count > 4 || Array.from({ length: count }, (_, index) => candidatePrompt(form, index)).some(prompt => prompt.length > 4000))
      throw new Error('每批最多四条变化指令，每张合并后的指令最多 4000 字')
    const initial = editableSeed(form.seedText, count)
    return Array.from({ length: count }, (_, i) => ({
      requestKey: `keyframe-${crypto.randomUUID()}`,
      versionId: crypto.randomUUID(),
      seed: initial === undefined ? crypto.getRandomValues(new Uint32Array(1))[0]! & 0x7fffffff : initial + i,
      state: 'ready',
    }))
  }
  async function start(input: WorkbenchForm, prepare?: WorkbenchForm) {
    if (locked.value) return
    starting.value = true
    try {
      const form = cloneData(input)
      const preparation = prepare ? { form: cloneData(prepare), job: jobsFor(prepare)[0]! } : undefined
      if (preparation?.form.keyframe?.neutralAnchor) {
        preparation.job.versionId = await neutralVersionId(preparation.form.keyframe.characterVersionId)
        form.references[0] = preparation.job.versionId
      }
      const jobs = jobsFor(form, preparation?.job.versionId)
      if (form.keyframe?.neutralAnchor) jobs[0]!.versionId = await neutralVersionId(form.keyframe.characterVersionId)
      if (disposed) return
      draft.value.batch = { form, jobs, paused: false, ...(preparation ? { preparation } : {}) }
      await persist()
    } catch (e) {
      if (!disposed) notice.value = message(e)
      return
    } finally {
      starting.value = false
    }
    if (!disposed) await run()
  }
  async function cancelBatch() {
    if (!remaining.value || cancelling.value || writeError.value) return
    cancelling.value = true
    const batch = draft.value.batch!
    batch.paused = true
    observer?.abort()
    try {
      // Persist the unsent cancellations first. Recovering an already-finished
      // upstream request must never start the rest of a cancelled batch.
      for (const job of batchJobs(batch)) {
        if (job.state === 'ready') job.state = 'cancelled'
      }
      await persist()
      await flight
      for (const job of batchJobs(batch)) {
        if (job.state !== 'sent') continue
        await cancelKeyframe(job.requestKey, lifetime.signal)
        lifetime.signal.throwIfAborted()
        job.state = 'cancelled'
        await persist()
      }
      notice.value = '已取消未完成的候选。已收入素材库的结果已保留。'
    } catch (e) {
      if (!disposed) notice.value = message(e)
    } finally {
      cancelling.value = false
    }
  }
  onMounted(() => {
    if (remaining.value && !draft.value.batch?.paused) void run()
  })
  onScopeDispose(() => {
    disposed = true
    modelRead?.abort()
    lifetime.abort()
    observer?.abort()
    clearTimeout(timeout)
    if (dirty) void persist().catch(() => {})
  })
  return {
    draft,
    notice,
    writeError,
    modelError,
    models,
    model,
    preferredModel,
    loadingModels,
    saving,
    busy,
    cancelling,
    remaining,
    locked,
    loadModels,
    addReferences,
    moveReference,
    flushDraft,
    start,
    run,
    cancelBatch,
  }
}

import { assertRequestOwner, clearRequestDraft, writeRequestDraft } from '@/storage/requestDraft'
import { ref } from 'vue'
import { apiClient, ApiClientError } from '@/api/client'
import { AcceptedTaskTerminalError } from '@/api/acceptedTaskOutcome'
import { hasRuntimeTasks, submitRuntimeTask, waitForRuntimeTask, getRuntimeTaskByKey, cancelRuntimeTaskKey, runtimeResultPath, taskMessage, type TaskRecord } from '@/api/runtimeTasks'
import { refreshProfileStorage } from '@/platform/web/profileStorage'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { useSceneStore } from '@/stores/sceneStore'
import { newImageRequestDraft, readImageRequestDraft, type ImageRequestDraft } from '@/storage/imageRequestDraft'
import { COMPANION_IMAGE_REQUEST_KEY } from '@/utils/storageKeys'
import { sameTempResultOwner, tempResultOwner, type TempResultOwner } from '@/utils/tempResult'
import { DRAW_ENGINE_SETTING, STARTER_MODEL_SETTING, settingsRepository } from '@/storage/settingsRepository'
import { readDrawingSettings } from '@/storage/drawingSettings'
import { initialAnimaState } from '@/composables/generation/useAnimaSession'
import { animaRequestPayload, closestSupportedSize, ANIMA_LORA_BY_CHARACTER, type AnimaStatusResponse, type AnimaSubmission } from '@/composables/generation/animaSessionContract'
import { buildAnimaRequest } from '@/composables/generation/buildAnimaRequest'
import { nativeAnimaRequestBlocker } from '@/composables/generation/nativeAnimaCapabilities'
import { useUnifiedPromptAssembly } from '@/composables/useUnifiedPromptAssembly'
import { archiveTaskResult } from '@/composables/tasks/taskArtwork'
import { interrogateImage } from '@/api/interrogateImage'
import { assertWorkspaceMediaAuthority, type MediaSource } from '@/platform/desktop/workspaceMediaSource'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'
import { captureResultContext } from '@/utils/resultContext'
import { endfieldAnimaBinding } from '@/utils/loraCatalog'
import { companionPromptDraft, validateCompanionImageArgs, type CompanionImageArgs } from './companionImagePrompt'
export type { CompanionImageArgs } from './companionImagePrompt'

export interface CompanionImageResult {
  taskId: string; resultPath: string; output: string; character: string; description: string
  imageId?: string; artworkId?: string
}
let busy = false

async function prepare(args: CompanionImageArgs, options: { referenceImage?: string | Readonly<MediaSource>; signal: AbortSignal; report?: (message: string) => void }): Promise<AnimaSubmission> {
  const { signal, report } = options
  const pb = usePromptBuilderStore()
  report?.('正在读取工作台的绘图设置…')
  const [, status] = await Promise.all([
    Promise.all([refreshProfileStorage(), pb.dataReady ? Promise.resolve() : pb.loadData()]),
    apiClient.request<AnimaStatusResponse>('/api/creative/status', { cache: 'no-store', cachePolicy: 'bypass', timeoutMs: 10_000, signal, validate: value => value.ok === true }),
  ])
  signal.throwIfAborted()
  const family = settingsRepository.get(DRAW_ENGINE_SETTING) || 'anima'
  const saved = readDrawingSettings(family)
  const state = initialAnimaState(family)
  const models = (status.models || []).filter(model => model.family === family)
  const desired = saved?.modelId || (family === 'anima' ? settingsRepository.get(STARTER_MODEL_SETTING) : null)
  const model = desired ? models.find(item => item.id === desired) : models.find(item => item.available !== false)
  if (!model || model.available === false) throw new Error('工作台选中的绘图模型尚未准备好，请先到绘图页准备模型')
  if (!status.online && status.managedStartAvailable !== true) throw new Error('绘图服务尚未连接，请先到控制面板连接绘图服务')
  state.models = models; state.loras = status.loras || []; state.styleLoras = status.styleLoras || []
  state.modelId = model.id; state.provider = status.provider === 'native' ? 'native' : 'comfy'
  if (!saved) {
    const defaults = model.defaults
    state.steps = Number(defaults?.steps) || state.steps
    state.cfg = typeof defaults?.cfg === 'number' && Number.isFinite(defaults.cfg) ? defaults.cfg : state.cfg
    state.sampler = String(defaults?.sampler || state.sampler); state.scheduler = String(defaults?.scheduler || state.scheduler)
    if (typeof defaults?.loraStrength === 'number') state.loraStrength = defaults.loraStrength
    if (typeof defaults?.teaCache === 'boolean') state.teaCache = defaults.teaCache
    if (typeof defaults?.teaCacheThresh === 'number') state.teaCacheThresh = defaults.teaCacheThresh
    const [width, height] = closestSupportedSize(model, pb.lastRecommendedSize).split('x').map(Number)
    state.width = width; state.height = height
  }
  const studio = args.character === 'nene' || args.character === 'natsume'
  if (!studio) await pb.loadPopularCharacter(args.character)
  signal.throwIfAborted()
  const binding = endfieldAnimaBinding(studio ? null : args.character, family, model.id)
  state.loraId = family === 'krea2' ? '' : studio ? ANIMA_LORA_BY_CHARACTER[args.character as 'nene' | 'natsume'] : binding?.loraId ?? ''
  if (binding && saved?.loraId !== binding.loraId) state.loraStrength = binding.loraStrength
  if (state.loraId) {
    await useSceneStore().loadLoraCatalog()
    signal.throwIfAborted()
    if (!pb.loraMeta.some(meta => meta.id === state.loraId || meta.name === state.loraId)) throw new Error('角色 LoRA 的提示词资料尚未准备好，请先在绘图页重新读取模型资料')
  }
  if (state.styleLoraId && !state.styleLoras.some(style => style.id === state.styleLoraId && style.available !== false)) throw new Error('工作台选择的风格 LoRA 尚未准备好，请先在绘图页重新选择')
  const inferred = options.referenceImage ? (report?.('正在反推参考图片的服装、姿势与背景…'), await interrogateImage(options.referenceImage, signal)) : undefined
  signal.throwIfAborted()
  const draft = companionPromptDraft(pb, args, state, inferred, report)
  const engine = ref(family), modelId = ref(state.modelId), loraId = ref(state.loraId)
  const assembly = useUnifiedPromptAssembly(draft, ref(''), engine, modelId, loraId)
  const request = buildAnimaRequest({ subject: draft.subject, char: draft.char, state, profile: assembly.modelProfile.value,
    prompt: assembly.positivePrompt.value, negative: assembly.negativePrompt.value })
  if (!request.prompt.trim()) throw new Error('没有可生成的画面描述，请补充描述后再试')
  if (state.provider === 'native') {
    const blocked = nativeAnimaRequestBlocker(state.models, request)
    if (blocked) throw new Error(blocked)
  }
  const context = { ...captureResultContext(draft), source: 'companion-chat' }
  return { family, request, context }
}

/** Chat retains the request until its image message has been durably saved. */
export async function acknowledgeCompanionImage(taskId: string) {
  const draft = readImageRequestDraft(COMPANION_IMAGE_REQUEST_KEY)
  if (draft?.resultId !== taskId) return
  assertRequestOwner(draft, hasRuntimeTasks())
  await clearRequestDraft(COMPANION_IMAGE_REQUEST_KEY, draft)
}

/** Both chat surfaces resume the frozen request before accepting a new drawing intent. */
export async function generateCompanionImage(args: CompanionImageArgs, options: {
  character: string; referenceImage?: () => Promise<string | Readonly<MediaSource> | undefined>
  signal: AbortSignal; report?: (message: string) => void
}): Promise<CompanionImageResult> {
  if (!isLocalStudioHost()) throw new Error('桌宠绘图工具仅限本机直连使用')
  if (!hasRuntimeTasks()) throw new Error('请在桌面客户端启用私人任务工作区后使用桌宠绘图')
  if (busy) throw new Error('桌宠正在处理上一张图片，请等待完成或先停止')
  options.signal.throwIfAborted()
  busy = true
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(10 * 60 * 1000)])
  let draft: ImageRequestDraft | null = null, cancellation: Promise<unknown> | null = null
  let preparingOwner: TempResultOwner | undefined, resumed = false
  let labels = [options.character, args.character, args.description]
  const checkOwner = () => {
    if (draft) assertRequestOwner(draft, hasRuntimeTasks())
    else if (!preparingOwner || !sameTempResultOwner(preparingOwner) || !hasRuntimeTasks()) throw new Error('绘图准备所属工作区已变化，请回到原连接')
  }
  const forget = async () => { if (draft) await clearRequestDraft(COMPANION_IMAGE_REQUEST_KEY, draft) }
  const requestCancel = () => {
    // Leaving, switching characters and observation timeouts do not cancel execution.
    if (options.signal.reason !== 'user-cancel' || !draft?.submitted || cancellation) return
    cancellation = Promise.resolve().then(async () => {
      checkOwner()
      const task = await cancelRuntimeTaskKey(draft!.key)
      if (!task || task.status === 'cancelled' && task.upstreamSettled && task.recoveryState === 'normal') await forget()
    })
    void cancellation.catch(() => {})
  }
  signal.addEventListener('abort', requestCancel, { once: true })
  try {
    preparingOwner = tempResultOwner()
    draft = readImageRequestDraft(COMPANION_IMAGE_REQUEST_KEY)
    if (draft) {
      resumed = true
      checkOwner()
      const saved: unknown = JSON.parse(draft.signature || 'null')
      if (!Array.isArray(saved) || saved.length !== 3 || !saved.every(value => typeof value === 'string')) throw new Error('原聊天图片身份无法读取，已保留记录')
      labels = saved
      if (labels[0] !== options.character) throw new Error('上一张图片仍待核对，请回到原角色对话继续绘图；不会另起任务')
      options.report?.('正在恢复上一张图片；本次新要求尚未提交…')
    } else {
      validateCompanionImageArgs(args, Boolean(options.referenceImage))
      const referenceImage = await options.referenceImage?.()
      signal.throwIfAborted()
      if (typeof referenceImage === 'string' && !/^data:image\/(png|jpeg|webp);base64,/.test(referenceImage)) throw new Error('参考图片引用无效，请重新发送图片')
      if (referenceImage && typeof referenceImage !== 'string') assertWorkspaceMediaAuthority(referenceImage.authority)
      const submission = await prepare(args, { ...options, signal, referenceImage })
      signal.throwIfAborted(); checkOwner()
      draft = newImageRequestDraft(submission, true)
      draft.signature = JSON.stringify(labels)
      await writeRequestDraft(COMPANION_IMAGE_REQUEST_KEY, draft)
    }
    signal.throwIfAborted(); checkOwner()
    let task: TaskRecord
    if (draft.submitted) {
      const existing = await getRuntimeTaskByKey(draft.key, signal)
      if (!existing) throw new Error('原请求接收状态尚未确认，请先在任务中心核对；不会重复生成')
      task = existing
    } else {
      draft.submitted = true
      await writeRequestDraft(COMPANION_IMAGE_REQUEST_KEY, draft)
      signal.throwIfAborted(); checkOwner()
      options.report?.('正在提交绘图任务…')
      try {
        task = await submitRuntimeTask(draft.submission.family === 'krea2' ? 'creative' : 'anima',
          animaRequestPayload(draft.submission.request), draft.key, draft.submission.context as Record<string, unknown>, { signal, onSubmitting: checkOwner })
      } catch (error) {
        if (!signal.aborted && error instanceof ApiClientError && error.kind === 'http' && error.status < 500) await forget()
        throw error
      }
    }
    const done = await waitForRuntimeTask(task.taskId, signal, current => options.report?.(taskMessage(current)))
    signal.throwIfAborted(); checkOwner()
    draft.resultId = done.taskId
    await writeRequestDraft(COMPANION_IMAGE_REQUEST_KEY, draft)
    options.report?.('图片已生成，正在保存到作品册…')
    let imageId = done.resultRefs.find(output => output.index === 0)?.alias
    let artworkId: string | undefined
    try {
      const artwork = await archiveTaskResult(done.taskId, 0)
      imageId = artwork.image_id; artworkId = String(artwork.id)
    } catch {
      signal.throwIfAborted(); checkOwner()
      options.report?.('作品册保存尚未确认；先将原任务结果送回对话…')
    }
    signal.throwIfAborted(); checkOwner()
    return { taskId: done.taskId, resultPath: runtimeResultPath(done), imageId, artworkId,
      character: labels[1], description: labels[2],
      output: (resumed ? '已找回上次图片，本次新要求尚未提交。' : '')
        + (artworkId ? '图片已生成，并保存到作品册。' : '图片已生成，原图已送回对话；作品册保存尚未确认，可在任务中心重试入册。') }
  } catch (error) {
    if (signal.aborted) {
      requestCancel()
      if (draft && !draft.submitted) await forget()
      if (cancellation) {
        try { await cancellation }
        catch { throw new Error('已停止等待，但取消状态尚未确认，请到任务中心核对原任务') }
      }
      throw new DOMException('已停止查看，原图片请求身份仍会在下次绘图时核对', 'AbortError')
    }
    if (error instanceof AcceptedTaskTerminalError) await forget()
    throw error
  } finally {
    signal.removeEventListener('abort', requestCancel)
    busy = false
  }
}

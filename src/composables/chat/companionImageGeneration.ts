import { ref } from 'vue'
import { apiClient, ApiClientError } from '@/api/client'
import { AcceptedTaskTerminalError } from '@/api/acceptedTaskOutcome'
import { hasRuntimeTasks, submitRuntimeTask, waitForRuntimeTask, getRuntimeTaskByKey, cancelRuntimeTaskKey, runtimeResultPath, taskMessage, type TaskRecord } from '@/api/runtimeTasks'
import { getDesktopRuntime } from '@/platform/desktop/runtime'
import { refreshProfileStorage } from '@/platform/web/profileStorage'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { useSceneStore } from '@/stores/sceneStore'
import { runtimeRequestKey } from '@/stores/runtimeTaskState'
import { DRAW_ENGINE_SETTING, STARTER_MODEL_SETTING, settingsRepository } from '@/storage/settingsRepository'
import { readDrawingSettings } from '@/storage/drawingSettings'
import { initialAnimaState } from '@/composables/generation/useAnimaSession'
import { animaRequestPayload, closestSupportedSize, ANIMA_LORA_BY_CHARACTER, type AnimaStatusResponse } from '@/composables/generation/animaSessionContract'
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
interface Attempt {
  key: string; kind: 'anima' | 'creative'; input: Record<string, unknown>; context: Record<string, unknown>
  submitted: boolean
}
let busy = false
// Unknown admission retains the original prepared recipe and identity, even when settings change later.
const pending = new Map<string, Attempt>()

async function prepare(args: CompanionImageArgs, options: { referenceImage?: string | Readonly<MediaSource>; signal: AbortSignal; report?: (message: string) => void }): Promise<Attempt> {
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
    state.steps = Number(defaults?.steps) || state.steps; state.cfg = Number(defaults?.cfg) || state.cfg
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
  const kind = family === 'krea2' ? 'creative' : 'anima'
  const input = animaRequestPayload(request) as Record<string, unknown>
  return { kind, input, key: runtimeRequestKey(kind, input), context: { ...captureResultContext(draft), source: 'companion-chat' }, submitted: false }
}

/** Direct image creation and reference recreation share the same compiler and durable task/archive path. */
export async function generateCompanionImage(args: CompanionImageArgs, options: {
  referenceImage?: string | Readonly<MediaSource>; signal: AbortSignal; report?: (message: string) => void
}): Promise<CompanionImageResult> {
  validateCompanionImageArgs(args, Boolean(options.referenceImage))
  if (!isLocalStudioHost()) throw new Error('桌宠绘图工具仅限本机直连使用')
  if (!hasRuntimeTasks()) throw new Error('请在桌面客户端启用私人任务工作区后使用桌宠绘图')
  if (typeof options.referenceImage === 'string' && options.referenceImage && !/^data:image\/(png|jpeg|webp);base64,/.test(options.referenceImage)) throw new Error('参考图片引用无效，请重新发送图片')
  if (busy) throw new Error('桌宠正在处理上一张图片，请等待完成或先停止')
  options.signal.throwIfAborted()
  busy = true
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(10 * 60 * 1000)])
  const workspace = getDesktopRuntime().bootstrap?.runtime?.workspace?.workspaceId || ''
  const checkWorkspace = () => {
    if (getDesktopRuntime().bootstrap?.runtime?.workspace?.workspaceId !== workspace) throw new Error('工作区已改变，请重新发起绘图；原任务仍保留在原工作区')
    if (options.referenceImage && typeof options.referenceImage !== 'string') assertWorkspaceMediaAuthority(options.referenceImage.authority)
  }
  let signature = '', attempt: Attempt | undefined, cancel: Promise<unknown> | null = null
  const requestCancel = () => {
    if (attempt?.submitted && !cancel) {
      cancel = Promise.resolve().then(() => { checkWorkspace(); return cancelRuntimeTaskKey(attempt!.key) })
      void cancel.catch(() => {}) // The owning catch below reports an unknown cancellation; the event listener cannot await it.
    }
  }
  signal.addEventListener('abort', requestCancel, { once: true })
  try {
    const source = options.referenceImage || ''
    checkWorkspace()
    const digest = typeof source === 'string' && source ? await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source)) : null
    const referenceKey = typeof source !== 'string' ? JSON.stringify(['workspace-media-v1', source.sha256, source.mime, source.bytes])
      : digest ? Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') : ''
    signature = JSON.stringify([workspace, args.character.trim(), args.description.trim(), args.visualDescription?.trim() || '',
      args.outfit?.trim() || 'default', args.mature === true, referenceKey])
    attempt = pending.get(signature)
    if (!attempt) { attempt = await prepare(args, { ...options, signal }); pending.set(signature, attempt) }
    signal.throwIfAborted()
    checkWorkspace()
    let task: TaskRecord
    if (attempt.submitted) {
      options.report?.('正在核对上一轮的同一绘图任务…')
      const existing = await getRuntimeTaskByKey(attempt.key, signal)
      if (!existing) throw new Error('上一轮接收状态尚未确认，请先在任务中心核对；不会重复生成')
      task = existing
    } else {
      options.report?.('正在提交绘图任务…')
      try { task = await submitRuntimeTask(attempt.kind, attempt.input, attempt.key, attempt.context, { signal, onSubmitting: () => { attempt!.submitted = true } }) }
      catch (error) {
        // Only a definitive admission rejection permits replacing this attempt, never a failed status/archive read.
        if (!signal.aborted && error instanceof ApiClientError && error.kind === 'http' && error.status < 500) pending.delete(signature)
        throw error
      }
    }
    signal.throwIfAborted()
    const done = await waitForRuntimeTask(task.taskId, signal, current => options.report?.(taskMessage(current)))
    signal.throwIfAborted()
    options.report?.('图片已生成，正在保存到作品册…')
    checkWorkspace()
    let imageId = done.resultRefs.find(output => output.index === 0)?.alias
    let artworkId: string | undefined
    try {
      const artwork = await archiveTaskResult(done.taskId, 0)
      imageId = artwork.image_id; artworkId = String(artwork.id)
    } catch {
      signal.throwIfAborted(); checkWorkspace()
      options.report?.('图片已生成，作品册保存尚未确认；先将原任务结果送回对话…')
    }
    pending.delete(signature)
    signal.throwIfAborted()
    checkWorkspace()
    return { taskId: done.taskId, resultPath: runtimeResultPath(done), imageId, artworkId,
      character: args.character, description: args.description,
      output: artworkId ? options.referenceImage ? '已按参考图的服装、姿势与背景生成新图，并保存到作品册。' : '图片已生成，并保存到作品册。'
        : '图片已生成，原图已送回对话；作品册保存尚未确认，可在任务中心重试入册。' }
  } catch (error) {
    if (signal.aborted) {
      requestCancel()
      if (cancel) {
        try { await cancel }
        catch { throw new Error('已停止等待，但生成任务的取消状态尚未确认，请到任务中心核对原任务') }
      }
      if (!attempt?.submitted) pending.delete(signature)
      if (!options.signal.aborted) throw new Error('桌宠绘图等待超时，已请求取消原任务，请到任务中心核对')
      throw new DOMException('桌宠绘图已取消', 'AbortError')
    }
    if (!attempt?.submitted || error instanceof AcceptedTaskTerminalError) pending.delete(signature)
    throw error
  } finally {
    signal.removeEventListener('abort', requestCancel)
    busy = false
  }
}

import { resolveInpaintRequestBinding } from './useAnimaSession'
import type { AnimaSubmission } from './animaSessionContract'
import { apiClient } from '@/api/client'
import { escapeKnownLiteralTags } from '@/utils/promptLiteralTags.ts'
import { endfieldAnimaBinding } from '@/utils/loraCatalog'
import type { AnimaInpaintDeps } from './useAnimaInpaint'
import type { InpaintSubmitPayload } from '@/components/AnimaInpaintModal.vue'
import { automaticMaskBlocker } from './animaBackendReadiness'
import type { ComfyNodeReadiness } from '@/types/anima'
import { nativeAnimaRequestBlocker } from './nativeAnimaCapabilities'
import { assertWorkspaceMediaAuthority, workspaceMediaSource } from '@/platform/desktop/workspaceMediaSource'

export type InpaintSubmissionSnapshot = {
  provider?: 'comfy' | 'native'
  automaticMaskAvailable?: boolean
  automaticMaskStatus?: ComfyNodeReadiness
  managedStartAvailable?: boolean
  payload: InpaintSubmitPayload
  effectiveChar: Exclude<InpaintSubmitPayload['characterOverride'], undefined>
  isPopular: boolean
  identityTokens: string[]
  model: {
    models: AnimaInpaintDeps['animaState']['value']['models']
    modelId: string
    width: number
    height: number
    loraStrength: number | null
  }
}

/** Loaded only when the user confirms inpainting; request construction stays unchanged. */
export async function submitAnimaInpaint(snapshot: InpaintSubmissionSnapshot, context: {
  signal: AbortSignal
  current(): boolean
  flash: AnimaInpaintDeps['pb']['flash']
  submission: AnimaSubmission
  generate: AnimaInpaintDeps['generateAnima']
  begin(originalUrl: string): void
  started(): void
}): Promise<void> {
  const { signal, flash } = context
  signal.throwIfAborted()
  const wholeImage = snapshot.payload.editMode === 'whole'
  if (wholeImage && snapshot.payload.maskBlob) throw new Error('整图重绘不能同时提交遮罩，请重新确认重绘区域')
  const maskBlocker = !wholeImage && !snapshot.payload.maskBlob && automaticMaskBlocker(snapshot)
  if (maskBlocker) throw new Error(maskBlocker)
  const source = workspaceMediaSource(snapshot.payload.imageBlob)
  flash(wholeImage ? '正在准备原图与整图重绘…' : '正在准备原图与智能换装…')
  const uploadJson = await apiClient.request<{ ok: boolean; name: string; error?: string }>(source ? '/api/workspace/anima-images' : '/api/anima/images/raw', {
    method: 'POST',
    ...(source ? { body: { source: 'workspace', alias: source.alias, sha256: source.sha256, bytes: source.bytes } }
      : { headers: { 'Content-Type': 'application/octet-stream' }, body: snapshot.payload.imageBlob }),
    signal,
    timeoutMs: 30_000,
  })
  signal.throwIfAborted()
  if (source) assertWorkspaceMediaAuthority(source.authority)
  if (!uploadJson.ok || !uploadJson.name) {
    throw new Error((uploadJson as { error?: string }).error || '原图上传失败')
  }

  const initImage = uploadJson.name
  let maskImage: string | undefined
  if (snapshot.payload.maskBlob) {
    const maskJson = await apiClient.request<{ ok: boolean; name: string; error?: string }>('/api/anima/images/raw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: snapshot.payload.maskBlob,
      signal,
      timeoutMs: 30_000,
    })
    signal.throwIfAborted()
    if (!maskJson.ok || !maskJson.name) throw new Error((maskJson as { error?: string }).error || '遮罩上传失败')
    maskImage = maskJson.name
  }

  // All values below come from the submission snapshot. Uploading the source
  // image and resolving a mask may yield to the event loop; the creator can
  // change panels meanwhile, but that must not change this in-flight request.
  // 热门角色强制走无 LoRA 底模（即使 characterOverride 误传 nene/natsume 也纠正），
  // 避免 nene/夏目 LoRA 污染热门角色脸型；身份靠 Danbooru 标签锁定。
  const charLocked = snapshot.isPopular ? 'none' : snapshot.effectiveChar
  const isCharacterLora = charLocked === 'nene' || charLocked === 'natsume'
  const inpaintMode = isCharacterLora || charLocked === 'none' ? charLocked : null
  const desiredSize = snapshot.payload.targetWidth && snapshot.payload.targetHeight
    ? `${snapshot.payload.targetWidth}x${snapshot.payload.targetHeight}`
    : `${snapshot.model.width}x${snapshot.model.height}`
  const binding = resolveInpaintRequestBinding(
    snapshot.model.models,
    snapshot.model.modelId,
    inpaintMode,
    desiredSize,
  )
  const endfield = snapshot.isPopular
    ? endfieldAnimaBinding(context.submission.request.character, 'anima', binding?.modelId)
    : null
  if (binding && endfield) Object.assign(binding, endfield)

  let promptText = snapshot.payload.newOutfitPrompt
  if (charLocked === 'nene' && !promptText.includes('ayachi_nene')) {
    promptText = `ayachi_nene, ${promptText}`
  } else if (charLocked === 'natsume' && !promptText.includes('shiki_natsume')) {
    promptText = `shiki_natsume, ${promptText}`
  } else if (charLocked === 'none' && snapshot.identityTokens.length && snapshot.isPopular) {
    // 2026-08-30 热门角色换装修复：身份标签前置，模型才知道衣服穿在谁身上。
    const identity = escapeKnownLiteralTags(snapshot.identityTokens.join(', '), snapshot.identityTokens)
    promptText = `${identity}, ${promptText}`
  }

  const negativePrompt = charLocked === 'none' && !wholeImage
    ? `${snapshot.payload.negativePrompt}, face, head, hair, duplicate person, extra person`
    : snapshot.payload.negativePrompt
  if (!binding) {
    flash('当前没有可用的无 LoRA Anima 底模，无法处理外部通用图片')
    return
  }
  const nativeBlocker = snapshot.provider === 'native' && nativeAnimaRequestBlocker(snapshot.model.models, { ...context.submission.request, modelId: binding.modelId })
  if (nativeBlocker) { flash(nativeBlocker); return }

  signal.throwIfAborted()
  if (source) assertWorkspaceMediaAuthority(source.authority)
  if (!context.current()) return
  // Archive the resolved studio identity, not the panel captured before an override.
  // Popular characters retain their own identity even when the binding uses a LoRA.
  if (!snapshot.isPopular) context.submission.context = { ...context.submission.context, char: binding.character ?? 'none' }
  context.begin(URL.createObjectURL(snapshot.payload.imageBlob))
  flash(wholeImage ? '正在执行整图重绘，人物与背景均可能变化…' : snapshot.provider === 'native' ? (maskImage ? '正在执行手绘局部重绘（实验性）…' : '正在执行本地自动识别与局部重绘（实验性）…') : maskImage ? '正在执行手绘局部换装…' : '正在执行自动识别与局部换装，节点的模型加载仍需验证…')
  let pending: Promise<void>
  try { pending = context.generate({
    prompt: promptText,
    modelId: binding.modelId,
    negative: negativePrompt,
    initImage,
    ...(wholeImage ? {} : maskImage ? { maskImage } : { maskPrompt: snapshot.payload.maskPrompt, maskThreshold: snapshot.payload.maskThreshold }),
    denoisingStrength: snapshot.payload.denoisingStrength,
    ...(wholeImage ? {} : { growMaskBy: snapshot.payload.growMaskBy }),
    seed: snapshot.payload.seed ?? undefined,
    character: binding.character,
    loraId: binding.loraId,
    loraStrength: isCharacterLora || endfield ? snapshot.model.loraStrength : null,
    width: binding.width,
    height: binding.height,
    teaCache: snapshot.provider === 'native' ? context.submission.request.teaCache : true,
  }, context.submission) }
  finally { context.started() }
  await pending
}

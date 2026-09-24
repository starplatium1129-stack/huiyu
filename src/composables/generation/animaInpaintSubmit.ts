import type { ComputedRef, Ref } from 'vue'
import { resolveInpaintRequestBinding } from './useAnimaSession'
import { apiClient } from '@/api/client'
import { escapeKnownLiteralTags } from '@/utils/promptLiteralTags.ts'
import type { AnimaInpaintDeps } from './useAnimaInpaint'
import type { InpaintSubmitPayload } from '@/components/AnimaInpaintModal.vue'

type InpaintSubmitContext = AnimaInpaintDeps & {
  inpaintOpen: Ref<boolean>
  inpaintOriginalUrl: Ref<string | null>
  inpaintCompareActive: Ref<boolean>
  inpaintCharacter: ComputedRef<'nene' | 'natsume' | null>
}

type InpaintSubmissionSnapshot = {
  payload: InpaintSubmitPayload
  effectiveChar: Exclude<InpaintSubmitPayload['characterOverride'], undefined>
  isPopular: boolean
  identityTokens: string[]
  displayResultUrl: string
  model: {
    models: AnimaInpaintDeps['animaState']['value']['models']
    modelId: string
    width: number
    height: number
    loraStrength: number | null
  }
}

/** Freeze all mutable creator state before the first asynchronous upload. */
function captureSubmission(context: InpaintSubmitContext, payload: InpaintSubmitPayload): InpaintSubmissionSnapshot {
  const { animaState, displayResultUrl, isPopular, popularIdentityTokens, inpaintCharacter } = context
  return {
    payload: { ...payload },
    effectiveChar: payload.characterOverride !== undefined ? payload.characterOverride : inpaintCharacter.value,
    isPopular: isPopular.value,
    identityTokens: [...popularIdentityTokens.value],
    displayResultUrl: displayResultUrl.value,
    model: {
      models: JSON.parse(JSON.stringify(animaState.value.models)) as AnimaInpaintDeps['animaState']['value']['models'],
      modelId: animaState.value.modelId,
      width: animaState.value.width,
      height: animaState.value.height,
      loraStrength: animaState.value.loraStrength,
    },
  }
}

/** Loaded only when the user confirms inpainting; request construction stays unchanged. */
export async function submitAnimaInpaint(payload: InpaintSubmitPayload, context: InpaintSubmitContext): Promise<void> {
  const snapshot = captureSubmission(context, payload)
  const { pb, generateAnima, inpaintOpen, inpaintOriginalUrl, inpaintCompareActive } = context
  pb.flash('正在上传原图并准备智能换装…')
  const reader = new FileReader()
  const base64Promise = new Promise<string>((resolve, reject) => {
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(snapshot.payload.imageBlob)
  })
  const base64Data = await base64Promise

  const uploadJson = await apiClient.request<{ ok: boolean; name: string; error?: string }>('/api/anima/images', {
    method: 'POST',
    body: { image: base64Data },
    timeoutMs: 30_000,
  } as unknown as Record<string, unknown>)
  if (!uploadJson.ok || !uploadJson.name) {
    throw new Error((uploadJson as { error?: string }).error || '原图上传失败')
  }

  const initImage = uploadJson.name
  let maskImage: string | undefined
  if (snapshot.payload.maskBlob) {
    const maskReader = new FileReader()
    const maskData = await new Promise<string>((resolve, reject) => {
      maskReader.onload = () => resolve(maskReader.result as string)
      maskReader.onerror = reject
      maskReader.readAsDataURL(snapshot.payload.maskBlob as Blob)
    })
    const maskJson = await apiClient.request<{ ok: boolean; name: string; error?: string }>('/api/anima/images', {
      method: 'POST',
      body: { image: maskData },
      timeoutMs: 30_000,
    } as unknown as Record<string, unknown>)
    if (!maskJson.ok || !maskJson.name) throw new Error((maskJson as { error?: string }).error || '遮罩上传失败')
    maskImage = maskJson.name
  }
  inpaintOpen.value = false
  inpaintOriginalUrl.value = snapshot.displayResultUrl
  inpaintCompareActive.value = false
  pb.flash('正在执行 AI 智能识别与局部换装 (~6秒)…')

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

  const negativePrompt = charLocked === 'none'
    ? `${snapshot.payload.negativePrompt}, face, head, hair, duplicate person, extra person`
    : snapshot.payload.negativePrompt
  if (!binding) {
    pb.flash('当前没有可用的无 LoRA Anima 底模，无法处理外部通用图片')
    return
  }

  await generateAnima({
    prompt: promptText,
    modelId: binding.modelId,
    negative: negativePrompt,
    initImage,
    ...(maskImage ? { maskImage } : { maskPrompt: snapshot.payload.maskPrompt, maskThreshold: snapshot.payload.maskThreshold }),
    denoisingStrength: snapshot.payload.denoisingStrength,
    growMaskBy: snapshot.payload.growMaskBy,
    seed: snapshot.payload.seed ?? undefined,
    character: binding.character,
    loraId: binding.loraId,
    loraStrength: isCharacterLora ? snapshot.model.loraStrength : null,
    width: binding.width,
    height: binding.height,
    teaCache: true,
  })
}

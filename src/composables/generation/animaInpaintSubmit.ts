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

/** Loaded only when the user confirms inpainting; request construction stays unchanged. */
export async function submitAnimaInpaint(payload: InpaintSubmitPayload, context: InpaintSubmitContext): Promise<void> {
  const { pb, animaState, displayResultUrl, generateAnima, isPopular, popularIdentityTokens,
    inpaintOpen, inpaintOriginalUrl, inpaintCompareActive, inpaintCharacter } = context
  pb.flash('正在上传原图并准备智能换装…')
  const reader = new FileReader()
  const base64Promise = new Promise<string>((resolve, reject) => {
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(payload.imageBlob)
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
  if (payload.maskBlob) {
    const maskReader = new FileReader()
    const maskData = await new Promise<string>((resolve, reject) => {
      maskReader.onload = () => resolve(maskReader.result as string)
      maskReader.onerror = reject
      maskReader.readAsDataURL(payload.maskBlob as Blob)
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
  inpaintOriginalUrl.value = displayResultUrl.value
  inpaintCompareActive.value = false
  pb.flash('正在执行 AI 智能识别与局部换装 (~6秒)…')

  const effectiveChar = payload.characterOverride !== undefined
    ? payload.characterOverride
    : inpaintCharacter.value
  // 热门角色强制走无 LoRA 底模（即使 characterOverride 误传 nene/natsume 也纠正），
  // 避免 nene/夏目 LoRA 污染热门角色脸型；身份靠 Danbooru 标签（popularIdentityTokens）锁定。
  const charLocked = isPopular.value ? 'none' : effectiveChar
  const isCharacterLora = charLocked === 'nene' || charLocked === 'natsume'
  const inpaintMode = isCharacterLora || charLocked === 'none' ? charLocked : null
  const desiredSize = payload.targetWidth && payload.targetHeight
    ? `${payload.targetWidth}x${payload.targetHeight}`
    : `${animaState.value.width}x${animaState.value.height}`
  const binding = resolveInpaintRequestBinding(
    animaState.value.models,
    animaState.value.modelId,
    inpaintMode,
    desiredSize,
  )

  let promptText = payload.newOutfitPrompt
  if (charLocked === 'nene' && !promptText.includes('ayachi_nene')) {
    promptText = `ayachi_nene, ${promptText}`
  } else if (charLocked === 'natsume' && !promptText.includes('shiki_natsume')) {
    promptText = `shiki_natsume, ${promptText}`
  } else if (charLocked === 'none' && popularIdentityTokens.value.length && isPopular.value) {
    // 2026-08-30 热门角色换装修复：身份标签前置（hina (blue archive), halo, silver_hair…），
    // 模型才知道衣服穿在谁身上——此前只传衣服词导致新衣光影/气质与原图脱节。
    const identity = escapeKnownLiteralTags(popularIdentityTokens.value.join(', '), popularIdentityTokens.value)
    promptText = `${identity}, ${promptText}`
  }

  const negativePrompt = charLocked === 'none'
    ? `${payload.negativePrompt}, face, head, hair, duplicate person, extra person`
    : payload.negativePrompt
  if (!binding) {
    pb.flash('当前没有可用的无 LoRA Anima 底模，无法处理外部通用图片')
    return
  }

  await generateAnima({
    prompt: promptText,
    modelId: binding.modelId,
    negative: negativePrompt,
    initImage,
    ...(maskImage ? { maskImage } : { maskPrompt: payload.maskPrompt, maskThreshold: payload.maskThreshold }),
    denoisingStrength: payload.denoisingStrength,
    growMaskBy: payload.growMaskBy,
    seed: payload.seed ?? undefined,
    character: binding.character,
    loraId: binding.loraId,
    loraStrength: isCharacterLora ? animaState.value.loraStrength : null,
    width: binding.width,
    height: binding.height,
    teaCache: true,
  })
}

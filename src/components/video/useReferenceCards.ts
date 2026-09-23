import { ref, onScopeDispose, getCurrentScope, type Ref } from 'vue'
import { ensureCharacterReferencesLoaded, getCharacterReferences } from '@/utils/characterReferenceData'
import type { VideoImageUploadResponse } from '@/api/videoApi'

/**
 * 分镜编辑器·角色参考卡（Ref2VA）编排（2026-08-22 自 ShotListEditor 下沉）。
 * 支持 1~4 个角色槽，每槽最多 4 张 4 视角参考图；负责参考图的自动装配
 * （角色→服装→4 视角基准图）、手动上传、身份锚点 prose 合并。
 */

export interface ReferenceImage {
  name: string
  url: string
}

export interface ReferenceCard {
  label: string
  characterId?: string
  outfitId?: string
  images: ReferenceImage[]
}

/** 镜头草稿中与本簇相关的最小结构（cast: 'all' | 角色序号串如 '12'）。 */
export interface ShotCastRef {
  cast?: string
}

export interface ReferenceCardsDeps {
  /** 多角色身份锚点合并结果（分镜提示词注入用），由宿主持有。 */
  identityCard: Ref<string>
  /** 本簇的用户可见错误回写（尺寸/上传失败等）。 */
  batchError: Ref<string>
  readBlobAsDataURL: (blob: Blob) => Promise<string>
  uploadVideoImage: (base64: string, kind?: 'reference', signal?: AbortSignal) => Promise<VideoImageUploadResponse>
  onCardRemoved?: (index: number) => void
}

const MAX_CARDS = 4
const MAX_IMAGES_PER_CARD = 4

export function removeCastSlot(cast: string, removedIndex: number): string {
  if (!/^\d+$/.test(cast)) return cast
  return [...new Set(cast.split('').map(Number).filter(slot => slot !== removedIndex + 1).map(slot => slot > removedIndex + 1 ? slot - 1 : slot))].join('')
}

export function useReferenceCards(deps: ReferenceCardsDeps) {
  const referenceCards = ref<ReferenceCard[]>([
    { label: '', images: [] },
    { label: '', images: [] },
  ])
  const referenceInputs = ref<HTMLInputElement[]>([])
  const loadingRefAssets = ref(false)
  const loadingRefCardIndex = ref<number | null>(null)
  const operations = new Map<ReferenceCard, Set<AbortController>>()
  let disposed = false
  let lastAutoIdentity = ''
  function syncLoading() {
    loadingRefAssets.value = operations.size > 0
    const index = referenceCards.value.findIndex(card => operations.has(card))
    loadingRefCardIndex.value = index >= 0 ? index : null
  }
  function cancelCard(card: ReferenceCard) {
    operations.get(card)?.forEach(controller => controller.abort())
    operations.delete(card)
    syncLoading()
  }
  function start(card: ReferenceCard) {
    const controller = new AbortController()
    const pending = operations.get(card) || new Set<AbortController>()
    pending.add(controller); operations.set(card, pending); syncLoading()
    return controller
  }
  const current = (card: ReferenceCard, controller: AbortController) => !disposed && !controller.signal.aborted && referenceCards.value.includes(card) && operations.get(card)?.has(controller)
  function finish(card: ReferenceCard, controller: AbortController) {
    const pending = operations.get(card)
    pending?.delete(controller)
    if (pending?.size === 0) operations.delete(card)
    syncLoading()
  }
  function clearImages(card: ReferenceCard) {
    card.images.forEach(image => { if (image.url) URL.revokeObjectURL(image.url) })
    card.images = []
  }
  if (getCurrentScope()) onScopeDispose(() => {
    disposed = true
    for (const card of operations.keys()) cancelCard(card)
    referenceCards.value.forEach(clearImages)
  })

  function getCharOutfits(charId?: string) {
    if (!charId) return []
    const profile = getCharacterReferences(charId)
    return profile?.outfits || []
  }

  function addReferenceCard() {
    if (referenceCards.value.length >= MAX_CARDS) return
    referenceCards.value.push({ label: '', images: [] })
  }

  function removeReferenceCard(index: number) {
    if (referenceCards.value.length <= 1 || !referenceCards.value[index]) return
    const card = referenceCards.value[index]
    if (card) {
      cancelCard(card)
      clearImages(card)
    }
    referenceCards.value.splice(index, 1)
    referenceInputs.value.splice(index, 1)
    deps.onCardRemoved?.(index)
    updateMultiCharacterIdentity()
  }

  async function switchCardOutfit(cardIndex: number, outfitId: string) {
    const card = referenceCards.value[cardIndex]
    if (!card || !card.characterId) return
    await autoLoadCharacterReferences(card.characterId, cardIndex, outfitId)
  }

  /**
   * 自动装配角色参考图（角色 → 服装 → 4 视角基准图）。
   * 返回成功装配的张数（2026-09-06 体验报告 F4：导入汇报需要逐卡如实计数，
   * 不再让装配失败被「全部成功」的文案掩盖）。
   */
  async function autoLoadCharacterReferences(charId: string, cardIndex: number = 0, outfitId?: string): Promise<number> {
    if (cardIndex < 0 || cardIndex >= referenceCards.value.length) return 0
    const targetCard = referenceCards.value[cardIndex]
    cancelCard(targetCard)
    clearImages(targetCard)
    const controller = start(targetCard)
    targetCard.characterId = charId
    targetCard.outfitId = ''
    targetCard.label = ''
    await ensureCharacterReferencesLoaded(charId).catch(() => undefined)
    if (!current(targetCard, controller)) { finish(targetCard, controller); return 0 }
    const profile = getCharacterReferences(charId)
    if (!profile) {
      finish(targetCard, controller)
      targetCard.characterId = charId
      targetCard.outfitId = ''
      targetCard.label = ''
      updateMultiCharacterIdentity()
      deps.batchError.value = '角色参考档案尚未就绪，请稍后重新选择'
      return 0
    }

    // 匹配特定 outfit 或默认 outfit
    let chosenOutfit = profile.outfits.find(o => o.outfitId === outfitId)
    if (!chosenOutfit && !outfitId) {
      chosenOutfit = profile.outfits.find(o => o.isDefault) || profile.outfits[0]
    }

    // 记录角色元信息
    targetCard.characterId = charId
    targetCard.outfitId = chosenOutfit?.outfitId || ''
    targetCard.label = profile.displayName + (chosenOutfit && !chosenOutfit.isDefault ? ` · ${chosenOutfit.outfitName}` : '')

    updateMultiCharacterIdentity()
    if (!chosenOutfit) { finish(targetCard, controller); deps.batchError.value = '该服装参考档案不存在，请重新选择'; return 0 }
    let loaded = 0
    try {
      // 自动加载基准图（特写 / 半身 / 全身 / 侧后背影）；设计图基线占位（pending 无 url）排除
      // 关键修复：加入时间戳与 no-cache，杜绝浏览器拉取旧缓存图片
      const targets = chosenOutfit.references.filter(r => r.url && !r.pending).slice(0, MAX_IMAGES_PER_CARD)
      for (const item of targets) {
        if (!current(targetCard, controller)) return 0
        if (targetCard.images.length >= MAX_IMAGES_PER_CARD) break
        try {
        const imgUrl = new URL(item.url, location.href)
        imgUrl.searchParams.set('t', String(Date.now()))
        const resp = await fetch(imgUrl.href, { cache: 'no-cache', signal: controller.signal })
        if (!resp.ok) continue
        const blob = await resp.blob()
        if (!blob.size || blob.size > 20 * 1024 * 1024 || (blob.type && !blob.type.startsWith('image/'))) continue
        const dataUrl = await deps.readBlobAsDataURL(blob)
        const comma = dataUrl.indexOf(',')
        if (comma < 0) continue
        const upload = await deps.uploadVideoImage(dataUrl.slice(comma + 1), 'reference', controller.signal)
        if (!current(targetCard, controller)) return 0
        if (targetCard.images.length >= MAX_IMAGES_PER_CARD) break
        targetCard.images.push({
          name: upload.name,
          url: URL.createObjectURL(blob),
        })
        loaded += 1
        } catch { if (!current(targetCard, controller)) return 0 }
      }
      if (current(targetCard, controller)) deps.batchError.value = loaded === targets.length && loaded > 0 ? '' : `已装配 ${loaded}/${targets.length} 张参考图，缺失或待补素材未计入完成，可重新选择服装重试`
    } catch (error) {
      console.warn(`[ShotList] 自动装配角色 ${cardIndex + 1} 标准参考图失败:`, error)
    } finally {
      finish(targetCard, controller)
    }
    return loaded
  }

  /**
   * 智能更新多角色身份锚点：
   * 将所有已装配角色的身份描述合并（单角色直接注入；多角色按 Role 1 / Role 2 结构化组织），
   * 包含对特定服装（outfit prose）的细粒度描述拼接。
   */
  function updateMultiCharacterIdentity() {
    const activeDescriptions: string[] = []
    referenceCards.value.forEach((card, idx) => {
      if (!card.characterId && !card.label) return
      const profile = card.characterId ? getCharacterReferences(card.characterId) : undefined
      const baseProse = profile?.identityProse || ''
      const outfitObj = profile?.outfits?.find(o => o.outfitId === card.outfitId)
      const outfitProse = outfitObj?.prose ? `, ${outfitObj.prose}` : ''
      const fullProse = (baseProse + outfitProse).trim()

      if (fullProse) {
        const displayName = profile?.displayName || card.label
        activeDescriptions.push(
          referenceCards.value.length > 1
            ? `[Character ${idx + 1} - ${displayName}]: ${fullProse}`
            : fullProse
        )
      }
    })

    if (activeDescriptions.length > 0) {
      lastAutoIdentity = activeDescriptions.join('\n\n')
      deps.identityCard.value = lastAutoIdentity
    } else if (deps.identityCard.value === lastAutoIdentity) {
      deps.identityCard.value = ''
      lastAutoIdentity = ''
    }
  }

  // 去原生化的连带清理（2026-09-22）：原签名从 Event.target.value 读角色 id，
  // 是原生 <select> 的产物；改用 StudioSelect 后回写的就是 id 本身。
  async function onCardCharacterSelected(cardIndex: number, charId: string) {
    if (!charId) {
      const card = referenceCards.value[cardIndex]
      if (!card) return
      cancelCard(card); clearImages(card)
      card.characterId = undefined; card.outfitId = undefined; card.label = ''
      updateMultiCharacterIdentity()
      return
    }

    // 装配参考图到对应卡槽
    await autoLoadCharacterReferences(charId, cardIndex)
  }

  async function onReferencePicked(cardIndex: number, event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    const card = referenceCards.value[cardIndex]
    if (!card || disposed) return
    if (card.images.length + (operations.get(card)?.size || 0) >= MAX_IMAGES_PER_CARD) {
      deps.batchError.value = '每个角色最多 4 张参考图（4 视角）'
      return
    }
    if (file.size > 20 * 1024 * 1024) {
      deps.batchError.value = '参考图需 ≤20MB'
      return
    }
    if (!file.type.startsWith('image/')) { deps.batchError.value = '请选择图片文件'; return }
    const controller = start(card)
    try {
      const dataUrl = await deps.readBlobAsDataURL(file)
      const comma = dataUrl.indexOf(',')
      if (comma < 0) throw new Error('图片编码失败')
      const upload = await deps.uploadVideoImage(dataUrl.slice(comma + 1), 'reference', controller.signal)
      if (!current(card, controller) || card.images.length >= MAX_IMAGES_PER_CARD) return
      card.images.push({ name: upload.name, url: URL.createObjectURL(file) })
      deps.batchError.value = ''
    } catch (error) {
      if (current(card, controller)) deps.batchError.value = error instanceof Error ? error.message : '参考图上传失败'
    } finally {
      finish(card, controller)
    }
  }

  function pickReference(cardIndex: number) {
    referenceInputs.value[cardIndex]?.click()
  }

  function setReferenceInput(el: unknown, cardIndex: number) {
    if (el) referenceInputs.value[cardIndex] = el as HTMLInputElement
    else delete referenceInputs.value[cardIndex]
  }

  function removeReference(cardIndex: number, imageIndex: number) {
    const card = referenceCards.value[cardIndex]
    if (!card?.images[imageIndex]) return
    const image = card.images[imageIndex]
    if (image?.url) URL.revokeObjectURL(image.url)
    referenceCards.value[cardIndex].images.splice(imageIndex, 1)
  }

  /** 镜头 → 参考图文件名数组（按出场角色合并参考卡，最多 9 张 Ref2VA）。 */
  function shotReferences(shot: ShotCastRef): string[] | undefined {
    if (!shot.cast) return undefined
    const collect = (cardIndex: number) => (referenceCards.value[cardIndex]?.images ?? []).map(image => image.name)

    let list: string[] = []
    if (shot.cast === 'all') {
      referenceCards.value.forEach((_, idx) => {
        list.push(...collect(idx))
      })
    } else if (/^\d+$/.test(shot.cast)) {
      const indices = shot.cast.split('').map(c => Number(c) - 1)
      indices.forEach(idx => {
        if (idx >= 0 && idx < referenceCards.value.length) {
          list.push(...collect(idx))
        }
      })
    }

    // 数组去重并限制在 Ref2VA 允许的 9 张以内
    const unique = Array.from(new Set(list)).slice(0, 9)
    return unique.length ? unique : undefined
  }

  return {
    referenceCards,
    referenceInputs,
    loadingRefAssets,
    loadingRefCardIndex,
    getCharOutfits,
    addReferenceCard,
    removeReferenceCard,
    switchCardOutfit,
    autoLoadCharacterReferences,
    onCardCharacterSelected,
    onReferencePicked,
    pickReference,
    setReferenceInput,
    removeReference,
    shotReferences,
  }
}

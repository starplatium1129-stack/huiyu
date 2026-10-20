import { ref, shallowRef, onActivated, onDeactivated, onScopeDispose, watch, type Ref } from 'vue'
import { imageMediaSession } from '@/platform/imageMediaSession'
import { sameTempResultOwner, tempResultOwner } from '@/utils/tempResult'
import { registerMigrationArtworkSource } from '@/platform/web/migrationBarrier'
import { catalogApi } from '../../api/catalogApi'
import { parsePopularCharacter } from '../../utils/popularContent'
import { parseCharacterProfiles } from '../../utils/characterProfiles'
import { isRecord, stringList } from '../../utils/popularParseGuards'
import { proseToken } from '../../utils/promptPhraseTables'
import { OUTFIT_BUNDLES } from '../../composables/scene/useDirectorCatalog'
import type { PopularOutfit } from '../../types/character'
import type { VideoImageUploadResponse } from '../../api/videoApi.ts'

/**
 * 分镜编辑器·角色参考卡（Ref2VA）编排（2026-08-22 自 ShotListEditor 下沉）。
 * 角色与服装文字来自内容目录；每槽可按需手动上传最多 4 张图片。
 * 未上传图片不影响角色选择与身份描述，不再要求固定机位图库。
 */

export interface ReferenceImage {
  id: string
  blob: Blob
  name: string
  url: string
}

export interface ReferenceCard {
  outfitProseOverride?: string
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
  mediaRevision: Readonly<Ref<number>>
  uploadVideoImage: (data: Blob, kind?: 'reference', signal?: AbortSignal) => Promise<VideoImageUploadResponse>
  onCardRemoved?: (index: number) => void
}

const MAX_CARDS = 4
const MAX_IMAGES_PER_CARD = 4
type ProfileFailure = { outfitId?: string; label: string; identity: string; restoreLabel: boolean; restoreIdentity: boolean }
type CardProfile = { displayName: string; identityProse: string; outfits: PopularOutfit[] }

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
  const profileFailures = ref(new Map<ReferenceCard, ProfileFailure>())
  const profiles = shallowRef<Record<string, CardProfile>>({})
  const operations = new Map<ReferenceCard, Set<AbortController>>()
  const imageRequests = new Map<ReferenceImage, AbortController>()
  const owner = tempResultOwner()
  let disposed = false, imageVisit = 0
  const active = ref(true)
  const available = () => !disposed && active.value && sameTempResultOwner(owner)
  const releaseMigration = registerMigrationArtworkSource(() => referenceCards.value.some(card => card.images.length > 0))
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
    card.images.forEach(image => { stopImage(card, image); releasePreview(image) })
    card.images = []
  }
  function stopImage(card: ReferenceCard, image: ReferenceImage) {
    const controller = imageRequests.get(image)
    if (controller) { controller.abort(); imageRequests.delete(image); finish(card, controller) }
  }
  function releasePreview(image: ReferenceImage) {
    if (image.url) URL.revokeObjectURL(image.url)
    image.url = ''
  }
  function restorePreviews() {
    if (available()) referenceCards.value.forEach(card => card.images.forEach(image => {
      if (!image.url) image.url = URL.createObjectURL(image.blob)
    }))
  }
  function stopImages() {
    referenceCards.value.forEach(card => card.images.forEach(image => { stopImage(card, image); releasePreview(image) }))
  }
  watch(deps.mediaRevision, () => {
    stopImages()
    referenceCards.value.forEach(card => card.images.forEach(image => { image.name = '' }))
    restorePreviews()
  }, { flush: 'sync' })
  onDeactivated(() => { active.value = false; imageVisit++; stopImages() })
  onActivated(() => { active.value = true; restorePreviews() })
  onScopeDispose(() => {
    disposed = true
    releaseMigration()
    for (const card of operations.keys()) cancelCard(card)
    referenceCards.value.forEach(clearImages)
  })

  function getCharOutfits(charId?: string) {
    if (!charId) return []
    const profile = profiles.value[charId]
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
      profileFailures.value.delete(card)
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
    if (!card.outfitProseOverride && card.outfitId === outfitId && profiles.value[card.characterId]?.outfits.some(outfit => outfit.id === outfitId)
      && !profileFailures.value.has(card)) return
    await selectCardCharacter(card.characterId, cardIndex, outfitId)
  }

  /** 读取目录文字资料，不请求或上传参考图片。 */
  async function selectCardCharacter(charId: string, cardIndex = 0, outfitId?: string, signal?: AbortSignal, options: { preserveIdentity?: boolean; preserveImages?: boolean } = {}): Promise<boolean> {
    if (signal?.aborted || !referenceCards.value[cardIndex]) return false
    const card = referenceCards.value[cardIndex]
    cancelCard(card)
    if (!options.preserveImages) { clearImages(card); profileFailures.value.delete(card) }
    const controller = start(card)
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    card.characterId = charId
    if (!options.preserveIdentity) {
      card.outfitProseOverride = undefined
      card.outfitId = ''
      card.label = ''
      updateMultiCharacterIdentity()
    }
    const identityAtRead = deps.identityCard.value
    let labelEdited = false
    const stopLabelWatch = options.preserveIdentity ? undefined
      : watch(() => card.label, () => { labelEdited = true }, { flush: 'sync' })
    try {
      if (!profiles.value[charId]) {
        const result = await catalogApi.character(charId, controller.signal)
        let profile: CardProfile
        if (result.character !== null) {
          const character = parsePopularCharacter(result.character)
          if (!character || character.id !== charId) throw new Error('角色资料无效')
          profile = character
        } else {
          const character = parseCharacterProfiles([result.profile])[0]
          if (!character || character.id !== charId || !isRecord(result.profile)) throw new Error('角色资料无效')
          const raw = result.profile
          const traits = Array.isArray(raw.traits) ? raw.traits.map(value => typeof value === 'string' ? value : isRecord(value) ? value.tag : '').filter((value): value is string => typeof value === 'string') : []
          const wardrobe = isRecord(raw.lora) && isRecord(raw.lora.special_outfits) ? raw.lora.special_outfits : {}
          profile = {
            displayName: character.name,
            identityProse: [character.alias[0] || character.name, ...traits.map(proseToken)].filter(Boolean).join(', '),
            outfits: Object.entries(wardrobe).map(([id, value], index) => {
              const tokens = stringList(value)
              const bundle = OUTFIT_BUNDLES.find(item => item.character === charId && tokens.includes(item.tags[0]))
              return { id, name: bundle?.label || proseToken(tokens[0] || '') || '自定义服装', prose: tokens.map(proseToken).filter(Boolean).join(', '), tokens, default: index === 0 }
            }),
          }
        }
        if (!current(card, controller)) return false
        profiles.value = { ...profiles.value, [charId]: profile }
      }
      if (!current(card, controller)) return false
      const profile = profiles.value[charId]
      const outfit = outfitId ? profile.outfits.find(item => item.id === outfitId)
        : profile.outfits.find(item => item.default) || profile.outfits[0]
      card.outfitId = outfit?.id || ''
      if (!options.preserveIdentity && !labelEdited) {
        card.label = profile.displayName + (outfit && !outfit.default ? ` · ${outfit.name}` : '')
      }
      // Profile reads may finish after typing, or another card's automatic merge.
      if (!options.preserveIdentity && (deps.identityCard.value === identityAtRead || deps.identityCard.value === lastAutoIdentity)) updateMultiCharacterIdentity()
      if (outfitId && !outfit) { profileFailures.value.delete(card); deps.batchError.value = '该服装不存在，请重新选择'; return false }
      profileFailures.value.delete(card)
      deps.batchError.value = ''
      return true
    } catch {
      if (current(card, controller)) {
        if (!profileFailures.value.has(card)) profileFailures.value.set(card, {
          outfitId, label: card.label, identity: identityAtRead,
          restoreLabel: !options.preserveIdentity && !labelEdited, restoreIdentity: !options.preserveIdentity,
        })
        deps.batchError.value = '角色资料读取失败，可在对应角色卡重试'
      }
      return false
    } finally {
      stopLabelWatch?.()
      signal?.removeEventListener('abort', abort)
      finish(card, controller)
    }
  }

  function profileFailed(card: ReferenceCard) { return profileFailures.value.has(card) }
  async function retryCardProfile(cardIndex: number) {
    const card = referenceCards.value[cardIndex]
    const failure = card && profileFailures.value.get(card)
    if (!card?.characterId || !failure || operations.has(card) || !available()) return
    const ready = await selectCardCharacter(card.characterId, cardIndex, failure.outfitId, undefined, { preserveIdentity: true, preserveImages: true })
    if (!ready || !referenceCards.value.includes(card)) return
    const profile = profiles.value[card.characterId]
    const outfit = profile?.outfits.find(item => item.id === card.outfitId)
    if (failure.restoreLabel && card.label === failure.label) card.label = profile.displayName + (outfit && !outfit.default ? ` · ${outfit.name}` : '')
    if (failure.restoreIdentity && (deps.identityCard.value === failure.identity || deps.identityCard.value === lastAutoIdentity)) updateMultiCharacterIdentity()
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
      const profile = card.characterId ? profiles.value[card.characterId] : undefined
      const baseProse = profile?.identityProse || ''
      const outfitObj = profile?.outfits?.find(o => o.id === card.outfitId)
      const wardrobe = card.outfitProseOverride || outfitObj?.prose
      const outfitProse = wardrobe ? `, ${wardrobe}` : ''
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
      cancelCard(card); clearImages(card); profileFailures.value.delete(card)
      card.characterId = undefined; card.outfitId = undefined; card.label = ''
      updateMultiCharacterIdentity()
      return
    }

    await selectCardCharacter(charId, cardIndex)
  }

  async function onReferencePicked(cardIndex: number, event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    const card = referenceCards.value[cardIndex]
    if (!card || !available()) return
    if (card.images.length >= MAX_IMAGES_PER_CARD) {
      deps.batchError.value = '每个角色最多上传 4 张参考图'
      return
    }
    if (file.size > 20 * 1024 * 1024) {
      deps.batchError.value = '参考图需 ≤20MB'
      return
    }
    if (!file.type.startsWith('image/')) { deps.batchError.value = '请选择图片文件'; return }
    // The card owns the original before the first request, including failed uploads.
    card.images.push({ id: crypto.randomUUID(), blob: file, name: '', url: URL.createObjectURL(file) })
    await prepareReference(card, card.images[card.images.length - 1]!)
  }

  async function prepareReference(card: ReferenceCard, image: ReferenceImage) {
    if (!available() || !referenceCards.value.includes(card) || !card.images.includes(image) || image.name || imageRequests.has(image)) return
    const controller = start(card), revision = deps.mediaRevision.value, mediaSession = imageMediaSession()
    imageRequests.set(image, controller)
    const currentImage = () => available() && current(card, controller) && card.images.includes(image)
      && imageRequests.get(image) === controller && revision === deps.mediaRevision.value && mediaSession === imageMediaSession()
    try {
      const upload = await deps.uploadVideoImage(image.blob, 'reference', controller.signal)
      if (!currentImage()) return
      image.name = upload.name
      if (referenceCards.value.every(card => card.images.every(image => image.name))) deps.batchError.value = ''
    } catch (error) {
      if (currentImage()) deps.batchError.value = (error instanceof Error ? error.message : '参考图上传失败') + '；原图已保留，可重试上传或移除'
    } finally {
      if (imageRequests.get(image) === controller) imageRequests.delete(image)
      finish(card, controller)
    }
  }

  async function retryReferences(cardIndex: number) {
    const card = referenceCards.value[cardIndex], revision = deps.mediaRevision.value, visit = imageVisit
    if (!card || !available()) return
    for (const image of [...card.images]) {
      if (!available() || revision !== deps.mediaRevision.value || visit !== imageVisit) return
      await prepareReference(card, image)
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
    stopImage(card, image); releasePreview(image)
    referenceCards.value[cardIndex].images.splice(imageIndex, 1)
  }

  function selectedImages(shot: ShotCastRef): ReferenceImage[] {
    if (!shot.cast) return []
    const collect = (cardIndex: number) => referenceCards.value[cardIndex]?.images ?? []

    const list: ReferenceImage[] = []
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

    return list
  }
  function referencesReady(shot: ShotCastRef) {
    const images = selectedImages(shot)
    return !images.length || available() && images.every(image => Boolean(image.name))
  }
  /** Readiness and submission use exactly the same selected cards. */
  function shotReferences(shot: ShotCastRef): string[] | undefined {
    if (!referencesReady(shot)) throw new Error('所选角色参考图尚未就绪，请重试上传或移除后再提交')
    const unique = Array.from(new Set(selectedImages(shot).map(image => image.name))).slice(0, 9)
    return unique.length ? unique : undefined
  }

  function adoptOutfitProse(index: number, prose: string) {
    const card = referenceCards.value[index]
    if (!card || !card.characterId || !prose.trim()) return
    card.outfitProseOverride = prose.trim().slice(0, 2000)
    card.label = `${profiles.value[card.characterId]?.displayName || card.label} · 剧本衣装`
    updateMultiCharacterIdentity()
  }
  return {
    adoptOutfitProse,
    referenceCards, profileFailed, retryCardProfile,
    loadingRefAssets,
    loadingRefCardIndex,
    getCharOutfits,
    addReferenceCard,
    removeReferenceCard,
    switchCardOutfit,
    selectCardCharacter,
    onCardCharacterSelected,
    onReferencePicked,
    pickReference,
    setReferenceInput,
    removeReference,
    retryReferences, referencesReady, shotReferences,
  }
}

import { computed, nextTick, ref, watch, type Ref } from 'vue'
import { useShowcaseAssets } from '@/composables/scene/useShowcaseAssets'
import { isBackdropClick, useFluidDialog } from '@/composables/useFluidDialog'
import { useSceneStore } from '@/stores/sceneStore'
import {
  parseCharacterProfiles,
  parseCharacterScenes,
  type CharacterScene,
} from '@/utils/characterProfiles'

type CharacterProfile = ReturnType<typeof parseCharacterProfiles>[number]

export interface RecommendationScene extends CharacterScene {
  rating?: string
  mature?: boolean
}

export function useCharacterRecommendations(options: {
  current: Readonly<Ref<CharacterProfile | null>>
  showShelf: Readonly<Ref<boolean>>
  isPopular: Readonly<Ref<boolean>>
}) {
  const { current, showShelf, isPopular } = options
  const sceneStore = useSceneStore()
  const scenes = ref<CharacterScene[]>([])
  const sceneRatings = ref<ReadonlyMap<string, { rating?: string; mature?: boolean }>>(new Map())
  const { entryFor: sampleEntryFor, thumbUrl: sampleThumbUrl } = useShowcaseAssets(
    undefined,
    () => !showShelf.value && !!current.value,
  )

  function recommendArchiveCode(id: string): string {
    const safe = String(id || '').toLowerCase().replace(/[^a-z0-9_-]/g, '')
    return safe.replace(/^sc(?=\d)/, 'sc-').toUpperCase()
  }

  function recommendThumbSrc(id: string): string {
    const manifestThumb = sampleThumbUrl(id)
    if (manifestThumb) return manifestThumb
    const safe = String(id || '').toLowerCase().replace(/[^a-z0-9_-]/g, '')
    return safe ? `/scene-showcase/thumbs/${safe}.jpg` : ''
  }

  function isRecommendSensitive(scene: RecommendationScene): boolean {
    const sampleRating = sampleEntryFor(scene.id)?.rating
    return sampleRating === 'R18' || scene.rating === 'R18' || Boolean(scene.mature)
  }

  const recommendationsLoading = ref(false)
  const recommendationsError = ref(false)
  const recommendationReload = ref(0)
  const recommendationRoot = ref<HTMLElement | null>(null)

  function retryRecommendations() {
    recommendationRoot.value?.focus({ preventScroll: true })
    recommendationReload.value++
  }

  const recommendations = computed<RecommendationScene[]>(() => {
    if (!current.value) return []
    if (current.value.type === 'popular') {
      // 热门角色：人设核心场景 = 该角色的原型场景（scene-blueprints 按 characterId）
      return sceneStore.sceneBlueprints
        .filter(bp => bp.characterId === current.value?.id)
        .slice(0, 6)
        .map(bp => ({
          id: bp.id,
          title: bp.title,
          story: bp.description,
          char: current.value?.id ?? '',
          rating: bp.sampleRating || (bp.adult ? 'R18' : 'All'),
          mature: bp.adult,
        }))
    }
    const core = sceneStore.curation.personaCoreSceneIds
    const ids = Array.isArray(core) && core.length ? core : current.value.lora?.recommended_scene
    if (!Array.isArray(ids)) return []
    return ids
      .map((id: string) => scenes.value.find(s => s.id === id))
      .filter((scene): scene is CharacterScene =>
        Boolean(scene && [current.value?.id, 'triad', 'both'].includes(scene.char)))
      .slice(0, 6)
      .map(scene => {
        const meta = sceneRatings.value.get(scene.id)
        return { ...scene, rating: meta?.rating, mature: meta?.mature }
      })
  })

  const officialProfileUrl = computed(() => current.value?.id === 'nene'
    ? 'https://www.yuzu-soft.com/products/sothewitch/character.html'
    : current.value?.id === 'natsume'
      ? 'https://www.yuzu-soft.com/products/stella/character.html'
      : '')

  function recommendationReason(id: string) {
    return sceneStore.curation.personaCoreReasons?.[id] || ''
  }

  function recommendationDrawUrl(scene: CharacterScene) {
    return isPopular.value && current.value
      ? `/prompt-builder?popular=${encodeURIComponent(current.value.id)}&blueprint=${encodeURIComponent(scene.id)}`
      : `/prompt-builder?scene=${encodeURIComponent(scene.id)}`
  }

  const activeStory = ref<CharacterScene | null>(null)
  const recommendationDialog = ref<HTMLDialogElement | null>(null)
  const recommendationStoryBody = ref<HTMLElement | null>(null)
  const recommendationStoryDialog = useFluidDialog(recommendationDialog)

  async function openRecommendationStory(scene: CharacterScene, event: MouseEvent) {
    const source = event.currentTarget as HTMLElement
    activeStory.value = scene
    await nextTick()
    recommendationStoryDialog.open(source)
    // Reset after showModal restores the body's layout box, including same-story revisits.
    if (recommendationStoryBody.value) recommendationStoryBody.value.scrollTop = 0
  }

  function closeRecommendationBackdrop(event: MouseEvent) {
    if (isBackdropClick(event, recommendationDialog.value)) recommendationStoryDialog.close()
  }

  watch([() => current.value?.id, recommendationReload, () => sceneStore.version], async (_current, _previous, onCleanup) => {
    const profile = current.value
    let active = true
    onCleanup(() => { active = false })
    recommendationsLoading.value = Boolean(profile)
    recommendationsError.value = false
    scenes.value = []
    if (!profile) return
    try {
      // Metadata alone does not load blueprints; each profile owns its scene request.
      if (profile.type === 'popular') await sceneStore.loadBlueprintCharacter(profile.id)
      else {
        const catalog = await sceneStore.loadBrowserScenes('all')
        if (active) {
          scenes.value = parseCharacterScenes(catalog.scenes)
          sceneRatings.value = new Map(
            catalog.scenes.map(scene => [
              scene.id,
              {
                rating: typeof scene.rating === 'string' ? scene.rating : undefined,
                mature: typeof scene.mature === 'boolean' ? scene.mature : undefined,
              },
            ]),
          )
        }
      }
    } catch (error) {
      if (active) recommendationsError.value = true
      console.warn('character scene data load failed', error)
    } finally {
      if (active) recommendationsLoading.value = false
    }
  }, { immediate: true })

  return {
    recommendArchiveCode,
    recommendThumbSrc,
    isRecommendSensitive,
    recommendationsLoading,
    recommendationsError,
    recommendationRoot,
    retryRecommendations,
    recommendations,
    officialProfileUrl,
    recommendationReason,
    recommendationDrawUrl,
    activeStory,
    recommendationDialog,
    recommendationStoryBody,
    recommendationStoryDialog,
    openRecommendationStory,
    closeRecommendationBackdrop,
  }
}

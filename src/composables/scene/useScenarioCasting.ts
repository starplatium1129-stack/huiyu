import { computed, onScopeDispose, ref, watch, type Ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSceneStore } from '@/stores/sceneStore'

/** Optional catalog cast. Existing authored stories remain reusable starting points. */
export function useScenarioCasting(baseCharacter: Ref<string>) {
  const route = useRoute(), router = useRouter(), scenes = useSceneStore()
  const error = ref(''), loading = ref(false)
  const castId = computed({
    get: () => typeof route.query.cast === 'string' ? route.query.cast : '',
    set: (id: string) => { const query = { ...route.query }; if (id) query.cast = id; else delete query.cast; delete query.outfit; void router.replace({ query }) },
  })
  const character = computed(() => scenes.popularCharacters.find(character => character.id === castId.value))
  const outfitId = computed({
    get: () => typeof route.query.outfit === 'string' ? route.query.outfit
      : character.value?.outfits.find(outfit => outfit.default)?.id || character.value?.outfits[0]?.id || '',
    set: (id: string) => { void router.replace({ query: { ...route.query, outfit: id } }) },
  })
  const outfit = computed(() => character.value?.outfits.find(outfit => outfit.id === outfitId.value))
  const options = computed(() => [{ value: '', label: '使用故事原角色' }, ...scenes.directoryCharacters.map(character => ({ value: character.id, label: character.displayName }))])
  const outfitOptions = computed(() => character.value?.outfits.map(outfit => ({ value: outfit.id, label: outfit.name })) || [])
  const ready = computed(() => !castId.value || Boolean(character.value && outfit.value))
  const query = computed(() => castId.value ? { char: baseCharacter.value, cast: castId.value, outfit: outfitId.value } : { char: baseCharacter.value })
  let revision = 0
  async function reload() {
    const request = ++revision
    loading.value = true; error.value = ''
    try {
      await Promise.all([scenes.loadCharacterDirectory(), castId.value ? scenes.loadPopularCharacters() : undefined])
    } catch (cause) {
      if (request === revision) error.value = cause instanceof Error ? cause.message : '角色目录读取失败，可重新读取'
    } finally { if (request === revision) loading.value = false }
  }
  watch([castId, () => scenes.version], () => { void reload() }, { immediate: true })
  onScopeDispose(() => { revision++ })
  return { castId, outfitId, character, outfit, options, outfitOptions, ready, query, error, loading, reload }
}

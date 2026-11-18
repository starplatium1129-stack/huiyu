import { computed, ref, watch } from 'vue'
import { useSceneStore } from '@/stores/sceneStore'

/** Each view owns its selection and retry state; the store shares the character read. */
export function useCharacterBlueprints(characterId: () => string) {
  const store = useSceneStore()
  const error = ref('')
  const attempt = ref(0)
  const ready = computed(() => store.hasBlueprintCharacter(characterId()))
  const items = computed(() => ready.value
    ? store.sceneBlueprints.filter(blueprint => blueprint.characterId === characterId()) : [])

  watch([characterId, () => store.version, attempt], async ([id], _, onCleanup) => {
    error.value = ''
    if (!id || store.hasBlueprintCharacter(id)) return
    let current = true
    onCleanup(() => { current = false })
    try { await store.loadBlueprintCharacter(id) }
    catch { if (current) error.value = '角色蓝图读取失败' }
  }, { immediate: true })
  return { items, ready, error, retry: () => { attempt.value++ } }
}

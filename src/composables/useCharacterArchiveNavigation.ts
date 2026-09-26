import { computed, nextTick, onDeactivated, onScopeDispose, ref, watch, type Ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { CharacterProfile } from '@/types/character'
import { scrollBehavior } from '@/utils/motionPreference'
import { captureScrollAnchor, restoreScrollAnchor, type ScrollAnchor } from '@/utils/scrollAnchor'

/** The URL owns the open profile; the shelf keeps its own browsing position. */
export function useCharacterArchiveNavigation(
  characters: Ref<CharacterProfile[]>,
  profileAnchor: Ref<HTMLElement | null>,
  restoreShelfFocus: () => void,
) {
  const route = useRoute()
  const router = useRouter()
  const requestedId = computed(() => typeof route.query.character === 'string' ? route.query.character : '')
  const current = computed(() => characters.value.find(character => character.id === requestedId.value) ?? null)
  const showShelf = computed(() => !current.value)
  const lastViewedId = ref('')
  let shelfAnchor: ScrollAnchor | null = null
  let cancelRestore = () => {}
  onDeactivated(() => cancelRestore())
  onScopeDispose(() => cancelRestore())

  watch(current, character => {
    if (character) lastViewedId.value = character.id
  }, { immediate: true })

  watch(requestedId, async (id, previous) => {
    cancelRestore()
    await nextTick()
    if (id !== requestedId.value || route.path !== '/character') return
    if (showShelf.value) {
      if (previous) {
        restoreShelfFocus()
        if (shelfAnchor) cancelRestore = restoreScrollAnchor(shelfAnchor, {
          shouldContinue: () => showShelf.value && route.path === '/character',
        })
      }
      return
    }
    const anchor = profileAnchor.value
    if (!anchor) return
    const rect = anchor.getBoundingClientRect()
    if (rect.top < 70 || rect.top >= window.innerHeight * 0.9) {
      anchor.scrollIntoView({ behavior: scrollBehavior(), block: 'start' })
    }
  }, { flush: 'post' })

  function selectCharacter(id: string) {
    if (id === requestedId.value || !characters.value.some(character => character.id === id)) return
    if (showShelf.value) shelfAnchor = captureScrollAnchor()
    const target = { query: { ...route.query, character: id } }
    // Returning from a profile should restore the shelf, not step through every
    // character visited with the existing detail sidebar.
    void (showShelf.value ? router.push(target) : router.replace(target))
  }

  function showBookshelf() {
    const query = { ...route.query }
    delete query.character
    void router.push({ query })
  }

  return { current, showShelf, lastViewedId, selectCharacter, showBookshelf }
}

import { computed, nextTick, onDeactivated, onScopeDispose, ref, watch, type Ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { CharacterProfile } from '@/types/character'
import { captureScrollAnchor, restoreScrollAnchor, watchForUserScroll, type ScrollAnchor } from '@/utils/scrollAnchor'

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
  let stopUserScroll = () => {}
  let revision = 0
  function cancel() { revision++; cancelRestore(); stopUserScroll() }
  onDeactivated(cancel)
  onScopeDispose(cancel)

  watch(current, character => {
    if (character) lastViewedId.value = character.id
  }, { immediate: true })

  watch(requestedId, async (id, previous) => {
    cancel()
    const version = revision
    await nextTick()
    if (version !== revision || id !== requestedId.value || route.path !== '/character') return
    if (showShelf.value) {
      if (previous) {
        restoreShelfFocus()
        if (shelfAnchor) {
          stopUserScroll = watchForUserScroll(cancel)
          cancelRestore = restoreScrollAnchor(shelfAnchor, {
            immediate: true,
            shouldContinue: () => version === revision && showShelf.value && route.path === '/character',
            onRestored: () => stopUserScroll(),
            onAbandoned: () => stopUserScroll(),
          })
        }
      }
      return
    }
    const anchor = profileAnchor.value
    if (!anchor) return
    const rect = anchor.getBoundingClientRect()
    if (rect.top < 70 || rect.top >= window.innerHeight * 0.9) {
      // The section itself supplies entry motion. Scrolling the whole document
      // as well makes a shelf/detail switch look like the page is rebounding.
      anchor.scrollIntoView({ behavior: 'instant', block: 'start' })
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

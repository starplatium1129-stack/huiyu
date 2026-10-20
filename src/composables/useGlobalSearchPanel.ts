import { nextTick, onMounted, onUnmounted, ref, watch, type Ref } from 'vue'
import { isNavigationFailure, NavigationFailureType, useRoute, useRouter } from 'vue-router'
import { useFocusTrap } from '@/composables/useFocusTrap'
import { useGlobalSearchRequest, type SearchOpenSource } from '@/composables/useGlobalSearch'
import { useToast } from '@/composables/useToast'
import { artworkRepository } from '@/storage/artworkRepository'
import { artworkContinueTarget } from '@/utils/artworkNavigation'
import { imageMediaSession } from '@/platform/imageMediaSession'
import type { GlobalSearchResult } from '@/composables/useGlobalSearchResults'

interface SearchPanelOptions {
  panelEl: Ref<HTMLElement | null>
  inputEl: Ref<HTMLInputElement | null>
  initial: {
    initialSource?: SearchOpenSource
    initialTrigger?: HTMLElement | null
    initialPath?: string
    initialCloseRequest: number
  }
}

/** Owns the search surface, keyboard requests and asynchronous navigation handoff. */
export function useGlobalSearchPanel(options: SearchPanelOptions) {
  const { panelEl, inputEl } = options
  const router = useRouter(), route = useRoute(), toast = useToast()
  const open = ref(false), query = ref('')
  const triggerSource = ref<SearchOpenSource>('keyboard')
  let previousActiveElement: HTMLElement | null = null
  let navigationRequest = 0

  async function navigate(item: GlobalSearchResult) {
    if (!open.value) return
    const origin = previousActiveElement, path = route.fullPath, request = ++navigationRequest
    const closing = closeRequest.value, session = imageMediaSession()
    close(false)
    async function restoreFocus() {
      await nextTick()
      if (request !== navigationRequest || open.value || route.fullPath !== path || document.activeElement !== document.body
        || !origin?.isConnected || origin.matches(':disabled') || origin.closest('[inert], [hidden]')
        || !origin.getClientRects().length || document.querySelector('dialog:modal')) return
      const visibility = getComputedStyle(origin).visibility
      if (visibility !== 'hidden' && visibility !== 'collapse') origin.focus({ preventScroll: true })
    }
    let target: string
    if ('artworkId' in item) {
      const current = () => request === navigationRequest && closeRequest.value === closing
        && route.fullPath === path && imageMediaSession() === session
      try {
        const artwork = await artworkRepository.readArtwork(item.artworkId, AbortSignal.timeout(35_000))
        if (!current()) return
        if (!artwork) { toast.error('作品已移除或暂时无法读取。'); await restoreFocus(); return }
        target = artworkContinueTarget(artwork).to
      } catch {
        if (current()) { toast.error('作品读取失败，请重试。'); await restoreFocus() }
        return
      }
    } else target = item.path
    try {
      const failure = await router.push(target)
      if (!isNavigationFailure(failure, NavigationFailureType.aborted | NavigationFailureType.duplicated)) return
      // Release the search/confirmation focus trap before returning to this page.
      await restoreFocus()
    } catch {
      // Router onError already exposes the existing route-recovery banner.
      // A rejected or superseded navigation must not reclaim another surface's focus.
    }
  }

  function openPanel(source: 'keyboard' | 'pointer' = 'keyboard', trigger = document.activeElement as HTMLElement | null) {
    // Global navigation must not open an inert body portal underneath a modal editor.
    if (!open.value && (document.querySelector('dialog:modal') || document.activeElement?.closest('[aria-modal="true"]'))) return
    navigationRequest++
    previousActiveElement = trigger
    triggerSource.value = source
    open.value = true
    query.value = ''
    const path = route.fullPath
    void nextTick(() => { if (open.value && route.fullPath === path) inputEl.value?.focus({ preventScroll: true }) })
  }

  function close(restoreFocus = true) {
    if (!restoreFocus) {
      returnFocus.value = null
      const active = document.activeElement
      if (active instanceof HTMLElement && panelEl.value?.contains(active)) active.blur()
    }
    open.value = false
    const previous = previousActiveElement, path = route.fullPath, closing = panelEl.value
    previousActiveElement = null
    if (restoreFocus && previous) void nextTick(() => {
      const active = document.activeElement
      if (!open.value && route.fullPath === path && previous.isConnected && !document.querySelector('dialog:modal')
        && (active === document.body || closing?.contains(active))) previous.focus({ preventScroll: true })
    })
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.isComposing || event.keyCode === 229 || event.defaultPrevented) return
    const target = event.target as HTMLElement | null
    const isInput = /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName || '') || target?.isContentEditable === true

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      if (event.repeat) return
      if (open.value) { close() } else { openPanel('keyboard') }
      return
    }

    if (event.key === '/' && !isInput && !open.value) {
      event.preventDefault()
      openPanel('keyboard')
    }
  }

  const { returnFocus } = useFocusTrap(panelEl, () => open.value, {
    onEscape: close,
    initialFocus: inputEl,
  })

  watch(() => route.fullPath, () => close(false), { flush: 'sync' })
  const { openRequest, openSource, closeRequest } = useGlobalSearchRequest()
  watch(closeRequest, () => close(false), { flush: 'sync' })
  watch(openRequest, () => { if (openRequest.value) openPanel(openSource.value) })

  onMounted(() => {
    document.addEventListener('keydown', onKeydown)
    if (options.initial.initialSource && options.initial.initialCloseRequest === closeRequest.value
      && (!options.initial.initialPath || options.initial.initialPath === route.fullPath)) openPanel(options.initial.initialSource, options.initial.initialTrigger)
  })
  onUnmounted(() => {
    navigationRequest++
    document.removeEventListener('keydown', onKeydown)
  })

  return { open, query, triggerSource, close, navigate }
}

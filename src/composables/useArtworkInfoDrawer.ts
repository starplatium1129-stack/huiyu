import { computed, nextTick, watch, type Ref } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { useFocusTrap } from './useFocusTrap'

/** Shared sidebar/drawer behavior for native and custom artwork viewers. */
export function useArtworkInfoDrawer(options: {
  viewer: Ref<HTMLElement | null>
  panel: Ref<HTMLElement | null>
  trigger: Ref<HTMLElement | null>
  closeButton: Ref<HTMLElement | null>
  viewerCloseButton: Ref<HTMLElement | null>
  open: Ref<boolean>
  active: () => boolean
}) {
  const compact = useMediaQuery('(max-width: 900px)')
  const hidden = computed(() => compact.value && !options.open.value)

  function close(event?: MouseEvent | KeyboardEvent) {
    options.viewer.value?.toggleAttribute('data-info-instant', !event || event.detail === 0)
    options.open.value = false
  }
  function toggle(event?: MouseEvent | KeyboardEvent) {
    if (!options.active() || !compact.value) return
    options.viewer.value?.toggleAttribute('data-info-instant', !event || event.detail === 0)
    // Both mouse and keyboard opening return to the same visible launcher.
    if (!options.open.value) options.trigger.value?.focus({ preventScroll: true })
    options.open.value = !options.open.value
  }

  useFocusTrap(options.panel, () => options.active() && compact.value && options.open.value, {
    initialFocus: options.closeButton, onEscape: close, lockScroll: false,
  })
  watch(compact, value => {
    if (!options.active()) return
    const focused = document.activeElement
    let target: Ref<HTMLElement | null> | undefined
    if (value && !options.open.value && options.panel.value?.contains(focused)) {
      target = options.trigger
    } else if (!value && (options.open.value || focused === options.trigger.value)) {
      close()
      target = options.viewerCloseButton
    }
    // Wait for the old trap and inert state to release, then recheck the current
    // viewer/breakpoint so rapid resize or closing cannot steal focus later.
    if (target) void nextTick(() => {
      if (options.active() && compact.value === value) target.value?.focus({ preventScroll: true })
    })
  }, { flush: 'sync' })

  return { compact, hidden, toggle, close }
}

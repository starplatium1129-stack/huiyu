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
    options.viewer.value?.toggleAttribute('data-info-instant', !event)
    options.open.value = false
  }
  function toggle(event?: MouseEvent | KeyboardEvent) {
    if (!options.active() || !compact.value) return
    options.viewer.value?.toggleAttribute('data-info-instant', !event)
    // Both mouse and keyboard opening return to the same visible launcher.
    if (!options.open.value) options.trigger.value?.focus({ preventScroll: true })
    options.open.value = !options.open.value
  }

  const { returnFocus } = useFocusTrap(options.panel, () => options.active() && compact.value && options.open.value, {
    initialFocus: options.closeButton, onEscape: close, lockScroll: false,
  })
  watch(compact, value => {
    if (!options.active()) return
    const focused = document.activeElement
    let target: Ref<HTMLElement | null> | undefined
    if (value && !options.open.value && options.panel.value?.contains(focused)) {
      target = options.trigger
    } else if (!value && (options.open.value || focused === options.trigger.value)) {
      if (options.open.value) {
        // The information body survives as a sidebar. Let the old trap retain
        // its visible control instead of returning to a now-hidden launcher.
        const retain = focused instanceof HTMLElement && options.viewer.value?.contains(focused)
          && focused !== options.trigger.value && focused !== options.closeButton.value
          && focused.closest('dialog:modal, [aria-modal="true"]') === options.viewer.value
        returnFocus.value = retain ? focused : options.viewerCloseButton.value
      } else target = options.viewerCloseButton
      close()
    }
    // Wait for the old trap and inert state to release, then recheck the current
    // viewer/breakpoint so rapid resize or closing cannot steal focus later.
    if (target) void nextTick(() => {
      if (options.active() && compact.value === value
        && (document.activeElement === focused || document.activeElement === document.body)) target.value?.focus({ preventScroll: true })
    })
  }, { flush: 'sync' })

  return { compact, hidden, toggle, close }
}

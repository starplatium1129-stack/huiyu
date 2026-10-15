import { nextTick, onActivated, onBeforeUnmount, onDeactivated, watch, type Ref } from 'vue'

/** Inline settings replace their focused content; keep the persistent entry usable. */
export function useInlinePanelFocus(open: Ref<boolean>, panel: () => HTMLElement | null, trigger: Ref<HTMLElement | null>) {
  let revision = 0, active = true
  watch(open, value => {
    const current = ++revision
    const enteredFromTrigger = document.activeElement === trigger.value
    const leavingPanel = panel()?.contains(document.activeElement)
    void nextTick().then(() => {
      if (!active || current !== revision) return
      if (value && enteredFromTrigger) panel()?.focus({ preventScroll: true })
      else if (!value && leavingPanel && trigger.value?.isConnected && trigger.value.getClientRects().length
        && !trigger.value.closest('[inert], [hidden]')) trigger.value.focus({ preventScroll: true })
    })
  }, { flush: 'sync' })
  onActivated(() => { active = true })
  onDeactivated(() => { active = false; revision++ })
  onBeforeUnmount(() => { active = false; revision++ })
}

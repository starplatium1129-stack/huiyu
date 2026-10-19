import { nextTick, onActivated, onBeforeUnmount, onDeactivated, ref, shallowRef, watch, type Component } from 'vue'

/** Workspace tools initialize only after intent survives their module import. */
export function useDeferredToolLauncher(load: () => Promise<{ default: Component }>, disabled: () => boolean, onError: () => void) {
  const host = ref<HTMLElement | null>(null)
  const panel = shallowRef<Component | null>(null)
  const loading = ref(false), requested = ref(false), open = ref(false)
  let available: Component | null = null, active = true, disposed = false
  watch(disabled, value => { if (value) requested.value = false }, { flush:'sync' })

  function dismissPending(event: Event) {
    if (!event.composedPath().includes(host.value as HTMLElement)) requested.value = false
  }
  function pendingKey(event: KeyboardEvent) {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.keyCode === 229) return
    event.preventDefault(); event.stopPropagation(); requested.value = false
  }
  function stopListening() {
    document.removeEventListener('pointerdown', dismissPending, true)
    document.removeEventListener('focusin', dismissPending, true)
    document.removeEventListener('keydown', pendingKey, true)
  }
  watch([loading, requested], ([pending, wantsOpen]) => {
    stopListening()
    if (!active || !pending || !wantsOpen) return
    document.addEventListener('pointerdown', dismissPending, { capture:true, passive:true })
    document.addEventListener('focusin', dismissPending, true)
    document.addEventListener('keydown', pendingKey, true)
  }, { flush:'sync' })
  function focusTrigger() { host.value?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll:true }) }
  async function toggle() {
    if (disabled()) return
    requested.value = !requested.value
    if (loading.value || !requested.value) return
    loading.value = true
    try {
      const component = available ?? (await load()).default
      if (disposed) return
      available = component
      if (!active || !requested.value) return
      const ownedFocus = Boolean(host.value?.contains(document.activeElement))
      panel.value = available
      await nextTick()
      if (!active || disposed) return
      // The ready trigger must own focus before its popover hands off to a dialog.
      if (requested.value || ownedFocus && document.activeElement === document.body) focusTrigger()
      open.value = requested.value
      requested.value = false
    } catch {
      const notify = requested.value && active && !disposed
      requested.value = false
      if (notify) onError()
    } finally { if (!disposed) loading.value = false }
  }
  onActivated(() => { active = true })
  onDeactivated(() => { active = false; requested.value = false; open.value = false; stopListening() })
  onBeforeUnmount(() => { disposed = true; active = false; stopListening() })
  function update(value: boolean) { open.value = value }
  return { host, panel, loading, requested, open, toggle, update }
}

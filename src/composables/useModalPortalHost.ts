import { computed, onActivated, onMounted, shallowRef, watch, type Ref } from 'vue'

/** Reka content stays inside its owning native/custom modal and focus scope. */
export function useModalPortalHost(source: () => HTMLElement | { $el?: unknown } | null | undefined,
  open?: Readonly<Ref<boolean>>, fallback?: () => HTMLElement | null | undefined) {
  const portalTarget = shallowRef<HTMLElement>()
  function resolveTarget(raw: unknown): HTMLElement | null | undefined {
    if (!raw) return undefined
    if (typeof raw === 'object' && '$el' in raw && (raw as { $el?: unknown }).$el instanceof HTMLElement) {
      return (raw as { $el: HTMLElement }).$el
    }
    return raw instanceof HTMLElement ? raw : undefined
  }
  function syncPortalHost() {
    const el = resolveTarget(source())
    portalTarget.value = el?.closest<HTMLElement>('dialog, [role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]')
      ?? fallback?.() ?? undefined
  }
  onMounted(syncPortalHost)
  onActivated(syncPortalHost)
  // Text, progress and selection patches do not change a trigger's modal owner.
  watch(source, syncPortalHost, { flush: 'post' })
  if (open) watch(open, value => { if (value) syncPortalHost() }, { flush: 'sync' })
  if (fallback) watch(fallback, syncPortalHost, { flush: 'post' })
  const collisionBoundary = computed(() => portalTarget.value?.tagName !== 'DIALOG'
    && portalTarget.value?.matches('[aria-modal="true"]') ? portalTarget.value : undefined)
  return { portalTarget, collisionBoundary, syncPortalHost }
}

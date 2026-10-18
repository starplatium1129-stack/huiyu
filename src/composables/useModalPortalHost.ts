import { computed, onActivated, onMounted, onUpdated, shallowRef, watch, type Ref } from 'vue'

/** Reka content stays inside its owning native/custom modal and focus scope. */
export function useModalPortalHost(source: () => HTMLElement | null | undefined,
  open?: Readonly<Ref<boolean>>, fallback?: () => HTMLElement | null | undefined) {
  const portalTarget = shallowRef<HTMLElement>()
  function syncPortalHost() {
    portalTarget.value = source()?.closest<HTMLElement>('dialog, [role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]')
      ?? fallback?.() ?? undefined
  }
  onMounted(syncPortalHost)
  onUpdated(syncPortalHost)
  onActivated(syncPortalHost)
  if (open) watch(open, value => { if (value) syncPortalHost() }, { flush: 'sync' })
  if (fallback) watch(fallback, syncPortalHost, { flush: 'post' })
  const collisionBoundary = computed(() => portalTarget.value?.tagName !== 'DIALOG'
    && portalTarget.value?.matches('[aria-modal="true"]') ? portalTarget.value : undefined)
  return { portalTarget, collisionBoundary, syncPortalHost }
}

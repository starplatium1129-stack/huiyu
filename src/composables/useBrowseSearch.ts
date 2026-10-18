import { onActivated, onDeactivated, onScopeDispose, readonly, ref, watch } from 'vue'

/** Echo typing immediately; settle catalog work, but restore navigation and clears now. */
export function useBrowseSearch(initial = '') {
  const query = ref(initial)
  const settledQuery = ref(initial)
  let pending: ReturnType<typeof setTimeout> | undefined
  function cancel() { clearTimeout(pending); pending = undefined }
  watch(query, value => {
    cancel()
    if (!value.trim()) { settledQuery.value = value; return }
    pending = setTimeout(() => {
      pending = undefined
      settledQuery.value = value
    }, 150)
  }, { flush: 'sync' })
  function restoreQuery(value: string) {
    query.value = value
    cancel()
    settledQuery.value = value
  }
  onActivated(() => restoreQuery(query.value))
  onDeactivated(cancel)
  onScopeDispose(cancel)
  return { query, settledQuery: readonly(settledQuery), restoreQuery }
}

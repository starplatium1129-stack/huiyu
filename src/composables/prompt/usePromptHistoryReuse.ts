import { getCurrentInstance, onActivated, onDeactivated, onScopeDispose, ref, shallowRef, toRaw, type Ref } from 'vue'
import type { ArtworkRecord } from '@/types/artwork'
import type { HistoryReuseSelection } from '@/types/historyReuse'
import type { PromptHistoryApplyDeps } from './usePromptHistoryApply'

export interface HistoryReuseState {
  request: Ref<{ record: ArtworkRecord; variant: boolean } | null>
  busy: Ref<boolean>
  revision: number
}
export interface HistoryReuseDeps extends PromptHistoryApplyDeps {
  generationBusy: Ref<boolean>
  onApplied(): void
}

/** Only the pending choice is eager. Reading and applying recipes load on the first explicit action. */
export function usePromptHistoryReuse(deps: HistoryReuseDeps) {
  const state: HistoryReuseState = { request: shallowRef(null), busy: ref(false), revision: 0 }
  const reuseLoading = ref(false), reuseError = ref('')
  type Pending = { record: ArtworkRecord; variant: boolean; choose: boolean }
  let pending: Pending | null = null, attached = true, disposed = false, deleteRequest = 0
  let actions: Promise<ReturnType<typeof import('./historyReuseActions')['historyReuseActions']>> | null = null
  const getActions = () => actions ??= import('./historyReuseActions').then(module => module.historyReuseActions(deps, state))
    .catch(error => { actions = null; throw error })
  const current = (expected: number) => !disposed && attached && expected === state.revision
  function cancelReuse() {
    state.revision++; pending = null; state.request.value = null
    reuseLoading.value = false; reuseError.value = ''
  }
  if (getCurrentInstance()) {
    onActivated(() => { attached = true })
    onDeactivated(() => { attached = false; cancelReuse() })
  }
  onScopeDispose(() => { disposed = true; cancelReuse() })
  async function loadReuse(request: Pending) {
    const expected = ++state.revision
    pending = request; state.request.value = { record: request.record, variant: request.variant }
    reuseLoading.value = true; reuseError.value = ''
    try {
      const api = await getActions()
      if (!current(expected)) return false
      const ready = await api.request(request.record, request.variant, request.choose)
      if (current(expected) && !ready) { state.request.value = null; pending = null }
      return current(expected) && ready
    } catch {
      if (current(expected)) reuseError.value = '历史配方暂时无法读取，请重试。'
      return false
    } finally {
      if (current(expected)) { reuseLoading.value = false; if (!state.request.value) pending = null }
    }
  }
  async function applyHistory(record: ArtworkRecord, variant = false, choose = variant) {
    if (disposed || !attached) return false
    // A blocked click must not invalidate the restore already in progress.
    if (state.busy.value || deps.generationBusy.value) {
      deps.pb.flash('生成或配方载入进行中，完成或停止后再载入配方')
      return false
    }
    try {
      // Keep the clicked record's fields and missing values, not a live store reference.
      return await loadReuse({ record: structuredClone(toRaw(record)), variant, choose })
    } catch {
      deps.pb.flash('这条作品记录无法读取，当前草稿已保留', 5000, 'warning')
      return false
    }
  }
  async function retryReuse() {
    if (!pending || reuseLoading.value || state.busy.value || disposed || !attached) return false
    return loadReuse(pending)
  }
  async function applyReuse(selection: HistoryReuseSelection) {
    const expected = state.revision
    if (!current(expected) || !state.request.value || reuseLoading.value || reuseError.value) return false
    try {
      const api = await getActions()
      return current(expected) ? await api.apply(selection) : false
    } catch {
      if (current(expected)) reuseError.value = '历史配方暂时无法读取，请重试。'
      return false
    } finally { if (current(expected) && !state.request.value) pending = null }
  }
  async function deleteHistory(entry: ArtworkRecord) {
    const expected = state.revision, request = ++deleteRequest
    if (!current(expected)) return
    try {
      const record = structuredClone(toRaw(entry)), api = await getActions()
      if (current(expected) && request === deleteRequest) await api.remove(record)
    } catch {
      if (current(expected) && request === deleteRequest) deps.pb.flash('删除工具未能打开，请重新点击删除重试', 5000, 'warning')
    }
  }
  async function reuseSuccessfulRecipe(id: string | number) {
    const entry = deps.pb.history.find(item => item.id === id)
    if (entry) await applyHistory(entry, true)
  }
  return { reuseRequest: state.request, reuseBusy: state.busy, reuseLoading, reuseError, retryReuse, cancelReuse, applyReuse, applyHistory,
    resumeHistory: (entry: ArtworkRecord) => applyHistory(entry, false, true),
    duplicateHistory: (entry: ArtworkRecord) => applyHistory(entry, true),
    deleteHistory, reuseSuccessfulRecipe }
}

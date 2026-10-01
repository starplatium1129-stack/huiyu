import { getCurrentInstance, onDeactivated, onScopeDispose, ref, shallowRef, type Ref } from 'vue'
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
  let actions: Promise<ReturnType<typeof import('./historyReuseActions')['historyReuseActions']>> | null = null
  const getActions = () => actions ??= import('./historyReuseActions').then(module => module.historyReuseActions(deps, state))
  function cancelReuse() { state.revision++; state.request.value = null }
  if (getCurrentInstance()) onDeactivated(cancelReuse)
  onScopeDispose(cancelReuse)
  async function applyHistory(record: ArtworkRecord, variant = false, choose = variant) {
    // A blocked click must not invalidate the restore already in progress.
    if (state.busy.value || deps.generationBusy.value) {
      deps.pb.flash('生成或配方载入进行中，完成或停止后再载入配方')
      return false
    }
    const expected = ++state.revision, api = await getActions()
    return expected === state.revision ? api.request(record, variant, choose) : false
  }
  async function applyReuse(selection: HistoryReuseSelection) {
    const expected = state.revision, api = await getActions()
    return expected === state.revision ? api.apply(selection) : false
  }
  async function reuseSuccessfulRecipe(id: string | number) {
    const entry = deps.pb.history.find(item => item.id === id)
    if (entry) await applyHistory(entry, true)
  }
  return { reuseRequest: state.request, reuseBusy: state.busy, cancelReuse, applyReuse, applyHistory,
    resumeHistory: (entry: ArtworkRecord) => applyHistory(entry, false, true),
    duplicateHistory: (entry: ArtworkRecord) => applyHistory(entry, true),
    deleteHistory: async (entry: ArtworkRecord) => (await getActions()).remove(entry), reuseSuccessfulRecipe }
}

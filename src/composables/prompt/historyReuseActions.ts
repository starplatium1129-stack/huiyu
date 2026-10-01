import type { ArtworkRecord } from '@/types/artwork'
import type { HistoryReuseSelection } from '@/types/historyReuse'
import { usePromptHistoryApply } from './usePromptHistoryApply'
import type { HistoryReuseDeps, HistoryReuseState } from './usePromptHistoryReuse'

/** Deferred controller for the existing recipe application path; no task or persistent authority. */
export function historyReuseActions(deps: HistoryReuseDeps, state: HistoryReuseState) {
  const tools = usePromptHistoryApply(deps)
  function blocked() {
    if (!deps.generationBusy.value && !state.busy.value) return false
    deps.pb.flash('生成或配方载入进行中，完成或停止后再载入配方')
    return true
  }
  async function restore(record: ArtworkRecord, variant: boolean, selection: HistoryReuseSelection, expected: number) {
    state.busy.value = true
    const isCurrent = () => expected === state.revision
    try {
      const applied = await tools.applyHistory(record, variant, selection, isCurrent)
      return isCurrent() && applied
    } catch (error) {
      if (isCurrent()) deps.pb.flash(error instanceof Error ? error.message : '配方载入失败，请重试', 5000, 'warning')
      return false
    } finally { state.busy.value = false }
  }
  async function request(record: ArtworkRecord, variant: boolean, choose: boolean) {
    if (blocked()) return false
    state.request.value = null
    if (!choose) return restore(record, variant, 'full', state.revision)
    const detached = tools.prepareHistoryReuse(record)
    if (!detached) return false
    state.request.value = { record: detached, variant }
    return true
  }
  async function apply(selection: HistoryReuseSelection) {
    const pending = state.request.value, expected = state.revision
    if (!pending || blocked()) return false
    const applied = await restore(pending.record, pending.variant, selection, expected)
    if (expected === state.revision) {
      if (applied) deps.onApplied()
      state.request.value = null
    }
    return applied
  }
  return { request, apply, remove: tools.deleteHistory }
}

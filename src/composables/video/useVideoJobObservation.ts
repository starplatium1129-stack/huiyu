import { computed, onActivated, onDeactivated, onScopeDispose, ref } from 'vue'
import { fetchVideoJob, type VideoJob } from '@/api/videoApi'
import { generationTask } from '@/utils/generationTask'
import type { Ref } from 'vue'

type ReadMode = 'selected' | 'recovery' | 'poll'

/** One display read owns recovery, deep links and the current video's polling. */
export function useVideoJobObservation(options: {
  job: Ref<VideoJob | null>
  selectedId(): string
  available(): boolean
  hasRecovery(): boolean
  check(): void
  recover(signal: AbortSignal): Promise<VideoJob | null>
  update(job: VideoJob): void
  displayed(): void
  selected(): void
}) {
  const mode = ref<ReadMode | null>(null), selectedJobError = ref(''), pollError = ref(''), recoveryError = ref('')
  const reconnectState = ref<'idle' | 'reading' | 'failed'>(options.hasRecovery() && !options.selectedId() ? 'reading' : 'idle')
  let pending: { mode: ReadMode; id: string; controller: AbortController; promise: Promise<boolean> } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined, revision = 0, active = true, disposed = false
  const available = () => !disposed && active && options.available()
  const jobActive = computed(() => generationTask(options.job.value?.status || 'idle').active)
  const jobSelectionPending = computed(() => Boolean(options.selectedId() && options.selectedId() !== options.job.value?.id))
  function stop() {
    revision++; clearTimeout(timer); timer = undefined
    pending?.controller.abort(); pending = undefined; mode.value = null
    if (reconnectState.value === 'reading') reconnectState.value = 'idle'
  }
  function schedule() {
    clearTimeout(timer); timer = undefined
    if (!available() || pending || jobSelectionPending.value || !jobActive.value) return
    timer = setTimeout(() => { void poll() }, 1500)
  }
  function read(selectedMode: ReadMode, id = ''): Promise<boolean> {
    if (!available()) return Promise.resolve(false)
    if (pending?.mode === selectedMode && pending.id === id) return pending.promise
    stop()
    const controller = new AbortController(), expected = revision, selectedId = options.selectedId()
    const current = () => available() && !controller.signal.aborted && expected === revision
      && selectedId === options.selectedId() && (selectedMode !== 'poll' || options.job.value?.id === id)
    mode.value = selectedMode
    if (selectedMode === 'recovery') { reconnectState.value = 'reading'; recoveryError.value = '' }
    else if (selectedMode === 'selected') selectedJobError.value = ''
    const promise = Promise.resolve().then(async () => {
      try {
        if (!current()) return false
        options.check()
        const value = selectedMode === 'recovery' ? await options.recover(controller.signal)
          : (await fetchVideoJob(id, controller.signal)).job
        if (!current()) return false
        options.check()
        if (value) {
          options.update(value)
          // Recovering the original request must not replace another deep-linked clip.
          if (!selectedId || selectedId === value.id) { options.job.value = value; options.displayed() }
        }
        if (selectedMode === 'selected') { selectedJobError.value = ''; options.selected() }
        if (selectedMode === 'recovery') reconnectState.value = 'idle'
        pollError.value = ''
        return true
      } catch (error) {
        if (!current()) return false
        const message = error instanceof Error ? error.message : '原视频状态暂时无法读取'
        if (selectedMode === 'selected') selectedJobError.value = message
        else if (selectedMode === 'recovery') {
          reconnectState.value = options.hasRecovery() ? 'failed' : 'idle'
          recoveryError.value = message
        } else pollError.value = message
        return false
      } finally {
        if (pending?.controller === controller) {
          pending = undefined; mode.value = null; schedule()
        }
      }
    })
    pending = { mode: selectedMode, id, controller, promise }
    return promise
  }
  function select(force = false) {
    const id = options.selectedId()
    // Environment refreshes without a deep link cannot interrupt request recovery.
    if (!id || !force && id === options.job.value?.id) { schedule(); return Promise.resolve(false) }
    return read('selected', id)
  }
  function poll(force = false) {
    if (pending || jobSelectionPending.value || !options.job.value || !force && !jobActive.value) return Promise.resolve(false)
    return read('poll', options.job.value.id)
  }
  async function recover() {
    if (pending?.mode === 'selected') {
      // Original-request lookup must not discard an unfinished deep-link read.
      const expected = revision
      await pending.promise
      if (!available() || expected !== revision) return false
    }
    return read('recovery')
  }
  onDeactivated(() => { active = false; stop() })
  onActivated(() => { active = true })
  onScopeDispose(() => { disposed = true; stop() })
  return { stop, schedule, select, poll, recover, reconnectState, recoveryError, pollError,
    selectedJobError, jobSelectionPending, jobActive, jobReading: computed(() => mode.value === 'poll'),
    selectedJobReading: computed(() => mode.value === 'selected') }
}

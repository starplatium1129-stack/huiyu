import { hasRuntimeTasks } from '@/api/runtimeTaskAuthority'
import { getDesktopRuntime } from '@/platform/desktop/runtime'
import { hostApi } from '@/platform/desktop/hostApi'
import { isNativeDesktopOrigin } from '@/platform/desktopOrigins'
import type { CompanionTaskSnapshot } from '@/utils/companionEvents'

/** Observe accepted results, never media aliases created by imports or staging. */
export function createCompanionTaskReader() {
  let revision: number | undefined
  let snapshot: CompanionTaskSnapshot[] = []
  function reset() { revision = undefined; snapshot = [] }
  const copy = () => snapshot.map(task => ({ ...task }))

  async function read(signal: AbortSignal): Promise<CompanionTaskSnapshot[]> {
    signal.throwIfAborted()
    if (hasRuntimeTasks()) {
      const { readRuntimeTaskPage } = await import('@/api/runtimeTasks')
      // An unchanged workspace needs only one bounded revision probe. Rebuild
      // the overview after changes so its open/recent membership stays authoritative.
      if (revision !== undefined) {
        const changes = await readRuntimeTaskPage('all', { after: revision, limit: 1, signal })
        signal.throwIfAborted()
        if (!changes.items.length) {
          revision = changes.throughRevision
          return copy()
        }
      }
      const tasks: CompanionTaskSnapshot[] = []
      let before: number | undefined, through: number | undefined
      do {
        const page = await readRuntimeTaskPage('overview', { before, through, limit: 100, signal })
        signal.throwIfAborted()
        for (const task of page.items) {
          if (!['generation', 'anima', 'creative', 'qwen', 'manga', 'lineart'].includes(task.kind)) continue
          tasks.push({ id: task.taskId, createdAt: task.createdAt,
            ready: task.status === 'succeeded' && task.upstreamSettled && task.recoveryState === 'normal'
              && task.deliveryState !== 'discarded' && task.resultState === 'available'
              && task.resultRefs.some(media => media.mime.startsWith('image/')) })
        }
        through = page.throughRevision
        before = page.nextCursor ?? undefined
      } while (before !== undefined)
      revision = through
      snapshot = tasks
      return copy()
    }
    if (isNativeDesktopOrigin(location.origin) || hostApi() && getDesktopRuntime().connection !== 'ready')
      throw new Error('任务资料来源尚未确认，请恢复原工作区连接。')
    const { readBrowserTaskRecords } = await import('./useTaskCenter')
    const records = await readBrowserTaskRecords()
    signal.throwIfAborted()
    return records.filter(task => task.kind === 'image' || task.kind === 'batch' && task.route.startsWith('/prompt-builder'))
      .map(task => ({ id: task.id, createdAt: task.createdAt, ready: task.status === 'succeeded' }))
  }
  return { read, reset }
}

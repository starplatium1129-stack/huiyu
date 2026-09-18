import { withArtworkMutation } from './artworkMutation.ts'

/** A document keeps a shared lease before mounting the app. Destructive orphan
 * cleanup requires the only open document, because sessionStorage drafts cannot
 * be inspected across tabs. This lease is separate from the short library lock:
 * normal reads/writes remain concurrent; never acquire these in reverse order.
 */
export const ARTWORK_SESSION_LOCK = 'huiyu-artwork-documents'

export function createArtworkSession(locks: LockManager | undefined) {
  let held: { ready: Promise<void>; done: Promise<unknown>; release: () => void } | null = null
  let tail = Promise.resolve()

  function start(): Promise<void> {
    if (held) return held.ready
    if (!locks) return Promise.reject(new Error('当前环境不支持跨窗口安全清理，请使用本机地址或 HTTPS 并更新浏览器'))
    let enter!: () => void, fail!: (error: unknown) => void, release!: () => void
    const ready = new Promise<void>((resolve, reject) => { enter = resolve; fail = reject })
    const released = new Promise<void>(resolve => { release = resolve })
    const entry = { ready, release, done: Promise.resolve() as Promise<unknown> }
    held = entry
    entry.done = Promise.resolve().then(() => locks.request(ARTWORK_SESSION_LOCK, { mode: 'shared' }, async () => {
      enter()
      await released
    })).catch(error => {
      if (held === entry) held = null
      fail(error)
      throw error
    })
    // Rejection is also observed by start()/stop(); never leak a background rejection.
    void entry.done.catch(() => {})
    return ready
  }

  async function stop(): Promise<void> {
    const entry = held
    if (!entry) return
    entry.release()
    try { await entry.done } finally { if (held === entry) held = null }
  }

  function exclusively<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(async () => {
      await start()
      await stop()
      try {
        return await locks!.request(ARTWORK_SESSION_LOCK, { mode: 'exclusive', ifAvailable: true }, async lock => {
          if (!lock) throw new Error('其他绘遇窗口或图片保存操作仍在使用图库，可能含未入册草稿。请先完成保存并关闭其他窗口，再清理；本次未删除图片')
          return work()
        })
      } finally { await start() }
    })
    tail = result.then(() => undefined, () => undefined)
    return result
  }

  return { start, stop, exclusively }
}

let session: ReturnType<typeof createArtworkSession> | undefined
function current() { return session ??= createArtworkSession(globalThis.navigator?.locks) }
export function startArtworkSession(): Promise<void> { return current().start() }
export function stopArtworkSession(): Promise<void> { return session?.stop() ?? Promise.resolve() }
export function withArtworkCleanup<T>(work: () => Promise<T>): Promise<T> {
  return current().exclusively(() => withArtworkMutation(work))
}

/** Protect the gap between Blob creation and publishing its history/draft ID,
 * including staging in this very document. Unsupported environments cannot run
 * cleanup at all, so temporary result capture may retain its existing fallback.
 */
export async function withArtworkStaging<T>(work: () => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks
  return locks ? locks.request(ARTWORK_SESSION_LOCK, { mode: 'shared' }, work) : work()
}

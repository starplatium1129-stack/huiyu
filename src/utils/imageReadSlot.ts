import { abortableTask } from './abortableTask'

interface ImageRead {
  controller: AbortController
  current(): boolean
  read(): Promise<void>
  finish(error?: unknown): void
}

/** One actual image read; cancelling its observer admits only the latest queued read
 * after the underlying storage/bridge work has really settled. No media is owned here. */
export function createImageReadSlot() {
  let active: ImageRead | null = null, queued: ImageRead | null = null, reading = false
  function stop() {
    const previous = active
    active = null; queued = null
    previous?.controller.abort()
    previous?.finish()
  }
  async function pump() {
    if (reading || !queued) return
    const request = queued
    queued = null
    if (!request.current()) { request.finish(); if (active === request) active = null; return }
    reading = true
    try { await request.read() }
    catch (error) { request.finish(error) }
    finally {
      request.finish()
      if (active === request) active = null
      reading = false
      void pump()
    }
  }
  function read<T>(operation: (signal: AbortSignal) => Promise<T>, owner: {
    signal: AbortSignal; current(): boolean
  }): Promise<T | undefined> {
    stop()
    if (owner.signal.aborted || !owner.current()) return Promise.resolve(undefined)
    const controller = new AbortController()
    const abort = () => controller.abort(owner.signal.reason)
    owner.signal.addEventListener('abort', abort, { once: true })
    let settled = false, result: T | undefined
    const completion = new Promise<T | undefined>((resolve, reject) => {
      const request: ImageRead = {
        controller,
        current: () => active === request && !controller.signal.aborted && owner.current(),
        read: async () => { const value = await operation(controller.signal); if (request.current()) result = value },
        finish: error => {
          if (settled) return
          settled = true
          owner.signal.removeEventListener('abort', abort)
          if (error && request.current()) reject(error)
          else resolve(result)
        },
      }
      active = request; queued = request
    })
    // Stop the caller's wait without releasing the actual read's occupied slot.
    const observed = abortableTask(() => completion, controller.signal).catch(error => {
      if (!controller.signal.aborted) throw error
      return undefined
    })
    void pump()
    return observed
  }
  return { read, stop }
}

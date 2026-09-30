/** Reference reads must finish even when a transport ignores cancellation. */
export const CHARACTER_REFERENCE_READ_TIMEOUT_MS = 15_000

/** Cancelling a subscriber releases only its wait, never the shared producer. */
export function waitForCharacterReference<T>(request: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return request
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('已取消读取', 'AbortError'))
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason ?? new DOMException('已取消读取', 'AbortError')) }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    request.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
  })
}

/** Own the whole read (including response body), its deadline and transport signal. */
export async function readCharacterReference<T>(read: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason)
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(() => controller.abort(new DOMException('参考资料读取超时，请重试', 'TimeoutError')), CHARACTER_REFERENCE_READ_TIMEOUT_MS)
  try {
    controller.signal.throwIfAborted()
    return await waitForCharacterReference(Promise.resolve().then(() => {
      controller.signal.throwIfAborted()
      return read(controller.signal)
    }), controller.signal)
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}

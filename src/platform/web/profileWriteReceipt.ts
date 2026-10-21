export interface ProfileWriteReceipt {
  readonly key: string
  /** Failed means unconfirmed; retry keeps the admitted operation identity. */
  readonly state: 'queued' | 'confirmed' | 'failed'
  readonly error: unknown
  /** Wait only for this write. A later unrelated failure cannot revoke its acknowledgement. */
  confirm(): Promise<void>
}

export function createProfileWriteReceipt(key: string, resume: () => void) {
  let state: ProfileWriteReceipt['state'] = 'queued', error: unknown = null, retired = false
  const waiters = new Set<{ resolve: () => void; reject: (error: unknown) => void }>()
  function block(cause: unknown) { for (const waiter of waiters) waiter.reject(cause); waiters.clear() }
  const receipt: ProfileWriteReceipt = {
    key, get state() { return state }, get error() { return error },
    confirm() {
      if (state === 'confirmed') return Promise.resolve()
      if (retired) return Promise.reject(error)
      return new Promise<void>((resolve, reject) => { waiters.add({ resolve, reject }); resume() })
    },
  }
  return {
    receipt, block,
    queued() { state = 'queued'; error = null },
    confirmed() { state = 'confirmed'; error = null; for (const waiter of waiters) waiter.resolve(); waiters.clear() },
    failed(cause: unknown, final = false) { state = 'failed'; error = cause; retired = final; block(cause) },
  }
}

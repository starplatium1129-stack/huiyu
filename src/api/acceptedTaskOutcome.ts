/** Emitted only after observing a terminal response bound to the accepted job ID. */
export class AcceptedTaskTerminalError extends Error {
  constructor(readonly taskId: string, readonly status: 'failed' | 'cancelled', message: string) {
    super(message)
    this.name = status === 'cancelled' ? 'AbortError' : 'AcceptedTaskTerminalError'
  }
}

/** Definite pre-acceptance rejection, or a durable cancellation fence for this key. */
export class TaskSubmissionRejected extends Error {
  constructor(readonly requestKey: string, message: string, readonly code?: string) {
    super(message)
    this.name = 'TaskSubmissionRejected'
  }
}

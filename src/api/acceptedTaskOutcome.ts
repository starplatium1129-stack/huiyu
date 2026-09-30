/** Emitted only after observing a terminal response bound to the accepted job ID. */
export class AcceptedTaskTerminalError extends Error {
  constructor(readonly taskId: string, readonly status: 'failed' | 'cancelled', message: string) {
    super(message)
    this.name = status === 'cancelled' ? 'AbortError' : 'AcceptedTaskTerminalError'
  }
}

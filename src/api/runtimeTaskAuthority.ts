import { getDesktopRuntime } from '../platform/desktop/runtime.ts'
/** Confirmed ownership survives a temporary disconnect; transport admission is separate. */
let confirmed = false
export function hasRuntimeTasks(): boolean {
  const state = getDesktopRuntime()
  if (state.connection === 'ready') confirmed = Boolean(state.bootstrap?.runtime?.workspace?.domains.includes('artwork'))
  return confirmed
}
export const isRuntimeTaskId = (id: string) => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)

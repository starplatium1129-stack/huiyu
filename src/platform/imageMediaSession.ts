import { desktopRuntimeIdentity, getDesktopRuntime } from './desktop/runtime'
import { runtimeResourceIdentity } from './runtimeUrl'

/** Media admission and reading share the complete session; Web reads remain valid. */
export function imageMediaSession() {
  return JSON.stringify([runtimeResourceIdentity(), getDesktopRuntime().connection, desktopRuntimeIdentity()])
}

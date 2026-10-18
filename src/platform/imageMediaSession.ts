import { getDesktopRuntime } from './desktop/runtime'
import { runtimeResourceIdentity } from './runtimeUrl'

/** Media admission and reading share the complete session; Web reads remain valid. */
export function imageMediaSession() {
  const state = getDesktopRuntime(), runtime = state.bootstrap?.runtime, workspace = runtime?.workspace
  return JSON.stringify([runtimeResourceIdentity(), state.connection, state.bootstrap?.sourceProfileId, runtime?.origin, runtime?.runtimeEpoch,
    workspace?.workspaceId, workspace?.principalId, workspace?.runtimeEpoch, workspace?.generation])
}

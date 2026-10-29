import { hostApi } from './hostApi'
import { getDesktopRuntime } from './runtime'
import type { ProfileDomain } from '../../../types/profile'

const EVENT = 'huiyu:profile-changed'
interface Change { workspaceId: string; windowId: string; generation: number; domain?: ProfileDomain }

/** Invalidation contains identity only; private profile content stays in the runtime. */
export function publishProfileChange(domain?: ProfileDomain): void {
  const bootstrap = getDesktopRuntime().bootstrap, session = bootstrap?.runtime?.workspace
  if (!bootstrap || !session) return
  void hostApi()?.event.emit<Change>(EVENT, {
    workspaceId: session.workspaceId, generation: session.generation, windowId: bootstrap.windowId, domain,
  }).catch(error => console.warn('资料更新通知未送达', error))
}

export async function onProfileChange(refresh: (domains?: ProfileDomain[]) => void): Promise<() => void> {
  return await hostApi()?.event.listen<Change>(EVENT, ({ payload }) => {
    const bootstrap = getDesktopRuntime().bootstrap, session = bootstrap?.runtime?.workspace
    if (payload?.workspaceId === session?.workspaceId && payload?.generation === session?.generation
      && payload?.windowId !== bootstrap?.windowId) refresh(payload.domain ? [payload.domain] : undefined)
  }) ?? (() => {})
}

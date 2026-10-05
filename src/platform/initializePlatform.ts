import { configureArtworkRepository } from '@/storage/artworkRepository'
import { createWebArtworkRepository } from './web/artworkRepository'
import { assertMigrationAuthority } from './web/migrationAuthority'
import { initializeMigrationParticipant, retireWebArtworkWrites } from './web/migrationBarrier'
import { activateProfileStorage, flushProfileWrites, hasPendingProfileWrites, hasProfileRecoveryData, profileRuntimeActive, refreshProfileStorage, setProfileConnectionBlocked } from './web/profileStorage'
import { createProfilePort } from './web/profilePort'
import { workspaceRequest } from '@/api/workspace'
import { createDesktopArtworkRepository } from './desktop/artworkRepository'
import { getDesktopRuntime, initializeDesktopRuntime, onDesktopRuntime, refreshDesktopRuntime } from './desktop/runtime'
import { hostApi } from './desktop/hostApi'
import { isNativeDesktopOrigin } from './desktopOrigins.ts'
import { artworkCleanupFrozen, maintenanceFrozen } from './maintenanceParticipants'

export function isDesktopHost(): boolean {
  return '__TAURI_INTERNALS__' in window || Boolean(hostApi()) || isNativeDesktopOrigin(location.origin)
}
export async function initializePlatform(isBusy: () => boolean): Promise<() => void> {
  let alive = true
  let stopRuntime = () => {}, stopConnection = () => {}, stopMaintenance = () => {}, stopArtworkCleanup = () => {}
  if (isDesktopHost()) {
    setProfileConnectionBlocked(true)
    // While identity is unknown, every artwork call goes to a disconnected
    // desktop adapter. A failed handshake never authorizes writes to old IDB.
    configureArtworkRepository(createDesktopArtworkRepository())
    stopRuntime = await initializeDesktopRuntime()
  }
  const bootstrap = getDesktopRuntime().bootstrap
  try { initializeMigrationParticipant({ windowId: bootstrap?.windowId, isBusy: () => isBusy() || hasPendingProfileWrites() }) }
  catch (error) { console.warn('跨窗口迁移当前不可用', error) }
  if (isDesktopHost()) {
    // Register the window lease before the final startup authority read, so a
    // concurrent migration either awaits this window or precedes its handshake.
    await refreshDesktopRuntime()
    let selected = '', syncing = Promise.resolve(), syncedAuthority = ''
    const authorityKey = () => {
      const bootstrap = getDesktopRuntime().bootstrap, session = bootstrap?.runtime?.workspace
      return JSON.stringify([bootstrap?.sourceProfileId, bootstrap?.sourceOrigin, session?.workspaceId, session?.generation, session?.activeMigrationId, session?.domains])
    }
    const sync = async () => {
      if (maintenanceFrozen()) return
      const state = getDesktopRuntime(), session = state.bootstrap?.runtime?.workspace, authority = authorityKey()
      if (state.connection !== 'ready') { setProfileConnectionBlocked(true); return }
      if (session?.domains.includes('artwork')) {
        if (!selected) { configureArtworkRepository(createDesktopArtworkRepository()); retireWebArtworkWrites() }
        selected = session.workspaceId
      } else if (!selected && !isNativeDesktopOrigin(location.origin)) {
        configureArtworkRepository(createWebArtworkRepository())
      }
      if (session && ['settings', 'chat', 'draft'].every(domain => session.domains.includes(domain as 'settings' | 'chat' | 'draft'))) {
        if (!profileRuntimeActive()) await activateProfileStorage(createProfilePort(workspaceRequest), state.bootstrap!.windowId)
        else { setProfileConnectionBlocked(false); await flushProfileWrites(); await refreshProfileStorage() }
      } else if (!profileRuntimeActive() && !isNativeDesktopOrigin(location.origin)) setProfileConnectionBlocked(false)
      syncedAuthority = authority
      return state
    }
    const failure = () => { setProfileConnectionBlocked(true); window.dispatchEvent(new CustomEvent('huiyu:profile-write-error', { detail: '本机资料尚未连接，请重试连接并保持窗口打开。' })) }
    const initialState = await sync().catch(failure)
    let syncFailure: unknown
    let initialReplay = true
    stopConnection = onDesktopRuntime(state => {
      // Skip only the already-hydrated replay. A publication during hydration
      // replaces the state object, and later same-authority reads still refresh.
      const alreadySynced = initialReplay && state === initialState
      initialReplay = false
      if (alreadySynced) return
      syncing = syncing.then(async () => { syncFailure = undefined; await sync() }).catch(error => { syncFailure = error; failure() })
    })
    initializeMigrationParticipant({ reconcileAuthority: async target => {
      if (!alive || maintenanceFrozen()) throw new Error('资料窗口正在维护或已关闭，请在活动窗口重新核对。')
      await refreshDesktopRuntime()
      assertMigrationAuthority(getDesktopRuntime(), target)
      // The listener queues the existing adapter hydration synchronously on publish.
      await syncing
      if (syncFailure) throw syncFailure
      if (!alive || maintenanceFrozen() || syncedAuthority !== authorityKey()) throw new Error('资料适配器尚未完成激活同步，请稍后重新核对。')
      assertMigrationAuthority(getDesktopRuntime(), target)
    } })
    const { installDesktopMaintenance } = await import('./desktop/maintenance')
    stopMaintenance = installDesktopMaintenance({ isBusy: () => isBusy() || artworkCleanupFrozen(), waitForSync: () => syncing })
    const { installDesktopArtworkCleanup } = await import('./desktop/artworkCleanup')
    stopArtworkCleanup = await installDesktopArtworkCleanup({ isBusy, waitForSync: () => syncing })
  }
  const preventLoss = (event: BeforeUnloadEvent) => {
    if (hasPendingProfileWrites() || hasProfileRecoveryData()) { event.preventDefault(); event.returnValue = '' }
  }
  window.addEventListener('beforeunload', preventLoss)
  return () => { alive = false; stopArtworkCleanup(); stopMaintenance(); stopConnection(); stopRuntime(); window.removeEventListener('beforeunload', preventLoss) }
}

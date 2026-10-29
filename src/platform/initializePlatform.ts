import { configureArtworkRepository } from '@/storage/artworkRepository'
import { createWebArtworkRepository } from './web/artworkRepository'
import { assertMigrationAuthority } from './web/migrationAuthority'
import { hasPendingArtworkSource, initializeMigrationParticipant, retireWebArtworkWrites } from './web/migrationBarrier'
import { activateProfileStorage, hasPendingProfileWrites, hasProfileRecoveryData, profileRuntimeActive, refreshProfileStorage, setProfileConnectionBlocked } from './web/profileStorage'
import { createProfilePort } from './web/profilePort'
import { workspaceRequest } from '@/api/workspace'
import { getDesktopRuntime, initializeDesktopRuntime, onDesktopRuntime, refreshDesktopRuntime } from './desktop/runtime'
import { hostApi } from './desktop/hostApi'
import { onProfileChange } from './desktop/profileChanges'
import type { ProfileDomain } from '../../types/profile'
import { consumeTaskReloadApproval } from '@/composables/useTaskCenter'
import { isNativeDesktopOrigin } from './desktopOrigins.ts'
import { artworkCleanupFrozen, maintenanceFrozen } from './maintenanceParticipants'

export function isDesktopHost(): boolean {
  return '__TAURI_INTERNALS__' in window || Boolean(hostApi()) || isNativeDesktopOrigin(location.origin)
}
export async function initializePlatform(isBusy: () => boolean): Promise<{ stop: () => void; afterMount: () => Promise<void> }> {
  let alive = true
  let stopRuntime = () => {}, stopConnection = () => {}, stopMaintenance = () => {}, stopArtworkCleanup = () => {}
  let stopChanges = () => {}, stopImports = () => {}
  let deferredDesktop: (() => Promise<void>) | undefined
  // Browser startup needs only its own adapter; resolve the native adapter before
  // selecting it so a desktop handshake failure still cannot enable IDB writes.
  const desktopHost = isDesktopHost()
  if (desktopHost) setProfileConnectionBlocked(true)
  const createDesktopArtworkRepository = desktopHost
    ? (await import('./desktop/artworkRepository')).createDesktopArtworkRepository : null
  if (createDesktopArtworkRepository) {
    // While identity is unknown, every artwork call goes to a disconnected
    // desktop adapter. A failed handshake never authorizes writes to old IDB.
    configureArtworkRepository(createDesktopArtworkRepository())
    stopRuntime = await initializeDesktopRuntime()
  }
  const bootstrap = getDesktopRuntime().bootstrap
  try { initializeMigrationParticipant({ windowId: bootstrap?.windowId, isBusy: () => isBusy() || hasPendingProfileWrites() }) }
  catch (error) { console.warn('跨窗口迁移当前不可用', error) }
  if (createDesktopArtworkRepository) {
    // Register the window lease before the final startup authority read, so a
    // concurrent migration either awaits this window or precedes its handshake.
    await refreshDesktopRuntime()
    let selected = '', webSelected = false, syncing = Promise.resolve(), syncedAuthority = '', syncQueued = false
    const authorityKey = () => {
      const bootstrap = getDesktopRuntime().bootstrap, session = bootstrap?.runtime?.workspace
      return JSON.stringify([bootstrap?.sourceProfileId, bootstrap?.sourceOrigin, session?.workspaceId, session?.generation, session?.activeMigrationId, session?.domains])
    }
    const sync = async (domains: ProfileDomain[]) => {
      if (!alive || maintenanceFrozen()) return
      const state = getDesktopRuntime(), session = state.bootstrap?.runtime?.workspace, authority = authorityKey()
      if (state.connection !== 'ready') { setProfileConnectionBlocked(true); return }
      if (session?.domains.includes('artwork')) {
        if (!selected) { configureArtworkRepository(createDesktopArtworkRepository()); retireWebArtworkWrites() }
        selected = session.workspaceId
      } else if (!selected && !webSelected && !isNativeDesktopOrigin(location.origin)) {
        configureArtworkRepository(createWebArtworkRepository())
        webSelected = true
      }
      if (session && ['settings', 'chat', 'draft'].every(domain => session.domains.includes(domain as 'settings' | 'chat' | 'draft'))) {
        if (!profileRuntimeActive()) await activateProfileStorage(createProfilePort(workspaceRequest), state.bootstrap!.windowId)
        else { setProfileConnectionBlocked(false); await refreshProfileStorage(syncedAuthority === authority ? domains : undefined) }
        if (alive) window.dispatchEvent(new Event('huiyu:profile-sync-complete'))
      } else if (!profileRuntimeActive() && !isNativeDesktopOrigin(location.origin)) setProfileConnectionBlocked(false)
      syncedAuthority = authority
      return state
    }
    const failure = () => { setProfileConnectionBlocked(true); window.dispatchEvent(new CustomEvent('huiyu:profile-write-error', { detail: '本机资料尚未连接，请重试连接并保持窗口打开。' })) }
    let syncFailure: unknown
    const pendingDomains = new Set<ProfileDomain>()
    const queueSync = (domains: ProfileDomain[] = ['settings', 'chat', 'draft']) => {
      if (!alive) return
      for (const domain of domains) pendingDomains.add(domain)
      if (syncQueued) return
      syncQueued = true
      syncing = syncing.then(async () => {
        const domains = [...pendingDomains]; pendingDomains.clear()
        syncQueued = false; syncFailure = undefined; await sync(domains)
      }).catch(error => { syncFailure = error; failure() })
    }
    stopChanges = await onProfileChange(queueSync)
    queueSync()
    await syncing
    let connected = getDesktopRuntime().connection === 'ready'
    stopConnection = onDesktopRuntime(state => {
      if (state.connection !== 'ready') { connected = false; setProfileConnectionBlocked(true); return }
      // Token renewal changes the transport credentials, not profile content.
      if (!connected || syncedAuthority !== authorityKey()) queueSync()
      connected = true
    })
    initializeMigrationParticipant({ reconcileAuthority: async target => {
      if (!alive || maintenanceFrozen()) throw new Error('资料窗口正在维护或已关闭，请在活动窗口重新核对。')
      await refreshDesktopRuntime()
      assertMigrationAuthority(getDesktopRuntime(), target)
      queueSync()
      await syncing
      if (syncFailure) throw syncFailure
      if (!alive || maintenanceFrozen() || syncedAuthority !== authorityKey()) throw new Error('资料适配器尚未完成激活同步，请稍后重新核对。')
      assertMigrationAuthority(getDesktopRuntime(), target)
    } })
    deferredDesktop = async () => {
      const [{ installDesktopMaintenance }, { installDesktopArtworkCleanup }] = await Promise.all([
        import('./desktop/maintenance'), import('./desktop/artworkCleanup'),
      ])
      if (!alive) return
      stopMaintenance = installDesktopMaintenance({ isBusy: () => isBusy() || artworkCleanupFrozen(), waitForSync: () => syncing })
      const stop = await installDesktopArtworkCleanup({ isBusy, waitForSync: () => syncing })
      if (alive) stopArtworkCleanup = stop
      else stop()
    }
  }
  const preventLoss = (event: BeforeUnloadEvent) => {
    const approved = consumeTaskReloadApproval(event)
    if (hasPendingProfileWrites() || hasProfileRecoveryData() || hasPendingArtworkSource() && !approved) { event.preventDefault(); event.returnValue = '' }
  }
  window.addEventListener('beforeunload', preventLoss)
  return {
    afterMount: async () => {
      await Promise.all([
        deferredDesktop?.(),
        import('../utils/desktopImport').then(({ initializeLocalImageImports }) => { if (alive) stopImports = initializeLocalImageImports() }),
      ])
    },
    stop: () => { alive = false; stopImports(); stopArtworkCleanup(); stopMaintenance(); stopChanges(); stopConnection(); stopRuntime(); window.removeEventListener('beforeunload', preventLoss) },
  }
}

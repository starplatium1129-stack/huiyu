import { configureArtworkRepository } from '@/storage/artworkRepository'
import { createWebArtworkRepository } from './web/artworkRepository'
import { initializeMigrationParticipant, retireWebArtworkWrites } from './web/migrationBarrier'
import { activateProfileStorage, flushProfileWrites, hasPendingProfileWrites, hasProfileRecoveryData, profileRuntimeActive, refreshProfileStorage, setProfileConnectionBlocked } from './web/profileStorage'
import { createProfilePort } from './web/profilePort'
import { workspaceRequest } from '@/api/workspace'
import { createDesktopArtworkRepository } from './desktop/artworkRepository'
import { getDesktopRuntime, initializeDesktopRuntime, onDesktopRuntime } from './desktop/runtime'
import { hostApi } from './desktop/hostApi'
import { isNativeDesktopOrigin } from '../../services/desktopOrigins.ts'

export function isDesktopHost(): boolean {
  return '__TAURI_INTERNALS__' in window || Boolean(hostApi()) || isNativeDesktopOrigin(location.origin)
}
export async function initializePlatform(isBusy: () => boolean): Promise<() => void> {
  let stopRuntime = () => {}, stopConnection = () => {}
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
    let selected = '', syncing = Promise.resolve()
    const sync = async () => {
      const state = getDesktopRuntime(), session = state.bootstrap?.runtime?.workspace
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
    }
    const failure = () => { setProfileConnectionBlocked(true); window.dispatchEvent(new CustomEvent('huiyu:profile-write-error', { detail: '本机资料尚未连接，请重试连接并保持窗口打开。' })) }
    await sync().catch(failure)
    stopConnection = onDesktopRuntime(() => { syncing = syncing.then(sync).catch(failure) })
  }
  const preventLoss = (event: BeforeUnloadEvent) => {
    if (hasPendingProfileWrites() || hasProfileRecoveryData()) { event.preventDefault(); event.returnValue = '' }
  }
  window.addEventListener('beforeunload', preventLoss)
  return () => { stopConnection(); stopRuntime(); window.removeEventListener('beforeunload', preventLoss) }
}

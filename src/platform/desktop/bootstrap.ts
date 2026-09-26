import type { DesktopBootstrap, DesktopWorkspaceSession } from '../../../types/desktop-bootstrap.ts'

// Use the host's existing withGlobalTauri API. It is private to this adapter;
// application callers receive only named capabilities, never a generic invoke.
interface TauriHost {
  core: { invoke(command: string, args?: Record<string, unknown>): Promise<unknown> }
}

function invoke(command: 'desktop_bootstrap' | 'desktop_workspace_prepare' | 'desktop_workspace_activate' | 'desktop_workspace_enable_bundled' | 'window_zoom_get' | 'window_zoom_set', args?: Record<string, unknown>) {
  const host = (window as Window & { __TAURI__?: TauriHost }).__TAURI__
  if (!host?.core?.invoke) return Promise.reject(new Error('桌面连接不可用'))
  return host.core.invoke(command, args)
}

export function decodeDesktopBootstrap(value: unknown): DesktopBootstrap {
  if (!value || typeof value !== 'object') throw new Error('桌面启动响应无效')
  const dto = value as Record<string, unknown>
  if (dto.protocolVersion !== 1) throw new Error('桌面启动协议不兼容')
  if (dto.windowRole !== 'atelier' && dto.windowRole !== 'companion' && dto.windowRole !== 'companion-chat') {
    throw new Error('桌面窗口未获授权')
  }
  if (dto.windowId !== dto.windowRole || typeof dto.sourceProfileId !== 'string' || !/^profile-[a-f0-9]{64}$/.test(dto.sourceProfileId)
    || typeof dto.sourceOrigin !== 'string' || dto.sourceOrigin !== window.location.origin) throw new Error('桌面来源身份无效')
  if (typeof dto.bundledUiAvailable !== 'boolean') throw new Error('桌面发布状态无效')
  const identity = { windowId: dto.windowId as string, sourceProfileId: dto.sourceProfileId, sourceOrigin: dto.sourceOrigin, bundledUiAvailable: dto.bundledUiAvailable }
  if (dto.connection === 'unavailable' && dto.runtime === null) {
    return { protocolVersion: 1, ...identity, windowRole: dto.windowRole, connection: 'unavailable', runtime: null }
  }
  if (dto.connection !== 'ready' || !dto.runtime || typeof dto.runtime !== 'object') {
    throw new Error('桌面连接状态无效')
  }
  const runtime = dto.runtime as Record<string, unknown>
  if (runtime.protocolVersion !== 1 || (runtime.ownership !== 'managed' && runtime.ownership !== 'attached')) {
    throw new Error('桌面运行时协议不兼容')
  }
  const nativeOrigin = ['http://tauri.localhost', 'https://tauri.localhost', 'tauri://localhost'].includes(window.location.origin)
  if (typeof runtime.origin !== 'string' || (!nativeOrigin && runtime.origin !== window.location.origin)) {
    throw new Error('桌面运行时来源不匹配')
  }
  const origin = new URL(runtime.origin)
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.origin !== runtime.origin) {
    throw new Error('桌面运行时来源无效')
  }
  if (typeof runtime.runtimeEpoch !== 'string' || !runtime.runtimeEpoch) throw new Error('桌面运行时代际无效')
  let workspace: DesktopWorkspaceSession | null = null
  if (runtime.workspace !== null) {
    if (!runtime.workspace || typeof runtime.workspace !== 'object') throw new Error('工作区会话无效')
    const session = runtime.workspace as Record<string, unknown>
    if (typeof session.workspaceId !== 'string' || typeof session.runtimeEpoch !== 'string'
      || typeof session.principalId !== 'string' || typeof session.token !== 'string' || !/^[\w-]{43}$/.test(session.token)
      || typeof session.expiresAt !== 'number' || session.expiresAt <= Date.now() || !Array.isArray(session.domains)
      || session.domains.some(domain => !['artwork', 'settings', 'chat', 'draft'].includes(String(domain)))
      || !Number.isSafeInteger(session.generation) || typeof session.bundledUi !== 'boolean') throw new Error('工作区会话无效')
    workspace = session as unknown as NonNullable<typeof workspace>
  }
  return {
    protocolVersion: 1, ...identity, windowRole: dto.windowRole, connection: 'ready',
    runtime: { origin: runtime.origin, protocolVersion: 1, ownership: runtime.ownership, runtimeEpoch: runtime.runtimeEpoch, workspace },
  }
}

export async function prepareDesktopWorkspace(): Promise<DesktopBootstrap> {
  return decodeDesktopBootstrap(await invoke('desktop_workspace_prepare'))
}
export async function activateDesktopWorkspace(migrationId: string, bundledUi = false): Promise<DesktopBootstrap> {
  return decodeDesktopBootstrap(await invoke('desktop_workspace_activate', { migrationId, bundledUi }))
}
export async function enableDesktopBundledUi(): Promise<DesktopBootstrap> {
  return decodeDesktopBootstrap(await invoke('desktop_workspace_enable_bundled'))
}

export async function readDesktopBootstrap(): Promise<DesktopBootstrap> {
  return decodeDesktopBootstrap(await invoke('desktop_bootstrap'))
}

function decodeZoom(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < .75 || value > 2) {
    throw new Error('桌面缩放响应无效')
  }
  return value
}

export const desktopWindowZoom = {
  async getWindowZoom() { return decodeZoom(await invoke('window_zoom_get')) },
  async setWindowZoom(value: number) { return decodeZoom(await invoke('window_zoom_set', { value })) },
}

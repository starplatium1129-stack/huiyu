import type { DesktopBootstrap } from '../../../types/desktop-bootstrap'

// Use the host's existing withGlobalTauri API. It is private to this adapter;
// application callers receive only named capabilities, never a generic invoke.
interface TauriHost {
  core: { invoke(command: string, args?: Record<string, unknown>): Promise<unknown> }
}

function invoke(command: 'desktop_bootstrap' | 'window_zoom_get' | 'window_zoom_set', args?: Record<string, unknown>) {
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
  if (dto.connection === 'unavailable' && dto.runtime === null) {
    return { protocolVersion: 1, windowRole: dto.windowRole, connection: 'unavailable', runtime: null }
  }
  if (dto.connection !== 'ready' || !dto.runtime || typeof dto.runtime !== 'object') {
    throw new Error('桌面连接状态无效')
  }
  const runtime = dto.runtime as Record<string, unknown>
  if (runtime.protocolVersion !== 1 || (runtime.ownership !== 'managed' && runtime.ownership !== 'attached')) {
    throw new Error('桌面运行时协议不兼容')
  }
  // R1 keeps the existing page origin. A later origin switch requires R8/R9.
  if (typeof runtime.origin !== 'string' || runtime.origin !== window.location.origin) {
    throw new Error('桌面运行时来源不匹配')
  }
  const origin = new URL(runtime.origin)
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.origin !== runtime.origin) {
    throw new Error('桌面运行时来源无效')
  }
  return {
    protocolVersion: 1, windowRole: dto.windowRole, connection: 'ready',
    runtime: { origin: runtime.origin, protocolVersion: 1, ownership: runtime.ownership },
  }
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

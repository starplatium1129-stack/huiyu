/** Host-owned bootstrap. Session credentials live in memory only. */
export interface DesktopWorkspaceSession {
  workspaceId: string
  runtimeEpoch: string
  principalId: string
  token: string
  expiresAt: number
  domains: Array<'artwork' | 'settings' | 'chat' | 'draft'>
  generation: number
  bundledUi: boolean
}
export interface DesktopRuntimeDescriptor {
  origin: string
  protocolVersion: 1
  ownership: 'managed' | 'attached'
  runtimeEpoch: string
  workspace: DesktopWorkspaceSession | null
}

export interface DesktopBootstrap {
  protocolVersion: 1
  windowRole: 'atelier' | 'companion' | 'companion-chat'
  windowId: string
  sourceProfileId: string
  sourceOrigin: string
  bundledUiAvailable: boolean
  connection: 'ready' | 'unavailable'
  runtime: DesktopRuntimeDescriptor | null
}

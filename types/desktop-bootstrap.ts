/** R1 wire contract: identifies the proven gateway, never grants workspace access. */
export interface DesktopRuntimeDescriptor {
  origin: string
  protocolVersion: 1
  ownership: 'managed' | 'attached'
}

export interface DesktopBootstrap {
  protocolVersion: 1
  windowRole: 'atelier' | 'companion' | 'companion-chat'
  connection: 'ready' | 'unavailable'
  runtime: DesktopRuntimeDescriptor | null
}

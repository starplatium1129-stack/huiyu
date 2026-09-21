export interface DesktopFile {
  name: string
  path: string
  size: number
  type: string
}

export interface CompanionDesktopBridge {
  readChatCredential?(endpoint: string): Promise<string | null>
  writeChatCredential?(endpoint: string, secret: string): Promise<void>
  readonly isDesktop: true
  startDragging?(): Promise<void>
  hide(): void
  quit(): void
  openAtelier(pathname?: string): void
  openChat(): Promise<unknown>
  toggleChat(): Promise<unknown>
  hideChatWindow(): Promise<unknown>
  setChatDocked?(docked: boolean): Promise<boolean>
  getChatDocked?(): Promise<boolean>
  chatRelay(payload: Record<string, unknown>): Promise<unknown>
  onChatCommand(listener: (payload: { command: string; text?: string; imageUrl?: string; character?: string }) => void): number
  offChatCommand(subscriptionId: number): void
  setIgnoreMouseEvents(ignore: boolean): void
  setLive2dEnabled(enabled: boolean): void
  getState(): Promise<{
    alwaysOnTop: boolean
    ignoreMouseEvents: boolean
    visible: boolean
    onBatteryPower: boolean
    live2dEnabled: boolean | null
    bounds?: { x: number; y: number; width: number; height: number }
  }>
  toggleAlwaysOnTop(): Promise<boolean>
  getSettings(): Promise<{ openAtLogin: boolean }>
  isPackaged(): Promise<boolean>
  setAutostart(enabled: boolean): Promise<boolean>
  pickFiles(): Promise<DesktopFile[]>
  saveImage(payload: { data: Uint8Array; name?: string }): Promise<{ saved: boolean; filePath?: string; error?: string }>
  openWorkspace(): Promise<boolean>
  openRuntime(): Promise<boolean>
  openLog(): Promise<boolean>
  getWorkspace(): Promise<{ root: string; exists: boolean }>
  setWorkspace(root: string): Promise<{ root: string }>
  notify(title: string, body: string): void
  setProgress(progress: number | null): void
  runTool(name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<{ ok: boolean; output: string; imageDataUrl?: string }>
  onFileDrop(listener: (files: DesktopFile[]) => void): number
  offFileDrop(subscriptionId: number): void
  onResume(listener: () => void): number
  offResume(subscriptionId: number): void
  onShown(listener: () => void): number
  offShown(subscriptionId: number): void
  onVisibilityChanged(listener: (visible: boolean) => void): number
  offVisibilityChanged(subscriptionId: number): void
  onWindowBoundsChanged?(listener: (bounds: { x: number; y: number; width: number; height: number }) => void): number
  offWindowBoundsChanged?(subscriptionId: number): void
  onPowerModeChanged(listener: (onBatteryPower: boolean) => void): number
  offPowerModeChanged(subscriptionId: number): void
  onInteractionModeChanged(listener: (ignoreMouseEvents: boolean) => void): number
  offInteractionModeChanged(subscriptionId: number): void
  onClipboardImage(listener: (png: Uint8Array) => void): number
  offClipboardImage(subscriptionId: number): void
  onClipboardText(listener: (text: string) => void): number
  offClipboardText(subscriptionId: number): void
  onGlobalMouse(listener: (state: { x: number; y: number; inWindow: boolean; bounds: { x: number; y: number; width: number; height: number } }) => void): number
  offGlobalMouse(subscriptionId: number): void
  minimizeWindow(): void
  toggleMaximizeWindow(): void
  closeWindow(): void
  getWindowState(): Promise<{ maximized: boolean; focused: boolean }>
  /** Available in desktop builds with controlled native page zoom; Companion rejects it. */
  getWindowZoom?(): Promise<number>
  setWindowZoom?(value: number): Promise<number>
  onMaximizedChanged(listener: (maximized: boolean) => void): number
  offMaximizedChanged(subscriptionId: number): void
}

declare global {
  interface Window {
    companionDesktop?: CompanionDesktopBridge
  }
}

export {}

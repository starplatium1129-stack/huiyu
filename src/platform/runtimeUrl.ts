import { shallowRef } from 'vue'
import type { FetchImplementation } from '../api/client.ts'
import { isNativeDesktopOrigin } from '../../services/desktopOrigins.ts'
import { remapCharacterArt } from './characterArtState.ts'
const runtimeOrigin = shallowRef<string | null>(null)
const resourceIdentity = shallowRef('')
let desktopMode = false
let transport: FetchImplementation | null = null

export function setRuntimeOrigin(origin: string | null, desktop = false, epoch = ''): void {
  runtimeOrigin.value = origin; desktopMode = desktop
  resourceIdentity.value = `${desktop}:${origin ?? ''}:${epoch}`
}
export function runtimeResourceIdentity(): string { return resourceIdentity.value }
export function setRuntimeFetch(fetcher: FetchImplementation): void { transport = fetcher }
export function runtimeResourceCors(): 'anonymous' | undefined { return desktopMode ? 'anonymous' : undefined }

/** Explicit application-resource fetch; it does not replace the browser global. */
export const runtimeFetch: FetchImplementation = (input, init) => {
  if (!desktopMode || /^(blob:|data:)/.test(String(input))) return globalThis.fetch(input, init)
  if (!transport) return Promise.reject(new Error('本地服务尚未连接'))
  return transport(input, init)
}

/** Resolves known application resources, never an arbitrary upstream download. */
export function resolveRuntimeUrl(value: string | null | undefined): string {
  if (!value) return ''
  if (/^(blob:|data:)/.test(value)) return value
  value = remapCharacterArt(value)
  if (!desktopMode) return value
  if ((import.meta as ImportMeta & { env?: { MODE?: string } }).env?.MODE === 'desktop' && (value.startsWith('./_app/') || value.startsWith('/_app/')
    || ['/assets/favicon.svg', '/assets/logo.svg', '/assets/logo-light.svg'].includes(value))) return value
  // The document remains renderable while disconnected. Resource owners already
  // display their unavailable/placeholder state and reactive URLs refresh on reconnect.
  if (!runtimeOrigin.value) return ''
  const base = runtimeOrigin.value
  const url = new URL(value, base)
  if (typeof location !== 'undefined' && url.origin === location.origin
    && isNativeDesktopOrigin(location.origin)) {
    if (url.pathname.startsWith('/_app/')) return url.href
    return new URL(url.pathname + url.search + url.hash, base).href
  }
  if (url.username || url.password || !['http:', 'https:'].includes(url.protocol) || url.origin !== base) return ''
  return url.href
}

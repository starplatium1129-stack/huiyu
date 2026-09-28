import { apiClient } from './client.ts'
import { adoptCharacterArtManifest, characterArtManifest, type CharacterArtEntry, type CharacterArtManifest } from '../platform/characterArtState.ts'
import { isLocalStudioHost } from '../utils/runtimeEnvironment.ts'
import { runtimeResourceIdentity } from '../platform/runtimeUrl.ts'

export const CHARACTER_ART_CHANNEL = 'huiyu-character-art'
export type CharacterArtSavePayload = { baseVersion: string; id: string; image?: string; reset?: true }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
export function parseCharacterArtManifest(value: unknown): CharacterArtManifest {
  if (!object(value) || value.ok !== true || typeof value.version !== 'string' || !object(value.entries)) throw new Error('角色立绘清单格式无效')
  const entries: Record<string, CharacterArtEntry> = {}
  for (const [id, raw] of Object.entries(value.entries)) {
    if (!/^[a-z0-9_-]+$/.test(id) || !object(raw) || typeof raw.revision !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(raw.revision)
      || !Number.isInteger(raw.width) || !Number.isInteger(raw.height) || Number(raw.width) <= 0 || Number(raw.height) <= 0
      || typeof raw.hasTransparency !== 'boolean') throw new Error('角色立绘记录格式无效')
    const base = `/api/character-art/${id}/${raw.revision}/`
    if (raw.portraitUrl !== `${base}portrait.png` || raw.thumbnailUrl !== `${base}thumbnail.png` || raw.particleUrl !== `${base}particles.json`) throw new Error('角色立绘资源地址无效')
    entries[id] = { revision: raw.revision, portraitUrl: raw.portraitUrl, thumbnailUrl: raw.thumbnailUrl, particleUrl: raw.particleUrl,
      width: Number(raw.width), height: Number(raw.height), hasTransparency: raw.hasTransparency,
      ...(typeof raw.sourceSha256 === 'string' ? { sourceSha256: raw.sourceSha256 } : {}) }
  }
  return { version: value.version, entries }
}
let sequence = 0
let writeSequence = 0
async function request(body?: CharacterArtSavePayload, signal?: AbortSignal): Promise<CharacterArtManifest> {
  if (!isLocalStudioHost()) throw new Error('角色立绘维护仅限本机使用')
  const token = ++sequence
  const writeToken = body ? ++writeSequence : writeSequence
  const identity = runtimeResourceIdentity()
  const response = await apiClient.request('/api/maintenance/character-art', {
    method: body ? 'POST' : 'GET', ...(body ? { body } : {}), signal,
    cache: 'no-store', cachePolicy: 'bypass', timeoutMs: body ? 120_000 : 10_000,
  })
  const value = parseCharacterArtManifest(response)
  if (!signal?.aborted && identity === runtimeResourceIdentity() && (body ? writeToken === writeSequence : token === sequence)) {
    if (body && token !== sequence && characterArtManifest.value.version !== body.baseVersion
      && characterArtManifest.value.version !== value.version) {
      // A focus/cross-window read may already have observed a later writer.
      // Re-read after our acknowledgement instead of restoring an older image.
      try { return await request(undefined, signal) } catch { return value }
    }
    if (body) sequence++
    adoptCharacterArtManifest(value)
  }
  if (body && typeof BroadcastChannel !== 'undefined') {
    let channel: BroadcastChannel | undefined
    try {
      channel = new BroadcastChannel(CHARACTER_ART_CHANNEL)
      channel.postMessage({ changed: true })
    } catch { /* Some desktop origins disable channels; focus refresh remains available. */ }
    finally { channel?.close() }
  }
  return value
}
export const characterArtApi = {
  get: (options: { signal?: AbortSignal } = {}) => request(undefined, options.signal),
  save: (body: CharacterArtSavePayload, options: { signal?: AbortSignal } = {}) => request(body, options.signal),
}

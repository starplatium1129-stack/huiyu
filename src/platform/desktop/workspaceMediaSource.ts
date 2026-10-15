import { desktopRuntimeFetch, getDesktopRuntime } from './runtime.ts'

interface MediaIdentity { alias: string; sha256: string; bytes: number; mime: string }
export interface MediaSource extends MediaIdentity { authority: string }
const sources = new WeakMap<Blob, Readonly<MediaSource>>()

export function workspaceMediaAuthority(): string {
  const state = getDesktopRuntime(), runtime = state.bootstrap?.runtime, workspace = runtime?.workspace
  if (state.connection !== 'ready' || !runtime?.origin || !workspace?.workspaceId || !workspace.principalId) {
    throw new Error('本机工作区尚未连接，请重新读取原图')
  }
  return JSON.stringify([runtime.origin, runtime.runtimeEpoch, workspace.workspaceId,
    workspace.principalId, workspace.runtimeEpoch, workspace.generation])
}

export function assertWorkspaceMediaAuthority(authority: string): void {
  if (workspaceMediaAuthority() !== authority) throw new Error('原图的工作区连接已变化，请重新读取原图')
}

/** Register only a completed read or committed upload whose bytes are proven.
 * Blob identity is immutable; a history id, URL or matching size is not proof. */
export function rememberWorkspaceMedia(blob: Blob, media: MediaIdentity, authority: string): void {
  assertWorkspaceMediaAuthority(authority)
  if (!media.alias || !/^[a-f0-9]{64}$/.test(media.sha256) || !Number.isSafeInteger(media.bytes)
    || media.bytes <= 0 || blob.size !== media.bytes || blob.type !== media.mime) {
    throw new Error('原图来源信息不完整，请重新读取原图')
  }
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(media.mime)) return
  sources.set(blob, { ...media, authority })
}

export function workspaceMediaSource(blob: Blob): Readonly<MediaSource> | undefined {
  const source = sources.get(blob)
  if (!source) return undefined
  assertWorkspaceMediaAuthority(source.authority)
  return { ...source }
}

/** Resolve an explicit repository alias without downloading its original bytes. */
export async function readWorkspaceMediaSource(alias: string, authority: string, signal: AbortSignal): Promise<Readonly<MediaSource>> {
  assertWorkspaceMediaAuthority(authority)
  const response = await desktopRuntimeFetch(`/api/workspace/media/${encodeURIComponent(alias)}/content`, {
    method: 'HEAD', cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)]),
  })
  signal.throwIfAborted()
  assertWorkspaceMediaAuthority(authority)
  if (!response.ok) throw new Error('参考图片暂时无法读取，请重新发送')
  const sha256 = response.headers.get('X-Workspace-Media-Sha256') || ''
  const bytes = Number(response.headers.get('X-Workspace-Media-Total-Bytes'))
  const mime = response.headers.get('X-Workspace-Media-Mime') || ''
  if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(bytes) || bytes <= 0
    || response.headers.get('X-Workspace-Media-Offset') !== '0') throw new Error('参考图片来源信息不完整')
  if (bytes > 20 * 1024 * 1024) throw new Error('图片超过 20 MB，请缩小后重试。')
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) throw new Error('参考图片格式不支持，请重新发送')
  return Object.freeze({ alias, sha256, bytes, mime, authority })
}

import { desktopRuntimeFetch } from './runtime'
import { assertWorkspaceMediaAuthority, type MediaSource } from './workspaceMediaSource'

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

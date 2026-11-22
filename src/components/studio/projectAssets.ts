import { runtimeFetch, resolveRuntimeUrl } from '@/platform/runtimeUrl'
import { characterArtEntry } from '@/platform/characterArtState'
import { artworkRepository } from '@/storage/artworkRepository'
import { useSceneStore } from '@/stores/sceneStore'
import { parseCharacterProfiles, isPopularPortraitPending } from '@/utils/characterProfiles'
import { popularPortraitFullSrc } from '@/utils/popularPortraitSource'
import { safeImageUrl } from '@/composables/gallery/galleryHelpers'
import type {
  StudioAssetImport,
  StudioAssetKind,
  StudioAssetVersion,
  StudioProjectSnapshot,
} from '@/storage/studioProjectRepository'

export const assetLabels: Record<StudioAssetKind, string> = {
  character: '角色立绘',
  outfit: '衣装差分',
  scene: '场景空镜',
  expression: '表情差分',
  pose: '动作差分',
  keyframe: '镜头关键帧',
  audio: '配音',
  clip: '视频片段',
}
export const assetKinds = Object.entries(assetLabels).map(([value, label]) => ({ value, label }))
export const imageAccept = 'image/png,image/jpeg,image/webp'
export const frameDragType = 'application/x-huiyu-asset-version'
export function imageVersion(version?: StudioAssetVersion): boolean {
  return !!version && version.mime.startsWith('image/')
}
export function referenceIssue(version?: StudioAssetVersion): string {
  if (!version || !imageVersion(version)) return '请选择素材库里的图片版本。'
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(version.mime))
    return '这张原图可以绑定到分镜。用于生成时，请将原图另存为 PNG、JPEG 或 WebP 并导入。'
  if (version.bytes > 16 * 1024 * 1024) return '请将参考图缩小到 16 MiB 以内后再导入。'
  return ''
}
export function versionLabel(data: StudioProjectSnapshot, id: string): string {
  const version = data.versions.find((item) => item.id === id)
  const asset = data.assets.find((item) => item.id === version?.assetId)
  return version && asset ? `${asset.title} · v${version.number}` : '素材版本读取失败'
}
async function localImage(path: string, signal: AbortSignal): Promise<Blob> {
  const resolved = resolveRuntimeUrl(path)
  if (!resolved) throw new Error('当前原图地址无法读取')
  const response = await runtimeFetch(resolved, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) })
  if (!response.ok) throw new Error(`原图读取失败（${response.status}）`)
  return response.blob()
}
export async function catalogPortrait(id: string, signal: AbortSignal): Promise<StudioAssetImport> {
  const store = useSceneStore()
  await store.loadCharacterShell()
  signal.throwIfAborted()
  const profile = parseCharacterProfiles(store.characters).find((item) => item.id === id)
  if (!profile || (profile.type === 'popular' && isPopularPortraitPending(profile.id)))
    throw new Error('这个角色的立绘尚未就绪')
  const path =
    profile.type === 'popular'
      ? popularPortraitFullSrc(id)
      : characterArtEntry(id)?.portraitUrl || profile.portrait?.image
  if (!path || path.includes('portrait-pending.svg')) throw new Error('角色档案缺少原始立绘')
  return {
    title: profile.name,
    kind: 'character',
    blob: await localImage(path, signal),
    source: { kind: 'catalog', catalogKind: 'character', catalogId: id },
  }
}
export async function galleryOriginal(
  id: string | number,
  kind: StudioAssetKind,
  signal: AbortSignal
): Promise<StudioAssetImport> {
  const repository = artworkRepository
  const work = await repository.readArtwork(id, signal)
  if (!work) throw new Error('这幅作品已移走，或属于另一个作品库')
  const base = {
    title: work.sceneTitle || work.subject || work.scene || '作品原图',
    kind,
    source: { kind: 'artwork' as const, artworkId: work.id },
  }
  if (work.image_id) return { ...base, mediaAlias: work.image_id }
  const fallback = safeImageUrl(work.image_url) || (work.image_data?.startsWith('data:image/') ? work.image_data : '')
  if (!fallback) throw new Error('旧作品记录里找不到原图，可在素材库选取本地原图')
  return { ...base, blob: await localImage(fallback, signal) }
}

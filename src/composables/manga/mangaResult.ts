import { artworkRepository } from '@/storage/artworkRepository'
import { imageMediaSession } from '@/platform/imageMediaSession'
import { getDesktopCapabilities } from '@/platform/desktop/capabilities'
import { downloadBlob } from '@/utils/downloadBlob'
import type { ArtworkRecord } from '@/types/artwork'
/** Imported previews have no task; retain their upload identity on save retries. */
export function mangaLineResult(blob: Blob, details: {id:string; width:number; height:number; metadata:Record<string, unknown>; name?:string}, checkInput: () => void, source?: ArtworkRecord) {
  const repository = artworkRepository, authority = imageMediaSession()
  const record: ArtworkRecord = {
    id: `manga-lineart-${details.id}`, timestamp: Date.now(), engine: 'manga-screen', provider: 'local', artifactKind: 'lineart',
    sceneTitle: `${source?.sceneTitle || details.name || '图片'} · 线稿`, parent_id: source?.id ?? null,
    character: source?.character ?? '', characterId: source?.characterId, subject: source?.subject,
    outfitId: source?.outfitId, blueprintId: source?.blueprintId, project: source?.project ?? '',
    width: details.width, height: details.height,
    size: `${details.width} × ${details.height}`, image_url: '', favorite: false, version: 1,
    prompt: '', manual_tags: ['线稿'], postprocess: structuredClone(details.metadata), validation: '待主力机验证',
  }
  let imageId = '', saving: Promise<ArtworkRecord> | null = null
  const check = () => {
    checkInput()
    if (repository !== artworkRepository || authority !== imageMediaSession()) throw new Error('作品库连接已变化，请回到原工作区保存；也可导出 PNG')
  }
  async function save(): Promise<ArtworkRecord> {
    if (saving) return saving
    check()
    saving = repository.withStaging(async () => {
      check()
      const previous = await repository.readArtwork(record.id)
      check()
      if (previous) {
        if (!imageId || previous.image_id !== imageId) throw new Error('作品编号已占用，请核对作品册')
        return structuredClone(previous)
      }
      if (!imageId) { imageId = await repository.putImage(blob); check() }
      const saved = structuredClone({ ...record, image_id: imageId })
      // Do not remove uploaded bytes on an unknown commit; retries reuse this alias.
      try { await repository.appendArtwork(saved) }
      catch (error) {
        check()
        const found = await repository.readArtwork(record.id)
        if (found?.image_id !== imageId) throw error
      }
      check()
      void repository.cacheThumbnail(imageId, blob).catch(() => {})
      return structuredClone(saved)
    }).finally(() => { saving = null })
    return saving
  }
  return { blob, save }
}

export async function downloadMangaPng(blob: Blob, name: string): Promise<boolean> {
  const desktop = getDesktopCapabilities()
  if (desktop) {
    const result = await desktop.saveImage({ data: new Uint8Array(await blob.arrayBuffer()), name })
    if (result.error) throw new Error(result.error)
    return result.saved
  }
  downloadBlob(blob, name)
  return true
}

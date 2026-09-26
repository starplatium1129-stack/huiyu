import { createWebArtworkRepository } from '../platform/web/artworkRepository.ts'
import type { ArtworkRepository, ArtworkDeleteResult, TrashEntry } from '../application/artwork/artworkRepository.ts'
export type { ArtworkRepository, ArtworkDeleteResult, TrashEntry } from '../application/artwork/artworkRepository.ts'

/** Default Web authority. Desktop activation replaces this once its migration is verified. */
export let artworkRepository: ArtworkRepository = createWebArtworkRepository()

export function configureArtworkRepository(repository: ArtworkRepository): void {
  artworkRepository = repository
}

export async function deleteArtwork(id: string | number): Promise<ArtworkDeleteResult> {
  return artworkRepository.deleteArtwork(id)
}

/** 软删：可见性立即消失，图片保留 30 天，期间可 restoreArtwork 整条恢复。 */
export async function softDeleteArtwork(id: string | number): Promise<{ deleted: boolean }> {
  return artworkRepository.softDeleteArtwork(id)
}

/** 从回收站恢复一条软删作品（历史条目 + 项目引用增量补回）。 */
export async function restoreArtwork(id: string | number): Promise<{ restored: boolean; missingImageIds?: string[] }> {
  return artworkRepository.restoreArtwork(id)
}

/** 懒清理超期软删（作品册挂载时调一次）。返回真删条数。 */
export async function purgeExpiredTrash(): Promise<{ purged: number }> {
  return artworkRepository.purgeExpiredTrash()
}

/** 列出回收站全部软删条目（回收站视图）。 */
export async function listTrash(): Promise<TrashEntry[]> {
  return artworkRepository.listTrash()
}

/** 更新单条作品的元数据（收藏 / 备注 / 评分）。 */
export async function patchArtwork(
  id: string | number,
  patch: Record<string, unknown>,
): Promise<{ updated: boolean }> {
  return artworkRepository.patchArtwork(id, patch)
}

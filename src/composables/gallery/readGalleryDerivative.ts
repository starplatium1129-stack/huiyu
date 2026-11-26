import type { ArtworkDerivativeLease, ArtworkRepository } from '@/application/artwork/artworkRepository'

/** The web repository stores Data URLs. Both owners use the same release path. */
export async function readGalleryDerivative(repository: ArtworkRepository, id: string,
  width?: number, signal?: AbortSignal): Promise<ArtworkDerivativeLease | null> {
  if (repository.getImageDerivative) return repository.getImageDerivative(id, width, signal)
  const url = width === undefined ? await repository.getThumbnail(id) : await repository.getPreview?.(id, width, signal)
  signal?.throwIfAborted()
  return url?.startsWith('data:image/') ? { url, bytes: url.length * 2, release() {} } : null
}

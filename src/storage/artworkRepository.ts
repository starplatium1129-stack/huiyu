import { createWebArtworkRepository } from '../platform/web/artworkRepository.ts'
import type { ArtworkRepository } from '../application/artwork/artworkRepository.ts'
export type { ArtworkRepository, ArtworkDeleteResult, TrashEntry } from '../application/artwork/artworkRepository.ts'

/** Default Web authority. Desktop activation replaces this once its migration is verified. */
export let artworkRepository: ArtworkRepository = createWebArtworkRepository()

export function configureArtworkRepository(repository: ArtworkRepository): void {
  artworkRepository = repository
}

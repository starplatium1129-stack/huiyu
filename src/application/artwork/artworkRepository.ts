import type { ArtworkRecord } from '../../types/artwork.ts'

/** Original project identity and unknown fields survive the storage boundary. */
export interface ArtworkProjectRecord {
  id: string | number
  [key: string]: unknown
}

export interface ArtworkLibrarySnapshot {
  history: ArtworkRecord[]
  projects: ArtworkProjectRecord[]
}

export interface ArtworkDeleteResult {
  deleted: boolean
  historyChanged: boolean
  removedImageIds: string[]
  removedThumbnailIds: string[]
  removedProjectReferences: number
}

export interface TrashEntry {
  id: string
  deletedAt: number
  historyEntries: unknown[]
  projectRefs: Array<{ projectId: unknown; hadReference: boolean }>
  imageIds: string[]
}

/** Business capabilities shared by the Web library and the future desktop authority. */
export interface ArtworkRepository {
  readHistory(): Promise<ArtworkRecord[]>
  readProjects(): Promise<ArtworkProjectRecord[]>
  readLibrarySnapshot(): Promise<ArtworkLibrarySnapshot>
  readRecentHistory(): Promise<ArtworkRecord[]>
  /** Legacy preference scoring also accepts history rows that predate artwork IDs. */
  readPreferenceHistory(): Promise<unknown[]>
  getImage(id: string): Promise<Blob | null>
  putImage(blob: Blob): Promise<string>
  deleteImage(id: string): Promise<void>
  countImages(): Promise<number>
  getThumbnail(id: string): Promise<string | null>
  setThumbnail(id: string, dataUrl: string): Promise<void>
  cacheThumbnail(id: string, blob: Blob): Promise<void>
  withStaging<T>(work: () => Promise<T>): Promise<T>
  appendArtwork(entry: ArtworkRecord): Promise<ArtworkRecord[]>
  patchArtwork(id: string | number, patch: Record<string, unknown>): Promise<{ updated: boolean }>
  patchArtworks(patches: Array<{ id: string | number; patch: Record<string, unknown> }>): Promise<void>
  deleteArtwork(id: string | number): Promise<ArtworkDeleteResult>
  softDeleteArtwork(id: string | number): Promise<{ deleted: boolean }>
  restoreArtwork(id: string | number): Promise<{ restored: boolean; missingImageIds?: string[] }>
  purgeExpiredTrash(): Promise<{ purged: number }>
  listTrash(): Promise<TrashEntry[]>
}

import type { ArtworkRecord, ArtworkSearchRecord } from '../../types/artwork.ts'
import type { ArtworkOrganizationRequest, ArtworkOrganizationReceipt, ArtworkOrganizationUndoResult } from './organization.ts'
import type { ArtworkProjectDraft } from './projects.ts'
import type { SmartAlbumDraft } from './smartAlbums.ts'

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

export const ARTWORK_DELETE_BATCH_SIZE = 200
export interface ArtworkSoftDeleteResult { id: string | number; deleted: boolean }

export interface TrashEntry {
  id: string
  deletedAt: number
  historyEntries: unknown[]
  projectRefs: Array<{ projectId: unknown; hadReference: boolean }>
  imageIds: string[]
}
export type ArtworkTrashSelection = Pick<TrashEntry, 'id' | 'deletedAt'>

/** Business capabilities shared by the Web library and the future desktop authority. */
export interface ArtworkRepository {
  readHistory(signal?: AbortSignal): Promise<ArtworkRecord[]>
  /** One detached, visible record; unknown outcomes can be reconciled by identity. */
  readArtwork(id: string | number, signal?: AbortSignal): Promise<ArtworkRecord | null>
  readSearchIndex(signal?: AbortSignal): Promise<ArtworkSearchRecord[]>
  readProjects(): Promise<ArtworkProjectRecord[]>
  createProject(input: ArtworkProjectDraft): Promise<ArtworkProjectRecord>
  saveSmartAlbum(input: SmartAlbumDraft): Promise<ArtworkProjectRecord>
  /** Removes only the saved rule; artwork and media remain in the library. */
  deleteSmartAlbum(id: string): Promise<{ deleted: boolean }>
  readLibrarySnapshot(): Promise<ArtworkLibrarySnapshot>
  readRecentHistory(signal?: AbortSignal): Promise<ArtworkRecord[]>
  /** Detached id/scene/character/favorite/timestamp only; legacy rows may predate artwork IDs. */
  readPreferenceHistory(): Promise<unknown[]>
  getImage(id: string, signal?: AbortSignal): Promise<Blob | null>
  putImage(blob: Blob): Promise<string>
  deleteImage(id: string): Promise<void>
  countImages(): Promise<number>
  getThumbnail(id: string): Promise<string | null>
  setThumbnail(id: string, dataUrl: string): Promise<void>
  cacheThumbnail(id: string, blob: Blob): Promise<void>
  withStaging<T>(work: () => Promise<T>): Promise<T>
  /** Commit only. Consumers update their own display without rereading the library. */
  appendArtwork(entry: ArtworkRecord): Promise<void>
  organizeArtworks(input: ArtworkOrganizationRequest): Promise<ArtworkOrganizationReceipt>
  undoArtworkOrganization(receipt: ArtworkOrganizationReceipt): Promise<ArtworkOrganizationUndoResult>
  patchArtwork(id: string | number, patch: Record<string, unknown>): Promise<{ updated: boolean }>
  patchArtworks(patches: Array<{ id: string | number; patch: Record<string, unknown> }>): Promise<void>
  deleteArtwork(id: string | number): Promise<ArtworkDeleteResult>
  softDeleteArtwork(id: string | number): Promise<{ deleted: boolean }>
  /** One bounded batch; missing records are reported without discarding successful deletions. */
  softDeleteArtworks(ids: Array<string | number>): Promise<ArtworkSoftDeleteResult[]>
  restoreArtwork(id: string | number): Promise<{ restored: boolean; missingImageIds?: string[] }>
  purgeExpiredTrash(): Promise<{ purged: number }>
  /** Permanently remove only the confirmed tombstones; newer deletions stay recoverable. */
  purgeTrash(entries: ArtworkTrashSelection[]): Promise<{ purged: number }>
  listTrash(): Promise<TrashEntry[]>
}

import type { ArtworkRecord, ArtworkSearchSummary } from '../../types/artwork.ts'
import type { ArtworkOrganizationRequest, ArtworkOrganizationReceipt, ArtworkOrganizationUndoResult } from './organization.ts'
import type { ArtworkProjectDraft } from './projects.ts'
import type { SmartAlbumDraft, SmartAlbumRemoval } from './smartAlbums.ts'
import type { ArtworkImportAccess, ArtworkImportCommand, ArtworkImportInput, ArtworkImportOutcome } from './localImageImport.ts'
import type { GalleryCatalog, GalleryCursor, GalleryPage, GalleryQuery } from './galleryQuery.ts'

/** Original project identity and unknown fields survive the storage boundary. */
export interface ArtworkProjectRecord {
  id: string | number
  [key: string]: unknown
}

export interface ArtworkLibrarySnapshot {
  history: ArtworkRecord[]
  projects: ArtworkProjectRecord[]
}

export const ARTWORK_DELETE_BATCH_SIZE = 200
export const ARTWORK_RESTORE_BATCH_SIZE = 200
export interface ArtworkSoftDeleteResult { id: string | number; deleted: boolean }
export interface ArtworkRestoreResult { id: string | number; restored: boolean; missingImageIds?: string[]; code?: string }

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
  searchArtworks(query: string, signal?: AbortSignal): Promise<ArtworkSearchSummary[]>
  readProjects(): Promise<ArtworkProjectRecord[]>
  createProject(input: ArtworkProjectDraft): Promise<ArtworkProjectRecord>
  saveSmartAlbum(input: SmartAlbumDraft): Promise<ArtworkProjectRecord>
  /** Removes only the saved rule; artwork and media remain in the library. */
  deleteSmartAlbum(input: SmartAlbumRemoval): Promise<{ deleted: boolean }>
  readLibrarySnapshot(): Promise<ArtworkLibrarySnapshot>
  /** Desktop authority filters/counts without transferring the complete library. */
  readGalleryPage?(query: GalleryQuery, cursor: GalleryCursor | null, signal: AbortSignal, limit?: number): Promise<GalleryPage>
  readGalleryCatalog?(signal: AbortSignal): Promise<GalleryCatalog>
  readRecentHistory(signal?: AbortSignal, limit?: number): Promise<ArtworkRecord[]>
  /** Detached id/scene/character/favorite/timestamp only; legacy rows may predate artwork IDs. */
  readPreferenceHistory(): Promise<unknown[]>
  getImage(id: string, signal?: AbortSignal): Promise<Blob | null>
  /** Only workspace-backed repositories can reference bytes without downloading.
   * Re-reading the opaque authority detects workspace/session changes during use. */
  getWorkspaceMediaReference?(id: string): { alias: string; authority: string }
  putImage(blob: Blob): Promise<string>
  deleteImage(id: string): Promise<void>
  countImages(): Promise<number>
  getThumbnail(id: string): Promise<string | null>
  /** Persistent display-sized derivatives, when supported by the authority. */
  getPreview?(id: string, width: number, signal?: AbortSignal): Promise<string | null>
  setThumbnail(id: string, dataUrl: string): Promise<void>
  cacheThumbnail(id: string, blob: Blob): Promise<void>
  withStaging<T>(work: () => Promise<T>): Promise<T>
  /** Commit only. Consumers update their own display without rereading the library. */
  appendArtwork(entry: ArtworkRecord): Promise<void>
  /** Explicit file-import retry using its persisted record, alias and operation. */
  resolveArtworkImport(input: ArtworkImportInput, command: ArtworkImportCommand, access: ArtworkImportAccess): Promise<ArtworkImportOutcome>
  organizeArtworks(input: ArtworkOrganizationRequest): Promise<ArtworkOrganizationReceipt>
  undoArtworkOrganization(receipt: ArtworkOrganizationReceipt): Promise<ArtworkOrganizationUndoResult>
  patchArtwork(id: string | number, patch: Record<string, unknown>): Promise<{ updated: boolean }>
  patchArtworks(patches: Array<{ id: string | number; patch: Record<string, unknown> }>): Promise<void>
  softDeleteArtwork(id: string | number): Promise<{ deleted: boolean }>
  /** One bounded batch; missing records are reported without discarding successful deletions. */
  softDeleteArtworks(ids: Array<string | number>): Promise<ArtworkSoftDeleteResult[]>
  restoreArtwork(id: string | number): Promise<{ restored: boolean; missingImageIds?: string[] }>
  /** Ordered bounded batch; per-item conflicts retain successful restores. */
  restoreArtworks(ids: Array<string | number>): Promise<ArtworkRestoreResult[]>
  purgeExpiredTrash(): Promise<{ purged: number }>
  /** Permanently remove only the confirmed tombstones; newer deletions stay recoverable. */
  purgeTrash(entries: ArtworkTrashSelection[]): Promise<{ purged: number }>
  listTrash(): Promise<TrashEntry[]>
}

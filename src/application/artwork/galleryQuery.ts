import type { ArtworkRecord } from '../../types/artwork.ts'
import type { SmartAlbumRule } from './smartAlbums.ts'

export interface GalleryQuery {
  favoriteOnly?: boolean; characterId?: string; projectId?: string; tag?: string; search?: string
  generation?: Record<string, string>; rule?: SmartAlbumRule
}
export interface GalleryCursor { time: number; key: string; revision: number; projects: string; query: string }
export interface GalleryPage {
  items: ArtworkRecord[]; total: number; nextCursor: GalleryCursor | null; revision: number; projectsVersion: string
}
export interface GalleryBucket { value: string; count: number }
export interface GalleryAlbumCount { id: string; count: number; coverIds: Array<string | number> }
export interface GalleryCatalog {
  revision: number; projectsVersion: string; total: number; favoriteCount: number
  tags: GalleryBucket[]; generation: Record<string, GalleryBucket[]>
  albums: GalleryAlbumCount[]; characters: GalleryAlbumCount[]; covers: ArtworkRecord[]
}

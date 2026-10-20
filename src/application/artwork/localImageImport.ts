import type { ArtworkRecord } from '../../types/artwork.ts'

export type ImageImportOwner =
  | { kind: 'web'; origin: string; sourceProfileId?: string }
  | { kind: 'workspace'; workspaceId: string; principalId: string }

/** Frozen before any media write. Retrying never allocates another artwork or alias. */
export interface ArtworkImportInput {
  operationId: string
  artwork: ArtworkRecord
  media: { alias: string; sha256: string; bytes: number; mime: string }
}
export interface LocalImageImport {
  version: 1
  owner: ImageImportOwner
  name: string
  input: ArtworkImportInput
}
export type ArtworkImportOutcome = 'saved' | 'not-live' | 'aborted'
export type ArtworkImportCommand = { kind: 'save'; blob?: Blob } | { kind: 'abort' }
export interface ArtworkImportAccess { check(): void }

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const operation = new RegExp(`^local-import:${uuid}$`)
const artworkId = new RegExp(`^local-${uuid}$`)
const imageId = new RegExp(`^image-${uuid}$`)
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0
export function imageImportOwnerKey(owner: ImageImportOwner): string {
  return JSON.stringify(owner.kind === 'workspace' ? [owner.kind, owner.workspaceId, owner.principalId]
    : [owner.kind, owner.origin, owner.sourceProfileId ?? ''])
}
export function parseLocalImageImport(value: unknown): LocalImageImport {
  const invalid = () => { throw new Error('图片导入恢复记录无效，原记录已保留；请勿重新导入同一批图片。') }
  if (!record(value) || value.version !== 1 || !text(value.name) || value.name.length > 1024
    || !record(value.owner) || !record(value.input)) return invalid()
  const { owner, input } = value
  if (!(owner.kind === 'workspace' && text(owner.workspaceId) && text(owner.principalId)
    || owner.kind === 'web' && text(owner.origin) && (owner.sourceProfileId === undefined || text(owner.sourceProfileId)))) return invalid()
  const { artwork, media } = input
  if (!text(input.operationId) || !operation.test(input.operationId) || !record(artwork) || !record(media)
    || !text(artwork.id) || !artworkId.test(artwork.id) || !text(media.alias) || !imageId.test(media.alias)
    || artwork.image_id !== media.alias || !text(media.sha256) || !/^[a-f0-9]{64}$/.test(media.sha256)
    || typeof media.bytes !== 'number' || !Number.isSafeInteger(media.bytes) || media.bytes <= 0 || media.bytes > 24 * 1024 * 1024
    || !['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/avif'].includes(String(media.mime))
    || typeof artwork.prompt !== 'string' || artwork.prompt.length > 2048 || artwork.image_url !== ''
    || 'image_data' in artwork || 'blob' in artwork || typeof artwork.timestamp !== 'number' || !Number.isFinite(artwork.timestamp)) return invalid()
  return structuredClone(value) as unknown as LocalImageImport
}

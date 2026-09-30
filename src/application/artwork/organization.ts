export type ArtworkOrganizationId = string | number

export interface ArtworkOrganizationRequest {
  ids: ArtworkOrganizationId[]
  /** Omitted preserves membership; null removes the selected artworks from albums. */
  projectId?: ArtworkOrganizationId | null
  collectionTags?: { add?: string[]; remove?: string[] }
}

export interface ArtworkOrganizationField { present: boolean; value?: unknown }
export interface ArtworkOrganizationState {
  project?: ArtworkOrganizationField
  collectionTags?: ArtworkOrganizationField
  memberships?: Array<{ projectId: ArtworkOrganizationId; position: number }>
}
export interface ArtworkOrganizationChange {
  id: ArtworkOrganizationId
  before: ArtworkOrganizationState
  after: ArtworkOrganizationState
}
export interface ArtworkOrganizationReceipt {
  operationId: string
  changes: ArtworkOrganizationChange[]
}
export interface ArtworkOrganizationUndoResult { restored: number; skipped: number }

export const ARTWORK_ORGANIZATION_BATCH_SIZE = 200
export const ARTWORK_ORGANIZATION_RECEIPT_LIMIT = 64
export const ARTWORK_ORGANIZATION_SELECTION_LIMIT = ARTWORK_ORGANIZATION_BATCH_SIZE * ARTWORK_ORGANIZATION_RECEIPT_LIMIT
export const COLLECTION_TAG_LIMIT = 64

export function collectionTags(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((tag): tag is string => typeof tag === 'string').map(tag => tag.trim()).filter(Boolean))]
    : []
}

/** Validate before either platform takes its mutation lock or serializes a request. */
export function normalizeArtworkOrganization(input: ArtworkOrganizationRequest): ArtworkOrganizationRequest {
  const id = (value: unknown): value is ArtworkOrganizationId => typeof value === 'string' && !!value.trim()
    || typeof value === 'number' && Number.isFinite(value)
  if (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > ARTWORK_ORGANIZATION_BATCH_SIZE || !input.ids.every(id)) {
    throw new Error('作品整理批次须包含 1–200 个有效作品编号')
  }
  if (input.projectId !== undefined && input.projectId !== null && !id(input.projectId)) throw new Error('画册编号无效')
  const tags = (values: unknown) => {
    if (values === undefined) return []
    if (!Array.isArray(values) || values.length > COLLECTION_TAG_LIMIT || values.some(value => typeof value !== 'string' || [...value.trim()].length > 64 || !value.trim())) {
      throw new Error('整理标签须为 1–64 字的文字，每次最多 64 个')
    }
    return collectionTags(values)
  }
  const change = input.collectionTags ? { add: tags(input.collectionTags.add), remove: tags(input.collectionTags.remove) } : undefined
  if (input.projectId === undefined && !change?.add.length && !change?.remove.length) throw new Error('请先选择画册或填写整理标签')
  return { ids: [...new Map(input.ids.map(value => [String(value).trim(), value])).values()],
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}), ...(change ? { collectionTags: change } : {}) }
}

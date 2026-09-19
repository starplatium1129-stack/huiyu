export interface ArtworkRecord {
  id: string | number
  engine?: string
  subject?: string
  characterId?: string
  outfitId?: string
  blueprintId?: string | null
  preview?: boolean
  timestamp?: string | number
  character?: string
  scene?: string | null
  sceneTitle?: string | null
  story?: string
  prompt?: string
  size?: string
  rating?: Record<string, unknown>
  lora?: string | null
  checkpoint?: string
  seed?: string | number
  sampler?: string
  favorite?: boolean
  reviewState?: 'candidate' | 'preferred' | 'rejected'
  version?: string | number
  width?: string | number | null
  height?: string | number | null
  image_width?: string | number | null
  image_height?: string | number | null
  actual?: { width?: string | number; height?: string | number }
  image_id?: string
  image_url?: string
  image_data?: string
  project?: string
  [key: string]: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseArtworkRecords(value: unknown): ArtworkRecord[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is ArtworkRecord => {
    if (!isRecord(item)) return false
    return (typeof item.id === 'string' && item.id.trim() !== '') || (typeof item.id === 'number' && Number.isFinite(item.id))
  })
}

export function artworkTimestamp(item: ArtworkRecord): number {
  const timestamp = item.timestamp
  const parsed = typeof timestamp === 'number'
    ? timestamp
    : typeof timestamp === 'string'
      ? new Date(timestamp).getTime()
      : Number.NaN
  if (Number.isFinite(parsed)) return parsed
  const fromId = Number(item.id)
  return Number.isFinite(fromId) ? fromId : 0
}

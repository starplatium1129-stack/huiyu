export interface HistoryValidation {
  ok: boolean
  reasons: string[]
}

export interface QuarantineCandidate {
  entry: Record<string, unknown>
  reasons: string[]
  index: number
  quarantinedAt: number
}

export interface StorageQuota {
  usage: number
  quota: number
  ratio: number | null
}

export interface StorageHealthReport {
  ok: boolean
  historyCount: number
  imageCount: number
  quarantineCount: number
  orphanImageIds: string[]
  missingImageIds: string[]
  quarantineCandidates: QuarantineCandidate[]
  quota: StorageQuota | null
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

export function validateHistoryEntry(value: unknown): HistoryValidation {
  const entry = record(value)
  if (!entry) return { ok: false, reasons: ['not_object'] }
  const reasons: string[] = []
  const id = entry.id
  if (id == null || id === ''
      || (typeof id === 'number' && !Number.isFinite(id))
      || (typeof id === 'string' && !id.trim())
      || (typeof id !== 'number' && typeof id !== 'string')) reasons.push('missing_id')
  if (entry.timestamp == null || entry.timestamp === '' || !Number.isFinite(Number(entry.timestamp))) {
    reasons.push('missing_timestamp')
  }
  if (entry.image_id != null && entry.image_id !== '' && typeof entry.image_id !== 'string') {
    reasons.push('invalid_image_id')
  }
  return { ok: reasons.length === 0, reasons }
}

export function quarantinePartition(values: unknown): {
  good: Record<string, unknown>[]
  bad: QuarantineCandidate[]
} {
  const good: Record<string, unknown>[] = []
  const bad: QuarantineCandidate[] = []
  ;(Array.isArray(values) ? values : []).forEach((value, index) => {
    const validation = validateHistoryEntry(value)
    const entry = record(value)
    if (validation.ok && entry) good.push(entry)
    else bad.push({
      entry: entry || { value },
      reasons: validation.reasons,
      index,
      quarantinedAt: Date.now(),
    })
  })
  return { good, bad }
}

export function estimateStorageQuota(value: unknown): StorageQuota | null {
  const source = record(value)
  if (!source) return null
  const usage = Number(source.usage)
  const quota = Number(source.quota)
  if (!Number.isFinite(usage) && !Number.isFinite(quota)) return null
  const safeUsage = Number.isFinite(usage) ? usage : 0
  const safeQuota = Number.isFinite(quota) ? quota : 0
  return {
    usage: safeUsage,
    quota: safeQuota,
    ratio: safeQuota > 0 ? safeUsage / safeQuota : null,
  }
}

function imageIds(values: unknown): string[] {
  return (Array.isArray(values) ? values : []).map(value => {
    if (typeof value === 'string') return value.trim()
    const item = record(value)
    return typeof item?.id === 'string' ? item.id.trim() : ''
  }).filter(Boolean)
}

export function inspectStorageHealth(
  history: unknown,
  images: unknown,
  options: { quota?: unknown } = {},
): StorageHealthReport {
  const partition = quarantinePartition(history)
  const referenced = new Set(partition.good
    .map(entry => typeof entry.image_id === 'string' ? entry.image_id.trim() : '')
    .filter(Boolean))
  const stored = imageIds(images)
  const storedSet = new Set(stored)
  const missingImageIds = [...referenced].filter(id => !storedSet.has(id))
  const orphanImageIds = stored.filter(id => !referenced.has(id))
  return {
    ok: partition.bad.length === 0 && missingImageIds.length === 0,
    historyCount: partition.good.length,
    imageCount: stored.length,
    quarantineCount: partition.bad.length,
    orphanImageIds,
    missingImageIds,
    quarantineCandidates: partition.bad,
    quota: estimateStorageQuota(options.quota),
  }
}

export function formatBytes(bytes: unknown): string {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(2)} GB`
}

export function summarizeStorageHealth(report: StorageHealthReport): string {
  const parts = [`${report.historyCount} 条历史`, `${report.imageCount} 张图片`]
  if (report.quarantineCount) parts.push(`${report.quarantineCount} 条待隔离`)
  if (report.missingImageIds.length) parts.push(`${report.missingImageIds.length} 条缺图`)
  if (report.orphanImageIds.length) parts.push(`${report.orphanImageIds.length} 张孤立图`)
  if (report.quota && report.quota.quota > 0) {
    const percent = report.quota.ratio == null ? '?' : Math.round(report.quota.ratio * 100)
    parts.push(`容量 ${percent}% (${formatBytes(report.quota.usage)}/${formatBytes(report.quota.quota)})`)
  }
  return parts.join(' · ')
}

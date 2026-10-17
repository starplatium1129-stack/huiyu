interface StorageQuota {
  usage: number
  quota: number
  ratio: number | null
}

interface StorageHealthReport {
  ok: boolean
  historyCount: number
  imageCount: number
  quarantineCount: number
  orphanImageIds: string[]
  missingImageIds: string[]
  quota: StorageQuota | null
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

function validHistoryEntry(entry: Record<string, unknown>): boolean {
  const id = entry.id
  if (id == null || id === ''
      || (typeof id === 'number' && !Number.isFinite(id))
      || (typeof id === 'string' && !id.trim())
      || (typeof id !== 'number' && typeof id !== 'string')) return false
  if (entry.timestamp == null || entry.timestamp === '' || !Number.isFinite(Number(entry.timestamp))) {
    return false
  }
  if (entry.image_id != null && entry.image_id !== '' && typeof entry.image_id !== 'string') {
    return false
  }
  return true
}

function quarantinePartition(values: unknown): {
  good: Record<string, unknown>[]
  badCount: number
} {
  const good: Record<string, unknown>[] = []
  let badCount = 0
  ;(Array.isArray(values) ? values : []).forEach(value => {
    const entry = record(value)
    if (entry && validHistoryEntry(entry)) good.push(entry)
    else badCount++
  })
  return { good, badCount }
}

function estimateStorageQuota(value: unknown): StorageQuota | null {
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
    ok: partition.badCount === 0 && missingImageIds.length === 0,
    historyCount: partition.good.length,
    imageCount: stored.length,
    quarantineCount: partition.badCount,
    orphanImageIds,
    missingImageIds,
    quota: estimateStorageQuota(options.quota),
  }
}

function formatBytes(bytes: unknown): string {
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

import { workspaceRequest } from '@/api/workspace'
import { imgPage, imgCount } from './useImageStore'

export interface ExportImage { id: string; name: string; created_at: string | number; blob?: Blob | null }
interface ExportPage { items: Array<{ imageId: string; title: string; timestamp: string | number | null }>; nextCursor: string | null; revision: number; total: number | null }
export async function* backupImagePages(desktop: boolean, signal: AbortSignal): AsyncGenerator<{ entries: ExportImage[]; total: number }> {
  let cursor: string | null = null, revision: number | undefined, total = desktop ? 0 : await imgCount()
  do {
    signal.throwIfAborted()
    if (desktop) {
      const page: ExportPage = await workspaceRequest<ExportPage>(
        { kind: 'readArtworkExportPage', ...(cursor === null ? {} : { cursor, revision }) }, signal)
      if (!Number.isSafeInteger(page.revision) || page.revision < 0 || revision !== undefined && revision !== page.revision
        || !Array.isArray(page.items) || page.items.length > 64 || page.items.some(row => typeof row.imageId !== 'string' || !row.imageId)
        || page.nextCursor !== null && typeof page.nextCursor !== 'string') throw new Error('原图导出分页无效，请重新读取')
      revision = page.revision
      if (cursor === null) { if (!Number.isSafeInteger(page.total) || page.total! < 0) throw new Error('原图导出计数无效'); total = page.total! }
      yield { entries: page.items.map(row => ({ id: row.imageId, name: row.title, created_at: row.timestamp ?? '' })), total }
      if (page.nextCursor !== null && cursor !== null && page.nextCursor <= cursor) throw new Error('原图导出游标未前进')
      cursor = page.nextCursor
    } else {
      // One Blob at a time; JSON backup keeps its separate full-library scope.
      const page = await imgPage(cursor ?? undefined, 1)
      yield { entries: page.entries, total }
      cursor = page.nextCursor
    }
  } while (cursor !== null)
}

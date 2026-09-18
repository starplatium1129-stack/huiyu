import { describe, expect, it, vi } from 'vitest'
import { buildBackupBlob, MAX_BACKUP_BYTES, readImageDataUrl } from './backupExport'
import { normalizeBackup } from './backupCore'
import type { StoredImageRecord } from '@/composables/useImageStore'

const payload = { appVersion: 'test', createdAt: '2026-09-18T00:00:00Z', history: [{ id: '记录', image_id: 'one' }] }
function image(id = 'one'): StoredImageRecord {
  return { id, name: '我的图片.png', type: 'image/png', size: 1, created_at: 1, blob: new Blob(['a'], { type: 'image/png' }) }
}
const url = 'data:image/png;base64,YQ=='

describe('bounded, importable backup export', () => {
  it('round-trips every image and metadata through the production importer', async () => {
    const onProgress = vi.fn(), read = vi.fn(async () => url)
    const { blob, summary } = await buildBackupBlob(payload, [image(), image('two')], { read, onProgress })
    const restored = normalizeBackup(JSON.parse(await blob.text()))
    expect(restored.data.history).toEqual(payload.history)
    expect(restored.images.map(item => [item.id, item.name, item.dataUrl])).toEqual([
      ['one', '我的图片.png', url], ['two', '我的图片.png', url],
    ])
    expect(summary).toEqual({ history: 1, projects: 0, images: 2, settings: 0 })
    expect(onProgress.mock.calls.map(([item]) => item.completed)).toEqual([0, 1, 2])
  })
  it('accepts the exact UTF-8 byte boundary and rejects one byte less before reading', async () => {
    const read = vi.fn(async () => url)
    const result = await buildBackupBlob(payload, [image()], { read })
    const bytes = result.blob.size
    expect(bytes).toBeGreaterThan((await result.blob.text()).length)
    await expect(buildBackupBlob(payload, [image()], { read, maxBytes: bytes })).resolves.toHaveProperty('blob.size', bytes)
    read.mockClear()
    await expect(buildBackupBlob(payload, [image()], { read, maxBytes: bytes - 1 })).rejects.toThrow('512 MB')
    expect(read).not.toHaveBeenCalled()
  })
  it('preflights base64 expansion using Blob size, not stale record.size', async () => {
    const record = image(), read = vi.fn(async () => url)
    Object.defineProperty(record.blob, 'size', { value: 400 * 1024 * 1024 })
    await expect(buildBackupBlob(payload, [record], { read })).rejects.toThrow('512 MB')
    expect(read).not.toHaveBeenCalled()
    expect(MAX_BACKUP_BYTES).toBe(512 * 1024 * 1024)
  })
  it('does not read or produce an output when already cancelled', async () => {
    const controller = new AbortController(), read = vi.fn(async () => url)
    controller.abort()
    await expect(buildBackupBlob(payload, [image()], { read, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(read).not.toHaveBeenCalled()
  })
  it('stops after the current image if cancelled, without beginning the next read', async () => {
    const controller = new AbortController(), read = vi.fn(async () => { controller.abort(); return url })
    await expect(buildBackupBlob(payload, [image(), image('two')], { read, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(read).toHaveBeenCalledTimes(1)
  })
  it('checks actual encoded size too, not just the estimate', async () => {
    const base = await buildBackupBlob(payload, [image()], { read: async () => url })
    await expect(buildBackupBlob(payload, [image()], { maxBytes: base.blob.size, read: async () => 'data:image/png;base64,' + 'A'.repeat(400) })).rejects.toThrow('512 MB')
  })
  it('fails instead of skipping an unreadable or invalid image', async () => {
    await expect(buildBackupBlob(payload, [image()], { read: async () => { throw new Error('disk read') } })).rejects.toThrow('disk read')
    await expect(buildBackupBlob(payload, [image()], { read: async () => 'data:text/plain;base64,YQ==' })).rejects.toThrow('无效图片')
  })
  it('validates duplicate IDs and unsupported images before file reads', async () => {
    const read = vi.fn(async () => url)
    await expect(buildBackupBlob(payload, [image(), image()], { read })).rejects.toThrow('重复图片 ID')
    await expect(buildBackupBlob(payload, [{ ...image(), blob: new Blob(['a'], { type: 'text/plain' }) }], { read })).rejects.toThrow('无效图片')
    expect(read).not.toHaveBeenCalled()
  })
  it('supports records-only and images-only backups without changing schema', async () => {
    const records = await buildBackupBlob(payload, [])
    expect(normalizeBackup(JSON.parse(await records.blob.text())).images).toEqual([])
    const pictures = await buildBackupBlob({ appVersion: 'test' }, [image()], { read: async () => url })
    expect(normalizeBackup(JSON.parse(await pictures.blob.text())).images).toHaveLength(1)
  })
  it('uses the real FileReader and honours cancellation before reading', async () => {
    await expect(readImageDataUrl(image().blob)).resolves.toBe(url)
    const controller = new AbortController(); controller.abort()
    await expect(readImageDataUrl(image().blob, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})

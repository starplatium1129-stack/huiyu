type Request = <T>(command: Record<string, unknown>) => Promise<T>

/** Both media-only uploads and atomic artwork saves use the same bounded chunks. */
export async function uploadArtworkChunks(blob: Blob, writtenBytes: number, operationId: string,
  kind: 'uploadMediaChunk' | 'uploadChunk', request: Request, check: () => void): Promise<void> {
  if (!Number.isSafeInteger(writtenBytes) || writtenBytes < 0 || writtenBytes > blob.size) throw new Error('图片上传位置无效')
  for (let offset = writtenBytes; offset < blob.size; offset += 1024 * 1024) {
    check()
    await request({ kind, operationId, offset, data: blob.slice(offset, offset + 1024 * 1024) })
    check()
  }
}

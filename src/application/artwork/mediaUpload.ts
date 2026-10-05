/** A retry identity, not proof that the caller owns a committed image. */
export interface PendingMediaUpload {
  operationId: string
  imageId: string
  workspaceId: string
  principalId: string
}
export class PendingMediaUploadError extends Error {
  readonly pending: Readonly<PendingMediaUpload>
  constructor(pending: PendingMediaUpload, cause: unknown) {
    super(`图片上传结果尚未确认，请重试同一张图片（操作 ${pending.operationId}）`, { cause })
    this.name = 'PendingMediaUploadError'
    this.pending = Object.freeze({ ...pending })
  }
}

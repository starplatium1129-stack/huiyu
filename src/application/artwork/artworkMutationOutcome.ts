/** A rejected transport is not proof that an admitted artwork command failed. */
export class ArtworkMutationUnconfirmedError extends Error {
  constructor(readonly operationId: string, readonly kind: string, cause: unknown) {
    super('作品操作结果尚未确认，请恢复连接并重新读取作品册后核对', { cause })
    this.name = 'ArtworkMutationUnconfirmedError'
  }
}

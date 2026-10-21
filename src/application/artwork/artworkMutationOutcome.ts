/** A rejected transport is not proof that an admitted artwork command failed. */
export class ArtworkMutationUnconfirmedError extends Error {
  constructor(readonly operationId: string, readonly kind: string, cause: unknown) {
    super('作品操作结果尚未确认，请恢复连接并重新读取作品册后核对', { cause })
    this.name = 'ArtworkMutationUnconfirmedError'
  }
}

/** A live record and a separate trash snapshot are not an idempotent restore. */
export class ArtworkTrashConflictError extends Error {
  static readonly code = 'ARTWORK_TRASH_CONFLICT'
  constructor() {
    super('作品册与回收站已有同编号作品，请先核对；现有作品与回收站快照均保留')
    this.name = 'ArtworkTrashConflictError'
  }
}

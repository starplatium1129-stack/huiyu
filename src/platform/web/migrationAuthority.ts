import type { DesktopConnectionState } from '../desktop/runtime'
import type { MigrationCandidatePort } from './migrationImport'

/** Non-secret identity retained only while an activation awaits confirmation. */
export interface MigrationAuthorityTarget {
  migrationId: string
  workspaceId: string
  generation: number
  sourceProfileId: string
  sourceOrigin: string
  domains: string[]
}
export function assertMigrationAuthority(state: DesktopConnectionState, target: MigrationAuthorityTarget): void {
  const bootstrap = state.bootstrap, workspace = bootstrap?.runtime?.workspace
  if (state.connection !== 'ready' || !bootstrap || bootstrap.sourceProfileId !== target.sourceProfileId
    || bootstrap.sourceOrigin !== target.sourceOrigin || workspace?.workspaceId !== target.workspaceId
    || workspace.activeMigrationId !== target.migrationId || workspace.generation <= target.generation
    || !target.domains.every(domain => workspace.domains.includes(domain as typeof workspace.domains[number]))) {
    throw new Error('尚未确认迁移激活身份；请保持资料只读，连接支持激活核对的桌面版本后重试确认。')
  }
}
/** Import can never follow a reconnect into another candidate or runtime epoch. */
export function bindMigrationCandidate(read: () => DesktopConnectionState, request: MigrationCandidatePort['request']): MigrationCandidatePort {
  const identity = () => {
    const state = read(), bootstrap = state.bootstrap, runtime = bootstrap?.runtime, candidate = runtime?.workspace
    if (state.connection !== 'ready' || !bootstrap || !runtime || !candidate) throw new Error('迁移目标尚未连接。')
    return JSON.stringify([bootstrap.sourceProfileId, bootstrap.sourceOrigin, bootstrap.windowId, runtime.origin, runtime.runtimeEpoch, candidate.workspaceId, candidate.runtimeEpoch, candidate.generation])
  }
  const captured = identity()
  function check() { if (identity() !== captured) throw new Error('迁移目标已变化，已停止写入；请重新核对候选工作区。') }
  return { async request<T>(command: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted(); check()
    const result = await request<T>(command, signal)
    check(); signal?.throwIfAborted()
    return result
  } }
}

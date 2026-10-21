import { WorkspaceRequestError } from '../../api/workspace.ts'
import { ArtworkMutationUnconfirmedError } from '../../application/artwork/artworkMutationOutcome.ts'

interface Command { kind: string; operationId: string; [key: string]: unknown }
type Request = <T>(command: Record<string, unknown>) => Promise<T>

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function receipt<T>(value: unknown, command: Command, decode?: (value: Record<string, unknown>) => T): T {
  if (!record(value) || value.operationId !== command.operationId || value.kind !== command.kind
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0) throw new Error('作品操作回执身份无效')
  return decode ? decode(value) : structuredClone(value) as T
}

/** Single and batch edits share one confirmation boundary. Never replay a write:
 * an unreadable, absent or prepared receipt does not prove the worker stopped.
 * Recovery is pinned to the original workspace, principal and runtime session.
 */
export function createArtworkCommandWriter(request: Request, authority: () => string, invalidate: () => void) {
  return async function write<T>(input: Command, decode?: (value: Record<string, unknown>) => T): Promise<T> {
    const command = structuredClone(input), owner = authority()
    const check = () => { if (authority() !== owner) throw new Error('作品操作的工作区连接已变化') }
    try {
      try {
        const result = await request<unknown>(command)
        check()
        return receipt(result, command, decode)
      } catch (error) {
        // A structured client rejection belongs to this attempt. In particular,
        // a conflicting reused ID cannot adopt an older command's receipt.
        if (error instanceof WorkspaceRequestError && error.status >= 400 && error.status < 500 && error.code !== 'COMMIT_UNKNOWN') throw error
        try {
          check()
          const operation = await request<unknown>({ kind: 'getOperation', operationId: command.operationId })
          check()
          if (record(operation) && operation.operationId === command.operationId && operation.kind === command.kind
            && operation.state === 'committed') return receipt(operation.receipt, command, decode)
        } catch { /* Preserve the original identity and uncertainty, not a recovery read error. */ }
        throw new ArtworkMutationUnconfirmedError(command.operationId, command.kind, error)
      }
    } finally {
      // Unknown commits and revision conflicts can also obsolete cached rows.
      invalidate()
    }
  }
}

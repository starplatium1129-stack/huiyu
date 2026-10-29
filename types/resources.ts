export type ResourceAction = 'import' | 'download' | 'recover' | 'rollback'
type ResourceTaskState = 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
interface ResourceIssue { code: string; message: string }
interface ResourceOperationResult {
  action: 'installed' | 'already-installed' | 'recovered' | 'rolled-back' | 'nothing-to-recover' | 'downloaded' | 'already-downloaded'
  warning: ResourceIssue | null
}
interface ResourceTask {
  id: string
  action: ResourceAction
  releaseId: string | null
  resumeAction: 'download' | 'import' | null
  state: ResourceTaskState
  phase: string
  bytes: number
  total: number
  startedAt: number
  finishedAt: number
  error: ResourceIssue | null
  result?: ResourceOperationResult | null
}
interface ResourceRelease {
  id: string
  label: string
  kind: 'full' | 'delta'
  source: 'offline' | 'http'
  identity: string
  downloaded: boolean
}
export interface ResourceStatus {
  ok: true
  configured: boolean
  managementEnabled: boolean
  busy: boolean
  mounted: boolean
  directoryRoot?: string
  current: { identity: string; releaseId: string; files: number } | null
  canRollback: boolean
  recoveryRequired: boolean
  issue: ResourceIssue | null
  releases: ResourceRelease[]
  task: ResourceTask | null
}
export interface ResourceTaskResult { ok: true; task: ResourceTask }

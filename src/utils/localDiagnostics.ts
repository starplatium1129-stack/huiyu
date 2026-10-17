/** Session-only metadata. Never pass headers, bodies, prompts, output or error text here. */
type Outcome = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timeout'
type TaskKind = 'image' | 'batch' | 'video' | 'interrogate'
type TaskState = 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
interface RequestEntry {
  type: 'request'
  id: string
  endpoint: string
  method: string
  startedAt: number
  durationMs?: number
  outcome: Outcome
  status?: number
  /** Concurrent tasks are context, not proof that a request belongs to a particular task. */
  activeTaskIds: string[]
}
interface TaskEntry { type: 'task'; id: string; kind: TaskKind; status: TaskState; at: number }
const LIMIT = 200
const entries: Array<RequestEntry | TaskEntry> = []
const taskAliases = new Map<string, string>()
const activeTasks = new Set<string>()
let sequence = 0

const groups = new Set(['anima', 'video', 'video-ai', 'chat', 'voice', 'tts', 'desktop-tools', 'status', 'diagnostics', 'logs', 'maintenance', 'sd', 'generate', 'interrogate', 'health'])
const operations = new Set(['jobs', 'batches', 'status', 'images', 'cancel', 'retry', 'stop', 'start', 'config', 'models', 'generate', 'interrupt', 'progress', 'synthesize', 'rewrite', 'polish', 'review', 'script', 'dialogue'])
function endpointLabel(url: string): string {
  try {
    const parts = new URL(url, 'http://local.invalid').pathname.split('/').filter(Boolean)
    if (parts[0] !== 'api' || !groups.has(parts[1])) return 'other'
    const operation = operations.has(parts[2]) ? `/${parts[2]}` : ''
    return `/api/${parts[1]}${operation}${parts.length > (operation ? 3 : 2) ? '/:resource' : ''}`
  } catch { return 'other' }
}
function append(entry: RequestEntry | TaskEntry) {
  entries.push(entry)
  if (entries.length > LIMIT) entries.shift()
}

export function startDiagnosticRequest(url: string, method = 'GET') {
  const normalized = method.toUpperCase()
  const entry: RequestEntry = {
    type: 'request', id: `request-${++sequence}`, endpoint: endpointLabel(url),
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(normalized) ? normalized : 'OTHER',
    startedAt: Date.now(), outcome: 'running', activeTaskIds: [...activeTasks].slice(-30),
  }
  append(entry)
  return (outcome: Exclude<Outcome, 'running'>, status?: number) => {
    if (entry.outcome !== 'running') return
    entry.outcome = outcome
    entry.durationMs = Math.max(0, Date.now() - entry.startedAt)
    if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) entry.status = status
  }
}

export function recordDiagnosticTask(id: string, kind: TaskKind, status: TaskState) {
  if (!['image', 'batch', 'video', 'interrogate'].includes(kind)
    || !['idle', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(status)) return
  let alias = taskAliases.get(id)
  if (!alias) {
    alias = `task-${++sequence}`
    taskAliases.set(id, alias)
    if (taskAliases.size > 100) {
      const oldest = taskAliases.keys().next().value!
      activeTasks.delete(taskAliases.get(oldest)!)
      taskAliases.delete(oldest)
    }
  }
  if (status === 'running') activeTasks.add(alias)
  else activeTasks.delete(alias)
  append({ type: 'task', id: alias, kind, status, at: Date.now() })
}

export function diagnosticSnapshot() {
  return {
    scope: 'current-page-session', limit: LIMIT,
    taskIdFormat: 'local-alias', requestTaskRelationship: 'concurrent-not-causal',
    entries: entries.map(entry => entry.type === 'request' ? { ...entry, activeTaskIds: [...entry.activeTaskIds] } : { ...entry }),
  }
}

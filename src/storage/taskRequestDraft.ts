import { newRequestDraft, readRequestDraft, type RequestDraft } from './requestDraft'

export interface TaskRequestDraft extends RequestDraft {
  kind: 'qwen' | 'moss' | 'manga' | 'lineart' | 'video' | 'batch'
  input: Record<string, unknown>
  context?: Record<string, unknown>
  taskId?: string
  details?: Record<string, unknown>
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
export function readTaskRequestDraft(slot: string): TaskRequestDraft | null {
  const value = readRequestDraft(slot)
  if (!value) return null
  if (!['qwen', 'moss', 'manga', 'lineart', 'video', 'batch'].includes(String(value.kind)) || !record(value.input)
    || value.context !== undefined && !record(value.context) || value.details !== undefined && !record(value.details)
    || value.taskId !== undefined && (typeof value.taskId !== 'string' || !value.taskId))
    throw new Error('原任务配方或身份无效，已保留记录；不会重新提交')
  return value as unknown as TaskRequestDraft
}
export function newTaskRequestDraft(kind: TaskRequestDraft['kind'], input: Record<string, unknown>, runtime: boolean,
  context?: Record<string, unknown>, details?: Record<string, unknown>): TaskRequestDraft {
  return { ...newRequestDraft(runtime), kind, ...JSON.parse(JSON.stringify({ input, context, details })) as Pick<TaskRequestDraft, 'input' | 'context' | 'details'> }
}

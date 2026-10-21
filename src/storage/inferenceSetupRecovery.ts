import { profileLocalStorage, writeProfileLocal } from '@/platform/web/profileStorage'
import { sameTempResultOwner, tempResultOwner } from '@/utils/tempResult'

const key = (workspace: string) => 'aics-model-draft-inference-setup-' + encodeURIComponent(workspace)
export interface SetupRecovery { id: string; workspace: string; runtimeId: string }
export function readSetupRecovery(workspace: string): SetupRecovery | null {
  const raw = profileLocalStorage.getItem(key(workspace))
  if (!raw) return null
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== 'object' || !('id' in value) || !('workspace' in value) || !('runtimeId' in value)
    || typeof value.id !== 'string' || !value.id || typeof value.workspace !== 'string'
    || !value.workspace || typeof value.runtimeId !== 'string' || !value.runtimeId) {
    throw new Error('原生准备恢复编号无法读取，请保留原记录并检查资料存储')
  }
  return { id: value.id, workspace: value.workspace, runtimeId: value.runtimeId }
}
/** Store only identity and workspace; never store request payloads or credentials. */
export async function saveSetupRecovery(workspace: string, value: SetupRecovery | null) {
  const owner = tempResultOwner()
  await writeProfileLocal(key(workspace), value ? JSON.stringify(value) : null).confirm()
  if (!sameTempResultOwner(owner)) throw new Error('保存恢复编号期间资料来源已变化，请回到原工作区检查')
}

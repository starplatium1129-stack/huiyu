import { computed, onMounted, onScopeDispose, readonly, shallowRef, watch } from 'vue'
import { runtimeFetch, runtimeResourceIdentity } from '@/platform/runtimeUrl'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'

export interface CompanionToolPermissions {
  enabled: boolean; readFiles: boolean; writeFiles: boolean; captureScreen: boolean; commands: boolean
}
const closed = (): CompanionToolPermissions => ({ enabled: false, readFiles: false, writeFiles: false, captureScreen: false, commands: false })
const permissions = shallowRef(closed()), error = shallowRef(''), saving = shallowRef(false)
let users = 0, channel: BroadcastChannel | undefined, stopIdentity: (() => void) | undefined
let request = 0, polling = false, reloadQueued = false
async function exchange(patch?: Partial<CompanionToolPermissions>, signal?: AbortSignal) {
  const owner = runtimeResourceIdentity(), sequence = ++request
  if (!isLocalStudioHost()) { permissions.value = closed(); return permissions.value }
  const response = await runtimeFetch('/api/desktop-tools/permissions', {
    method: patch ? 'PATCH' : 'GET', headers: patch ? { 'Content-Type': 'application/json' } : undefined,
    body: patch ? JSON.stringify(patch) : undefined, cache: 'no-store',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
  })
  const value = await response.json() as { ok?: boolean; permissions?: CompanionToolPermissions; output?: string }
  if (!response.ok || !value.ok || !value.permissions || Object.keys(closed()).some(key => typeof value.permissions?.[key as keyof CompanionToolPermissions] !== 'boolean'))
    throw new Error(value.output || '本机工具权限暂时无法读取，工具保持关闭。')
  if (owner !== runtimeResourceIdentity()) throw new Error('本机连接已变化，工具保持关闭。')
  if (sequence === request) { permissions.value = { ...value.permissions }; error.value = '' }
  return sequence === request ? { ...value.permissions } : { ...permissions.value }
}
export async function loadCompanionToolPermissions(signal?: AbortSignal) {
  try { return await exchange(undefined, signal) }
  catch (reason) { permissions.value = closed(); error.value = reason instanceof Error ? reason.message : '工具权限不可用'; throw reason }
}
export function companionToolAllowed(name: string, policy: CompanionToolPermissions) {
  return policy.enabled && (name === 'capture_screen' ? policy.captureScreen : name === 'write_file' ? policy.writeFiles
    : ['read_file', 'read_image', 'list_files'].includes(name) ? policy.readFiles : name === 'run_command' ? policy.commands : true)
}
async function update(key: keyof CompanionToolPermissions, enabled: boolean) {
  if (saving.value) return
  saving.value = true
  if (!enabled) permissions.value = { ...permissions.value, [key]: false }
  try { await exchange({ [key]: enabled }); channel?.postMessage('changed') }
  catch (reason) { permissions.value = closed(); error.value = reason instanceof Error ? reason.message : '工具权限未保存' }
  finally {
    saving.value = false
    if (reloadQueued) { reloadQueued = false; reload() }
  }
}
const reload = () => {
  if (!users) return
  if (saving.value) { reloadQueued = true; return }
  if (polling) { reloadQueued = true; return }
  polling = true
  void loadCompanionToolPermissions().catch(() => {}).finally(() => {
    polling = false
    if (reloadQueued) { reloadQueued = false; reload() }
  })
}
export function useCompanionToolPermissions() {
  let mounted = false
  onMounted(() => {
    mounted = true
    if (users++ === 0) {
      channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('huiyu-local-tool-permissions') : undefined
      if (channel) channel.onmessage = reload
      stopIdentity = watch(runtimeResourceIdentity, () => { permissions.value = closed(); reload() })
      reload()
    }
  })
  onScopeDispose(() => {
    if (mounted && --users === 0) { stopIdentity?.(); stopIdentity = undefined; channel?.close(); channel = undefined; reloadQueued = false }
  })
  return { permissions: readonly(permissions), error: readonly(error), saving: readonly(saving), update,
    companionTools: computed({ get: () => permissions.value.enabled, set: value => { void update('enabled', value) } }) }
}

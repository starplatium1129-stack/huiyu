import { desktopRuntimeFetch, getDesktopRuntime } from '@/platform/desktop/runtime'

const encode = (value: unknown) => encodeURIComponent(String(value))
function resource(command: Record<string, unknown>): [string, string] {
  const id = encode(command.id), operation = encode(command.operationId)
  const entity = `/artworks/${id}?idType=${typeof command.id}`
  const migration = `/migrations/${encode(command.migrationId)}`
  switch (command.kind) {
    case 'status': return ['GET', '/status']
    case 'listArtworks': return ['GET', '/artworks?' + new URLSearchParams(Object.entries(command).filter(([key, value]) => key !== 'kind' && value !== undefined).map(([key, value]) => [key, String(value)]))]
    case 'getArtwork': return ['GET', entity]
    case 'listProjects': return ['GET', '/projects']
    case 'getOperation': return ['GET', `/operations/${operation}`]
    case 'prepareSave': return ['POST', `/artwork-saves/${operation}`]
    case 'uploadChunk': return ['PUT', `/artwork-saves/${operation}/chunks`]
    case 'commitSave': return ['POST', `/artwork-saves/${operation}/commit`]
    case 'abortSave': return ['POST', `/artwork-saves/${operation}/abort`]
    case 'appendArtwork': return ['POST', '/artworks']
    case 'patchArtwork': return ['PATCH', entity]
    case 'softDeleteArtwork': return ['DELETE', entity]
    case 'hardDeleteArtwork': return ['DELETE', `/artworks/${id}/permanent?idType=${typeof command.id}`]
    case 'restoreArtwork': return ['POST', `/artworks/${id}/restore?idType=${typeof command.id}`]
    case 'saveProject': return ['POST', '/projects']
    case 'purgeExpiredTrash': return ['POST', '/trash/purge']
    case 'collectGarbage': return ['POST', '/media/collect']
    case 'prepareMedia': return ['POST', `/media-uploads/${operation}`]
    case 'uploadMediaChunk': return ['PUT', `/media-uploads/${operation}/chunks`]
    case 'commitMedia': return ['POST', `/media-uploads/${operation}/commit`]
    case 'releaseMedia': return ['DELETE', `/media/${encode(command.alias)}`]
    case 'countMedia': return ['GET', '/media/count']
    case 'backup': return ['POST', '/backups']
    case 'restoreBackup': return ['POST', `/backups/${encode(command.backupId)}/restore`]
    case 'migration.begin': return ['POST', '/migrations']
    case 'migration.status': return ['GET', migration]
    case 'migration.verify': return ['POST', `${migration}/verify`]
    case 'migration.record': return ['POST', `${migration}/records/${encode(command.itemId)}`]
    case 'migration.recordChunk': return ['PUT', `${migration}/records/${encode(command.itemId)}/chunks`]
    case 'migration.media': return ['PUT', `${migration}/media/${encode(command.alias)}/chunks`]
    case 'profile.readSettings': return ['GET', '/profile/settings']
    case 'profile.saveSetting': return ['PUT', '/profile/settings']
    case 'profile.readChat': return ['GET', '/profile/chat']
    case 'profile.saveChatRecord': return ['PUT', '/profile/chat']
    case 'profile.resetChat': return ['POST', '/profile/chat/reset']
    case 'profile.readDrafts': return ['GET', `/profile/drafts?windowId=${encode(command.windowId)}`]
    case 'profile.saveDraft': return ['PUT', '/profile/drafts']
    default: throw new Error('不支持的工作区操作')
  }
}
function base64(data: Uint8Array): string {
  let value = ''
  for (let offset = 0; offset < data.length; offset += 32768) value += String.fromCharCode(...data.subarray(offset, offset + 32768))
  return btoa(value)
}
export async function workspaceRequest<T>(command: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const session = getDesktopRuntime().bootstrap?.runtime?.workspace
  if (!session) throw new Error('私人工作区尚未连接')
  const [method, path] = resource(command)
  const deadline = AbortSignal.timeout(command.kind === 'backup' || command.kind === 'restoreBackup' ? 120_000 : 35_000)
  const response = await desktopRuntimeFetch('/api/workspace' + path, { method, signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    headers: { 'Content-Type': 'application/json' }, ...(method === 'GET' ? {} : { body: JSON.stringify({ ...command,
      ...(command.data instanceof Uint8Array ? { data: base64(command.data) } : {}), protocolVersion: 1, workspaceId: session.workspaceId }) }) })
  const payload = await response.json()
  if (!response.ok) throw Object.assign(new Error(payload.error || payload.message || '工作区操作未完成'), { code: payload.code, operationId: command.operationId })
  if (payload.workspaceId !== session.workspaceId || payload.runtimeEpoch !== session.runtimeEpoch) throw new Error('工作区连接已变化，请重新读取')
  return payload.result as T
}

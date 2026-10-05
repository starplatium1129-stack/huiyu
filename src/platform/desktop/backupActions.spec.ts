import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createWorkspaceBackup } from './backupActions'
import { WORKSPACE_BACKUP_PENDING_PREFIX } from '@/utils/storageKeys'
const mock = vi.hoisted(() => ({ request: vi.fn(), workspace: { workspaceId: 'workspace', principalId: 'owner' } }))
vi.mock('@/api/workspace.ts', () => ({ workspaceRequest: mock.request }))
vi.mock('./runtime.ts', () => ({ getDesktopRuntime: () => ({ bootstrap: { runtime: { workspace: mock.workspace } } }) }))
vi.mock('../web/profileStorage.ts', () => ({ flushProfileWrites: async () => {} }))
const result = { backupId: 'backup-fixture', revision: 3, mediaCount: 2 }
const key = () => WORKSPACE_BACKUP_PENDING_PREFIX + JSON.stringify([mock.workspace.workspaceId, mock.workspace.principalId])
const marker = () => JSON.parse(localStorage.getItem(key())!) as { operationId: string; createdAt: string }
beforeEach(() => {
  localStorage.clear(); mock.request.mockReset(); mock.workspace.workspaceId = 'workspace'; mock.workspace.principalId = 'owner'
  let tail = Promise.resolve()
  vi.stubGlobal('navigator', { locks: { request: (_name: string, _options: unknown, work: () => unknown) => {
    const next = tail.then(work); tail = next.then(() => undefined, () => undefined); return next
  } } })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('reuses one durable ID through IO failure, prepared retry and delivery failure, then retrieves the committed receipt', async () => {
  mock.request.mockRejectedValueOnce(new Error('copy failed'))
  await expect(createWorkspaceBackup()).rejects.toThrow('copy failed')
  const original = marker(), operation = { operationId: original.operationId, kind: 'backup' }
  expect(Object.keys(original).sort()).toEqual(['createdAt', 'operationId'])
  mock.request.mockResolvedValueOnce({ ...operation, state: 'prepared' }).mockResolvedValueOnce(result)
  await expect(createWorkspaceBackup(undefined, () => { throw new Error('download failed') })).rejects.toThrow('download failed')
  expect(marker()).toEqual(original)
  const backups = mock.request.mock.calls.filter(([command]) => command.kind === 'backup')
  expect(backups).toHaveLength(2)
  expect(backups[1][0]).toEqual(backups[0][0])
  mock.request.mockResolvedValueOnce({ ...operation, state: 'committed', receipt: { ...operation, ...result } })
  const deliver = vi.fn()
  const receipt = await createWorkspaceBackup(undefined, deliver)
  expect(receipt.createdAt).toBe(original.createdAt)
  expect(receipt).not.toHaveProperty('operationId')
  expect(deliver).toHaveBeenCalledWith(receipt, true)
  expect(localStorage.getItem(key())).toBeNull()
  mock.request.mockResolvedValueOnce(result)
  await createWorkspaceBackup(undefined, deliver)
  expect(mock.request.mock.lastCall?.[0].operationId).not.toBe(original.operationId)
  expect(deliver).toHaveBeenLastCalledWith(expect.any(Object), false)
})

it('retains recovery on foreign receipts, cancellation or scope change and refuses to POST without a durable marker or lock', async () => {
  vi.stubGlobal('navigator', {})
  await expect(createWorkspaceBackup()).rejects.toThrow('不支持')
  expect(mock.request).not.toHaveBeenCalled()
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, work: () => unknown) => work() } })
  const write = vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => { throw new Error('quota') })
  await expect(createWorkspaceBackup()).rejects.toThrow('quota')
  expect(mock.request).not.toHaveBeenCalled(); write.mockRestore()
  mock.request.mockRejectedValueOnce(new Error('unknown receipt'))
  await expect(createWorkspaceBackup()).rejects.toThrow('unknown receipt')
  const original = marker(), originalKey = key(), operation = { operationId: original.operationId, kind: 'backup' }
  for (const value of [
    { ...operation, operationId: 'foreign', state: 'prepared' },
    { ...operation, kind: 'restoreBackup', state: 'prepared' },
    { ...operation, state: 'committed', receipt: { ...result, ...operation, operationId: 'foreign' } },
  ]) {
    mock.request.mockResolvedValueOnce(value)
    await expect(createWorkspaceBackup()).rejects.toThrow('身份不匹配')
    expect(marker()).toEqual(original)
  }
  const controller = new AbortController(), deliver = vi.fn()
  mock.request.mockImplementationOnce(async () => { controller.abort(); return { ...operation, state: 'prepared' } })
  await expect(createWorkspaceBackup(controller.signal, deliver)).rejects.toMatchObject({ name: 'AbortError' })
  expect(deliver).not.toHaveBeenCalled()
  mock.request.mockImplementationOnce(async () => { mock.workspace.principalId = 'other'; return { ...operation, state: 'prepared' } })
  await expect(createWorkspaceBackup(undefined, deliver)).rejects.toThrow('连接已变化')
  expect(JSON.parse(localStorage.getItem(originalKey)!)).toEqual(original)
  expect(localStorage.getItem(key())).toBeNull()
  mock.request.mockResolvedValueOnce(result)
  await createWorkspaceBackup(undefined, deliver)
  expect(JSON.parse(localStorage.getItem(originalKey)!)).toEqual(original)
  expect(localStorage.getItem(key())).toBeNull()
})

import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { Blob as NodeBlob } from 'node:buffer'
import { webcrypto } from 'node:crypto'
import { putDesktopArtworkImage } from './artworkUpload'
import { PendingMediaUploadError } from '../../application/artwork/mediaUpload'
import { WORKSPACE_MEDIA_PENDING_PREFIX, isRestorableLocalKey } from '../../utils/storageKeys'
import { classifyMigrationKey } from '../web/migrationClassification'

const mock = vi.hoisted(() => ({ workspace: { workspaceId: 'fixture-workspace', principalId: 'fixture-owner' } }))
vi.mock('./runtime.ts', () => ({ getDesktopRuntime: () => ({ bootstrap: { runtime: { workspace: mock.workspace } } }) }))
const blob = (size = 4) => new NodeBlob([new Uint8Array(size)], { type: 'image/png' }) as unknown as Blob
const markers = () => Object.keys(localStorage).filter(key => key.startsWith(WORKSPACE_MEDIA_PENDING_PREFIX))
function fixture() {
  let operation: { operationId: string; kind: string; state: string; media: Record<string, unknown>; receipt?: Record<string, unknown> } | undefined
  const request = vi.fn(async (command: Record<string, any>): Promise<any> => {
    if (command.kind === 'prepareMedia') {
      operation ??= { operationId: command.operationId, kind: 'prepareMedia', state: 'prepared', media: { ...command.media, writtenBytes: 0 } }
      expect(command.operationId).toBe(operation.operationId)
      expect(command.media).toEqual(expect.objectContaining({ alias: operation.media.alias, sha256: operation.media.sha256 }))
      return structuredClone(operation)
    }
    if (command.kind === 'getOperation') return operation ? structuredClone(operation) : null
    expect(command.operationId).toBe(operation!.operationId)
    if (command.kind === 'uploadMediaChunk') {
      expect(command.offset).toBe(operation!.media.writtenBytes)
      operation!.media.writtenBytes = command.offset + command.data.length
      return { operationId: command.operationId, offset: operation!.media.writtenBytes }
    }
    if (command.kind === 'commitMedia') {
      expect(operation!.media.writtenBytes).toBe(operation!.media.bytes)
      operation!.state = 'committed'
      return operation!.receipt = { operationId: command.operationId, kind: 'commitMedia', revision: 1 }
    }
    throw new Error(`Unexpected command ${command.kind}`)
  })
  return { request, original: request.getMockImplementation()!, operation: () => operation! }
}
beforeEach(() => {
  localStorage.clear(); mock.workspace.workspaceId = 'fixture-workspace'; mock.workspace.principalId = 'fixture-owner'
  vi.stubGlobal('crypto', webcrypto)
  const tails = new Map<string, Promise<unknown>>()
  vi.stubGlobal('navigator', { locks: { request: (name: string, _options: unknown, work: () => unknown) => {
    const next = (tails.get(name) ?? Promise.resolve()).then(work)
    tails.set(name, next.catch(() => {})); return next
  } } })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear() })

it('resumes a lost chunk acknowledgement from the durable offset with the same upload identity', async () => {
  const f = fixture(), input = blob(1024 * 1024 + 17)
  let lost = false
  f.request.mockImplementation(async command => {
    const result = await f.original(command)
    if (command.kind === 'uploadMediaChunk' && !lost) { lost = true; throw new Error('chunk reply lost') }
    return result
  })
  const error = await putDesktopArtworkImage(input, f.request).catch(error => error)
  expect(error).toBeInstanceOf(PendingMediaUploadError)
  expect(error.pending).toMatchObject({ operationId: f.operation().operationId, imageId: f.operation().media.alias })
  expect(markers()).toHaveLength(1)
  // A new invocation and Blob (no in-memory closure identity) resume the same operation.
  expect(await putDesktopArtworkImage(blob(input.size), f.request)).toBe(error.pending.imageId)
  const chunks = f.request.mock.calls.map(([c]) => c).filter(c => c.kind === 'uploadMediaChunk')
  expect(chunks.map(c => c.offset)).toEqual([0, 1024 * 1024])
  expect(new Set(f.request.mock.calls.map(([c]) => c.operationId)).size).toBe(1)
  expect(markers()).toEqual([])
})

it('returns the original alias after a committed response is lost, without releasing ownership', async () => {
  const f = fixture()
  f.request.mockImplementation(async command => {
    const result = await f.original(command)
    if (command.kind === 'commitMedia') throw new Error('commit reply lost')
    return result
  })
  expect(await putDesktopArtworkImage(blob(), f.request)).toBe(f.operation().media.alias)
  expect(f.request.mock.calls.map(([c]) => c.kind)).toEqual(['prepareMedia', 'uploadMediaChunk', 'commitMedia', 'getOperation'])
  expect(markers()).toEqual([])
})

it('retains a committed but unreadable outcome and recovers it on a later prepare without reupload', async () => {
  const f = fixture()
  f.request.mockImplementation(async command => {
    if (command.kind === 'getOperation') throw new Error('offline')
    const result = await f.original(command)
    if (command.kind === 'commitMedia') throw new Error('commit reply lost')
    return result
  })
  const error = await putDesktopArtworkImage(blob(), f.request).catch(error => error)
  expect(error).toBeInstanceOf(PendingMediaUploadError)
  const key = markers()[0]!
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ operationId: error.pending.operationId, imageId: error.pending.imageId })
  expect(isRestorableLocalKey(key)).toBe(false)
  expect(classifyMigrationKey('local', key)).toBe('transient')
  f.request.mockImplementation(f.original)
  expect(await putDesktopArtworkImage(blob(), f.request)).toBe(error.pending.imageId)
  expect(f.request.mock.calls.filter(([c]) => c.kind === 'uploadMediaChunk')).toHaveLength(1)
  expect(f.request.mock.calls.filter(([c]) => c.kind === 'commitMedia')).toHaveLength(1)
  expect(markers()).toEqual([])
})

it('retains an accepted prepare with lost response, and retries its original input', async () => {
  const f = fixture()
  f.request.mockImplementation(async command => {
    const result = await f.original(command)
    if (command.kind === 'prepareMedia') throw new Error('prepare reply lost')
    return result
  })
  await expect(putDesktopArtworkImage(blob(), f.request)).rejects.toBeInstanceOf(PendingMediaUploadError)
  f.request.mockImplementation(f.original)
  await putDesktopArtworkImage(blob(), f.request)
  const prepares = f.request.mock.calls.filter(([c]) => c.kind === 'prepareMedia')
  expect(prepares).toHaveLength(2)
  expect(prepares[0]).toEqual(prepares[1])
})

it('gives simultaneous equal-blob callers independent aliases after each successful handoff', async () => {
  const operations = new Map<string, ReturnType<typeof fixture>>()
  const request = vi.fn(async command => {
    if (!operations.has(command.operationId)) operations.set(command.operationId, fixture())
    return operations.get(command.operationId)!.request(command)
  })
  const input = blob()
  const results = await Promise.all([putDesktopArtworkImage(input, request), putDesktopArtworkImage(input, request)])
  expect(new Set(results).size).toBe(2)
  expect(operations.size).toBe(2)
  expect(markers()).toEqual([])
})

it('keeps old identity and makes no requests against a switched principal while an upload is in flight', async () => {
  const f = fixture()
  f.request.mockImplementation(async command => {
    const result = await f.original(command)
    if (command.kind === 'uploadMediaChunk') mock.workspace.principalId = 'other-owner'
    return result
  })
  const error = await putDesktopArtworkImage(blob(), f.request).catch(error => error)
  expect(error).toBeInstanceOf(PendingMediaUploadError)
  expect(error.pending.principalId).toBe('fixture-owner')
  expect(f.request.mock.calls.map(([c]) => c.kind)).toEqual(['prepareMedia', 'uploadMediaChunk'])
  expect(markers()).toHaveLength(1)
  mock.workspace.principalId = 'fixture-owner'
  f.request.mockImplementation(f.original)
  expect(await putDesktopArtworkImage(blob(), f.request)).toBe(error.pending.imageId)
})

it('does not create a runtime lease when its marker cannot be persisted', async () => {
  const f = fixture()
  vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => { throw new Error('quota') })
  await expect(putDesktopArtworkImage(blob(), f.request)).rejects.toThrow('quota')
  expect(f.request).not.toHaveBeenCalled()
})

it('does not trust a receipt for a prepare whose media identity did not validate', async () => {
  const f = fixture()
  f.request.mockImplementation(async command => {
    const result = await f.original(command)
    if (command.kind === 'prepareMedia') {
      f.operation().state = 'committed'
      f.operation().receipt = { kind: 'commitMedia', operationId: command.operationId, revision: 1 }
      result.media.alias = 'wrong-alias'
    }
    return result
  })
  await expect(putDesktopArtworkImage(blob(), f.request)).rejects.toBeInstanceOf(PendingMediaUploadError)
  expect(markers()).toHaveLength(1)
  expect(f.request.mock.calls.map(([c]) => c.kind)).toEqual(['prepareMedia', 'getOperation'])
})

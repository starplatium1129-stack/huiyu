import assert from 'node:assert/strict'
import { afterEach, beforeEach, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ createJob: vi.fn(), getJob: vi.fn(), deleteJob: vi.fn() }))
vi.mock('@/api/generationApi', () => ({ generationApi: api }))
vi.mock('@/utils/runtimeEnvironment', () => ({ isLocalStudioHost: () => false }))
import { useSDGenerate } from './useSDGenerate'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
function imageResponse() {
  return new Response(new Blob(['fixture'], { type: 'image/png' }), { headers: { 'content-type': 'image/png' } })
}
function succeeded(id = 'image') {
  return { job: { id, status: 'succeeded', provider: 'comfy', seed: 0, resultUrl: '/result.png' } }
}
const sessions: ReturnType<typeof useSDGenerate>[] = []
function session() {
  const sd = useSDGenerate()
  sessions.push(sd)
  return sd
}
beforeEach(() => {
  api.createJob.mockReset().mockResolvedValue(succeeded())
  api.getJob.mockReset().mockResolvedValue(succeeded())
  api.deleteJob.mockReset().mockResolvedValue({})
  vi.stubGlobal('fetch', vi.fn(async () => imageResponse()))
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = vi.fn(() => 'blob:fixture')
    static revokeObjectURL = vi.fn()
  })
})
afterEach(() => {
  for (const sd of sessions.splice(0)) sd.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('keeps the displayed result LoRAs during a pending and subsequently failed request', async () => {
  const sd = session()
  await sd.generate({ prompt: 'First image', lora: 'ayachi_nene_v18_wd14:0' })
  const accepted = deferred<ReturnType<typeof succeeded>>()
  api.createJob.mockImplementation(() => accepted.promise)
  const running = sd.generate({ prompt: 'Second image', lora: 'shiki_natsume_v18_wd14:0.7' })
  await vi.waitFor(() => assert.equal(api.createJob.mock.calls.length, 2))
  const pendingLoras = JSON.parse(JSON.stringify(sd.lastLoras.value))
  accepted.resolve({ job: { ...succeeded().job, status: 'failed' } })
  assert.equal(await running, null)
  const expected = [{ id: 'L_NENE_V18_WD14', strength: 0 }]
  assert.deepEqual(pendingLoras, expected)
  assert.deepEqual(JSON.parse(JSON.stringify(sd.lastLoras.value)), expected)
  assert.equal(sd.resultUrl.value, 'blob:fixture')
})

it('replaces LoRA facts only when a new image succeeds', async () => {
  const sd = session()
  await sd.generate({ prompt: 'First image', lora: 'ayachi_nene_v18_wd14:0' })
  await sd.generate({ prompt: 'Second image', lora: 'shiki_natsume_v18_wd14:0.7' })
  assert.deepEqual(JSON.parse(JSON.stringify(sd.lastLoras.value)), [{ id: 'L_NAT_V18_WD14', strength: 0.7 }])
  assert.equal(sd.resultSeed.value, 0)
})

for (const action of ['clear', 'adopt'] as const) {
  it(`${action} does not leave LoRAs belonging to an unrelated image`, async () => {
    const sd = session()
    await sd.generate({ prompt: 'First image', lora: 'ayachi_nene_v18_wd14:0.8' })
    if (action === 'clear') sd.clearResult()
    else sd.adoptResult('blob:external', 10, 'External image')
    assert.equal(sd.lastLoras.value.length, 0)
  })
}

it('does not consume a late image response after cancellation', async () => {
  const response = deferred<Response>()
  const blob = vi.fn(async () => new Blob(['late']))
  vi.stubGlobal('fetch', vi.fn(() => response.promise))
  const sd = session()
  const running = sd.generate({ prompt: 'Late response' })
  await vi.waitFor(() => assert.equal(vi.mocked(fetch).mock.calls.length, 1))
  sd.cancel()
  response.resolve({ ok: true, headers: new Headers({ 'content-type': 'image/png' }), blob } as unknown as Response)
  assert.equal(await running, null)
  assert.equal(blob.mock.calls.length, 0)
  assert.equal(vi.mocked(URL.createObjectURL).mock.calls.length, 0)
  assert.equal(sd.taskState.value, 'cancelled')
})

for (const action of ['cancel', 'dispose'] as const) {
  it(`${action} wins over a late image body without allocating a result URL`, async () => {
    const body = deferred<Blob>()
    const readBody = vi.fn(() => body.promise)
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, headers: new Headers({ 'content-type': 'image/png' }), blob: readBody })))
    const sd = session()
    sd.adoptResult('blob:previous', 10, 'Previous image')
    const running = sd.generate({ prompt: 'Late body' })
    await vi.waitFor(() => assert.equal(readBody.mock.calls.length, 1))
    // Simulate a body that is already buffered and cannot be un-resolved by abort.
    body.resolve(new Blob(['late'], { type: 'image/png' }))
    sd[action]()
    assert.equal(await running, null)
    assert.equal(vi.mocked(URL.createObjectURL).mock.calls.length, 0)
    assert.equal(sd.resultUrl.value, action === 'cancel' ? 'blob:previous' : '')
    assert.equal(sd.taskState.value, 'cancelled')
  })
}

it('does not poll again when cancelled during the poll delay', async () => {
  api.createJob.mockResolvedValue({ job: { id: 'queued', status: 'queued' } })
  const sd = session()
  const running = sd.generate({ prompt: 'Cancel before polling' })
  await vi.waitFor(() => assert.equal(sd.taskState.value, 'queued'))
  sd.cancel()
  assert.equal(await running, null)
  assert.equal(api.getJob.mock.calls.length, 0)
  assert.equal(api.deleteJob.mock.calls[0]?.[0], 'queued')
})

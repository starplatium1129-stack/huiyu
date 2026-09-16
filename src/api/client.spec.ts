import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError, createApiClient, type FetchImplementation } from './client'

function okResponse(value: Record<string, unknown>): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function deferredFetch(handler: (url: string, init: RequestInit | undefined) => Promise<Response>): {
  fetch: FetchImplementation
  calls: string[]
  flush: () => Promise<void>
} {
  const calls: string[] = []
  const pending: Array<() => void> = []
  const fetch: FetchImplementation = (input, init) => {
    calls.push(String(input))
    return new Promise<Response>((resolve, reject) => {
      pending.push(() => {
        handler(String(input), init).then(resolve, reject)
      })
    })
  }
  return {
    fetch,
    calls,
    flush: async () => {
      while (pending.length) pending.shift()!()
      await Promise.resolve()
      await Promise.resolve()
    },
  }
}

describe('apiClient GET inflight 去重与 TTL 缓存', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('同 URL 并发 GET 只发一次底层请求，消费者各自拿到结果', async () => {
    const { fetch, calls, flush } = deferredFetch(async () => okResponse({ ok: true, value: 1 }))
    const client = createApiClient(fetch)

    const first = client.request('/api/shared')
    const second = client.request('/api/shared')
    const third = client.request('/api/shared')
    await flush()

    const [a, b, c] = await Promise.all([first, second, third])
    expect(calls).toEqual(['/api/shared'])
    expect(a).toEqual({ ok: true, value: 1 })
    expect(b).not.toBe(a)
    expect(c).not.toBe(a)
  })

  it('搭车者 abort 只取消自己，不影响共享请求与其他消费者', async () => {
    const { fetch, calls, flush } = deferredFetch(async () => okResponse({ ok: true }))
    const client = createApiClient(fetch)

    const initiator = client.request('/api/ride')
    const controller = new AbortController()
    const rider = client.request('/api/ride', { signal: controller.signal })
    controller.abort() // 共享请求尚未完成

    await expect(rider).rejects.toMatchObject({ kind: 'aborted' })
    await flush()
    await expect(initiator).resolves.toEqual({ ok: true })
    expect(calls).toEqual(['/api/ride'])
  })

  it('发起者取消时仍有跟随者，底层共享请求继续完成', async () => {
    let resolveResponse!: (response: Response) => void
    let transportSignal!: AbortSignal
    const fetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      resolveResponse = resolve
      transportSignal = init!.signal!
      transportSignal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    const client = createApiClient(fetch)
    const ownerController = new AbortController()
    const owner = client.request('/api/shared-owner', { signal: ownerController.signal })
    const follower = client.request('/api/shared-owner')

    ownerController.abort()
    await expect(owner).rejects.toMatchObject({ kind: 'aborted' })
    expect(transportSignal.aborted).toBe(false)

    resolveResponse(okResponse({ ok: true, value: 'follower' }))
    await expect(follower).resolves.toEqual({ ok: true, value: 'follower' })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('取消旧状态请求后立即刷新会新建传输，旧请求清理不会破坏新请求去重', async () => {
    const requests: Array<{ init: RequestInit | undefined; resolve: (response: Response) => void }> = []
    const fetch: FetchImplementation = (_input, init) => new Promise((resolve, reject) => {
      requests.push({ init, resolve })
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })
    const client = createApiClient(fetch)
    const controller = new AbortController()
    const previous = client.request('/api/creative/status', { signal: controller.signal })
    const cancelled = expect(previous).rejects.toMatchObject({ kind: 'aborted' })
    controller.abort()
    const refreshed = client.request('/api/creative/status')
    const refreshedResult = refreshed.catch(error => error)
    await cancelled
    // The previous request has now run finally while its replacement remains pending.
    const follower = client.request('/api/creative/status')
    expect(requests).toHaveLength(2)
    requests[1].resolve(okResponse({ online: true, loras: [{ character: 'natsume' }] }))
    await expect(refreshedResult).resolves.toEqual({ online: true, loras: [{ character: 'natsume' }] })
    await expect(follower).resolves.toEqual({ online: true, loras: [{ character: 'natsume' }] })
  })

  it('失败的共享请求从 inflight 移除，后续 GET 重新发起', async () => {
    let fail = true
    const fetch: FetchImplementation = async () => {
      if (fail) {
        return new Response(JSON.stringify({ ok: false, error: 'boom' }), { status: 500 })
      }
      return okResponse({ ok: true })
    }
    const client = createApiClient(fetch)

    await expect(client.request('/api/flaky')).rejects.toBeInstanceOf(ApiClientError)
    fail = false
    await expect(client.request('/api/flaky')).resolves.toEqual({ ok: true })
  })

  it('显式 cacheTtlMs 的 GET 在 TTL 内命中缓存，过期后重新请求', async () => {
    let counter = 0
    const fetch: FetchImplementation = async () => okResponse({ ok: true, n: ++counter })
    const client = createApiClient(fetch)

    await expect(client.request('/api/static', { cacheTtlMs: 30_000 })).resolves.toEqual({ ok: true, n: 1 })
    await expect(client.request('/api/static', { cacheTtlMs: 30_000 })).resolves.toEqual({ ok: true, n: 1 })

    vi.advanceTimersByTime(30_001)
    await expect(client.request('/api/static', { cacheTtlMs: 30_000 })).resolves.toEqual({ ok: true, n: 2 })
  })

  it('未声明 cacheTtlMs 的 GET 不缓存（任务态端点默认直连）', async () => {
    let counter = 0
    const fetch: FetchImplementation = async () => okResponse({ ok: true, n: ++counter })
    const client = createApiClient(fetch)

    await expect(client.request('/api/job-state')).resolves.toEqual({ ok: true, n: 1 })
    await expect(client.request('/api/job-state')).resolves.toEqual({ ok: true, n: 2 })
  })

  it('写请求成功后失效同 URL 的 GET 缓存', async () => {
    let configured = false
    const fetch: FetchImplementation = async (_url, init) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
        configured = true
        return okResponse({ ok: true, configured: true })
      }
      return okResponse({ ok: true, configured })
    }
    const client = createApiClient(fetch)

    await expect(client.request('/api/config', { cacheTtlMs: 30_000 })).resolves.toEqual({ ok: true, configured: false })
    await expect(client.request('/api/config', { cacheTtlMs: 30_000 })).resolves.toEqual({ ok: true, configured: false })
    await expect(client.request('/api/config', { method: 'POST', body: { host: 'x' } })).resolves.toEqual({ ok: true, configured: true })
    await expect(client.request('/api/config', { cacheTtlMs: 30_000 })).resolves.toEqual({ ok: true, configured: true })
  })
})

/** 2026-09-10 项目复核：R2 消费者校验、R3 响应隔离、R1 写入代际、O1 缓存策略。
 * 以下断言在修复前的实现上必须失败，不能用“请求次数”代替“最终可见状态”。 */
describe('apiClient 每个消费者执行自己的响应契约（R2）', () => {
  it('新请求的校验失败即拒绝（fresh 路径对照）', async () => {
    const client = createApiClient(async () => okResponse({ ok: true, value: 1 }))
    const reject = vi.fn(() => false)

    await expect(client.request('/api/contract', { validate: reject }))
      .rejects.toMatchObject({ kind: 'invalid-response' })
    expect(reject).toHaveBeenCalledTimes(1)
  })

  it('缓存命中仍执行本调用 validate，不因先前的成功缓存而跳过', async () => {
    const fetch = vi.fn(async () => okResponse({ ok: true, value: 1 }))
    const client = createApiClient(fetch)

    await expect(client.request('/api/contract', { cacheTtlMs: 30_000 }))
      .resolves.toEqual({ ok: true, value: 1 })

    const reject = vi.fn(() => false)
    await expect(client.request('/api/contract', { cacheTtlMs: 30_000, validate: reject }))
      .rejects.toMatchObject({ kind: 'invalid-response' })
    expect(reject).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('共享等待的搭车者各自校验，消费者之间互不连带', async () => {
    const { fetch, calls, flush } = deferredFetch(async () => okResponse({ ok: true, value: 1 }))
    const client = createApiClient(fetch)

    const initiator = client.request('/api/shared-contract')
    const reject = vi.fn(() => false)
    const rider = client.request('/api/shared-contract', { validate: reject })
    await flush()

    await expect(initiator).resolves.toEqual({ ok: true, value: 1 })
    await expect(rider).rejects.toMatchObject({ kind: 'invalid-response' })
    expect(reject).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['/api/shared-contract'])
  })
})

describe('apiClient 隔离响应对象（R3）', () => {
  interface NestedPayload {
    ok: boolean
    config: { engine: string; loras: string[] }
  }

  it('缓存响应：调用方改顶层、嵌套对象与数组都不影响缓存与后续消费者', async () => {
    const fetch = vi.fn(async () => okResponse({ ok: true, config: { engine: 'original', loras: ['a'] } }))
    const client = createApiClient(fetch)

    const first = await client.request<NestedPayload>('/api/isolated', { cacheTtlMs: 30_000 })
    first.ok = false
    first.config.engine = 'caller-edited'
    first.config.loras.push('caller-added')

    const second = await client.request<NestedPayload>('/api/isolated', { cacheTtlMs: 30_000 })
    expect(second.ok).toBe(true)
    expect(second.config.engine).toBe('original')
    expect(second.config.loras).toEqual(['a'])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('共享响应：搭车者改动嵌套字段不影响发起者', async () => {
    const { fetch, flush } = deferredFetch(async () =>
      okResponse({ ok: true, config: { engine: 'original', loras: ['a'] } }),
    )
    const client = createApiClient(fetch)

    const initiator = client.request<NestedPayload>('/api/isolated-shared')
    const rider = client.request<NestedPayload>('/api/isolated-shared')
    await flush()

    const riderValue = await rider
    riderValue.config.engine = 'rider-edited'
    const initiatorValue = await initiator
    expect(initiatorValue.config.engine).toBe('original')
  })
})

describe('apiClient 写入代际（R1）', () => {
  it('写成功后迟到的旧 GET 不回填缓存，写后读取不搭乘写前 inflight', async () => {
    const gets: Array<(response: Response) => void> = []
    let configured = false
    const fetch: FetchImplementation = (input, init) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
        configured = true
        return Promise.resolve(okResponse({ ok: true, configured: true }))
      }
      return new Promise<Response>(resolve => {
        gets.push(resolve)
      })
    }
    const client = createApiClient(fetch)

    const stale = client.request('/api/host-config', { cacheTtlMs: 30_000 })
    await expect(client.request('/api/host-config', { method: 'POST', body: { host: 'x' } }))
      .resolves.toEqual({ ok: true, configured: true })

    const afterWrite = client.request('/api/host-config', { cacheTtlMs: 30_000 })
    expect(gets).toHaveLength(2)

    gets[1](okResponse({ ok: true, configured }))
    await expect(afterWrite).resolves.toEqual({ ok: true, configured: true })

    gets[0](okResponse({ ok: true, configured: false }))
    await expect(stale).resolves.toEqual({ ok: true, configured: false })

    await expect(client.request('/api/host-config', { cacheTtlMs: 30_000 }))
      .resolves.toEqual({ ok: true, configured: true })
    expect(gets).toHaveLength(2)
  })

  it('DELETE 成功后迟到旧读不回填，最终读取与服务端一致', async () => {
    const gets: Array<(response: Response) => void> = []
    const fetch: FetchImplementation = (input, init) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'DELETE') {
        return Promise.resolve(okResponse({ ok: true, configured: false }))
      }
      return new Promise<Response>(resolve => {
        gets.push(resolve)
      })
    }
    const client = createApiClient(fetch)

    const stale = client.request('/api/host-config', { cacheTtlMs: 30_000 })
    await expect(client.request('/api/host-config', { method: 'DELETE' }))
      .resolves.toEqual({ ok: true, configured: false })
    gets[0](okResponse({ ok: true, configured: true }))
    await expect(stale).resolves.toEqual({ ok: true, configured: true })

    const fresh = client.request('/api/host-config', { cacheTtlMs: 30_000 })
    expect(gets).toHaveLength(2)
    gets[1](okResponse({ ok: true, configured: false }))
    await expect(fresh).resolves.toEqual({ ok: true, configured: false })
  })
})

describe('apiClient 内存缓存策略（O1）', () => {
  it('HTTP no-store 与内存 TTL 相互独立，no-store 仍可命中内存缓存', async () => {
    let counter = 0
    const fetch = vi.fn(async () => okResponse({ ok: true, n: ++counter }))
    const client = createApiClient(fetch)

    await client.request('/api/policy', { cache: 'no-store', cacheTtlMs: 30_000 })
    await expect(client.request('/api/policy', { cache: 'no-store', cacheTtlMs: 30_000 }))
      .resolves.toEqual({ ok: true, n: 1 })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('cachePolicy: bypass 不读、不写、不登记内存缓存', async () => {
    let counter = 0
    const fetch = vi.fn(async () => okResponse({ ok: true, n: ++counter }))
    const client = createApiClient(fetch)

    await expect(client.request('/api/policy', { cacheTtlMs: 30_000, cachePolicy: 'bypass' }))
      .resolves.toEqual({ ok: true, n: 1 })
    await expect(client.request('/api/policy', { cacheTtlMs: 30_000, cachePolicy: 'bypass' }))
      .resolves.toEqual({ ok: true, n: 2 })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('cachePolicy: refresh 跳过缓存强制新传输，成功后回填', async () => {
    let counter = 0
    const fetch = vi.fn(async () => okResponse({ ok: true, n: ++counter }))
    const client = createApiClient(fetch)

    await expect(client.request('/api/policy', { cacheTtlMs: 30_000 })).resolves.toEqual({ ok: true, n: 1 })
    await expect(client.request('/api/policy', { cacheTtlMs: 30_000 })).resolves.toEqual({ ok: true, n: 1 })
    await expect(client.request('/api/policy', { cacheTtlMs: 30_000, cachePolicy: 'refresh' }))
      .resolves.toEqual({ ok: true, n: 2 })
    await expect(client.request('/api/policy', { cacheTtlMs: 30_000 })).resolves.toEqual({ ok: true, n: 2 })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('cachePolicy: refresh 不搭乘写前 inflight，各自完成', async () => {
    const { fetch, calls, flush } = deferredFetch(async () => okResponse({ ok: true }))
    const client = createApiClient(fetch)

    const pending = client.request('/api/policy')
    const refreshed = client.request('/api/policy', { cachePolicy: 'refresh' })
    await flush()

    expect(calls).toEqual(['/api/policy', '/api/policy'])
    await expect(pending).resolves.toEqual({ ok: true })
    await expect(refreshed).resolves.toEqual({ ok: true })
  })
})


describe('apiClient refresh ordering regression', () => {
  it('refresh results cannot be overwritten by an older same-generation GET', async () => {
    const reads: Array<(response: Response) => void> = []
    const client = createApiClient(() => new Promise<Response>(resolve => reads.push(resolve)))
    const old = client.request('/api/refresh-order', { cacheTtlMs: 30_000 })
    const fresh = client.request('/api/refresh-order', { cacheTtlMs: 30_000, cachePolicy: 'refresh' })
    expect(reads).toHaveLength(2)
    reads[1](okResponse({ revision: 2 }))
    await expect(fresh).resolves.toEqual({ revision: 2 })
    reads[0](okResponse({ revision: 1 }))
    await expect(old).resolves.toEqual({ revision: 1 })
    await expect(client.request('/api/refresh-order')).resolves.toEqual({ revision: 2 })
    expect(reads).toHaveLength(2)
  })

  it('two explicit refreshes retain the latest-started successful result', async () => {
    const reads: Array<(response: Response) => void> = []
    const client = createApiClient(() => new Promise<Response>(resolve => reads.push(resolve)))
    const first = client.request('/api/refresh-pair', { cacheTtlMs: 30_000, cachePolicy: 'refresh' })
    const second = client.request('/api/refresh-pair', { cacheTtlMs: 30_000, cachePolicy: 'refresh' })
    reads[1](okResponse({ revision: 2 }))
    await second
    reads[0](okResponse({ revision: 1 }))
    await first
    await expect(client.request('/api/refresh-pair')).resolves.toEqual({ revision: 2 })
    expect(reads).toHaveLength(2)
  })
})

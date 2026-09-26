import { startDiagnosticRequest } from '../utils/localDiagnostics.ts'

export type ApiClientErrorKind =
  | 'http'
  | 'timeout'
  | 'aborted'
  | 'network'
  | 'invalid-response'

export type ApiResponseObject = Record<string, unknown>

export interface ApiClientErrorOptions {
  kind: ApiClientErrorKind
  status?: number
  code?: string
  detail?: string
  retryAfterSeconds?: number
  responseBody?: ApiResponseObject | null
}

export class ApiClientError extends Error {
  readonly kind: ApiClientErrorKind
  readonly status: number
  readonly code: string | undefined
  readonly detail: string | undefined
  readonly retryAfterSeconds: number | undefined
  readonly responseBody: ApiResponseObject | null

  constructor(message: string, options: ApiClientErrorOptions) {
    super(message)
    this.name = 'ApiClientError'
    this.kind = options.kind
    this.status = options.status ?? 0
    this.code = options.code
    this.detail = options.detail
    this.retryAfterSeconds = options.retryAfterSeconds
    this.responseBody = options.responseBody ?? null
  }
}

export type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

/** 应用内内存缓存策略，与 HTTP `cache` 选项互不影响：
 * `cache: 'no-store'` 只关闭浏览器 HTTP 缓存，不等于绕过内存 TTL（chatApi 正是两者并存）。
 * - `default`：读同 URL 缓存，并可搭车同 URL 进行中的 GET；
 * - `refresh`：跳过缓存并强制新传输（不搭车写前 inflight），成功后回填缓存；
 * - `bypass`：完全不参与内存缓存：不读、不搭车、不登记、不回填。 */
export type ApiCachePolicy = 'default' | 'refresh' | 'bypass'

export interface ApiRequestOptions extends Omit<RequestInit, 'body' | 'signal'> {
  body?: unknown
  signal?: AbortSignal
  timeoutMs?: number
  validate?: (value: ApiResponseObject) => boolean
  /** GET 响应内存缓存时长（毫秒）。默认不缓存（任务态端点必须直连）；
   * 仅准静态配置类端点显式声明。任何写请求成功后自动失效同 URL 缓存并推进代际。 */
  cacheTtlMs?: number
  /** 内存缓存策略，见 ApiCachePolicy。非 GET 或带 body 的请求固定等价于 `bypass`。 */
  cachePolicy?: ApiCachePolicy
}

export interface ApiClient {
  request<T extends object>(url: string, options?: ApiRequestOptions): Promise<T>
}

const DEFAULT_TIMEOUT_MS = 30_000

function isResponseObject(value: unknown): value is ApiResponseObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(value: ApiResponseObject, key: string): string | undefined {
  const field = value[key]
  return typeof field === 'string' && field.trim() ? field.trim() : undefined
}

function retryAfter(value: ApiResponseObject, response: Response): number | undefined {
  const bodyValue = value.retryAfterSeconds
  if (typeof bodyValue === 'number' && Number.isFinite(bodyValue) && bodyValue >= 0) return bodyValue

  const header = response.headers.get('retry-after')?.trim()
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds
  const date = Date.parse(header)
  if (!Number.isFinite(date)) return undefined
  return Math.max(0, Math.ceil((date - Date.now()) / 1000))
}

function invalidResponse(
  status: number,
  detail: string,
  responseBody: ApiResponseObject | null = null,
): ApiClientError {
  return new ApiClientError(`服务器返回了无效响应：${detail}`, {
    kind: 'invalid-response',
    status,
    detail,
    responseBody,
  })
}

function httpFailure(response: Response, body: ApiResponseObject): ApiClientError {
  const detail = stringField(body, 'detail')
  const primary = stringField(body, 'error') || `请求失败（HTTP ${response.status}）`
  return new ApiClientError(detail && detail !== primary ? `${primary}：${detail}` : primary, {
    kind: 'http',
    status: response.status,
    code: stringField(body, 'code'),
    detail,
    retryAfterSeconds: retryAfter(body, response),
    responseBody: body,
  })
}

function explicitFailure(response: Response, body: ApiResponseObject): ApiClientError {
  const detail = stringField(body, 'detail')
  const primary = stringField(body, 'error') || '请求返回了失败状态'
  return new ApiClientError(detail && detail !== primary ? `${primary}：${detail}` : primary, {
    kind: 'http',
    status: response.status,
    code: stringField(body, 'code'),
    detail,
    retryAfterSeconds: retryAfter(body, response),
    responseBody: body,
  })
}

function errorDetail(error: unknown): string | undefined {
  if (error instanceof Error && error.message) return error.message
  const detail = String(error ?? '').trim()
  return detail || undefined
}

const defaultFetch: FetchImplementation = (input, init) => globalThis.fetch(input, init)

const GET_METHOD = 'GET'

/** 请求层消费者隔离（2026-09-10 复核 R3）：响应正文只来自 JSON.parse，
 * 交给缓存或第二个消费者前必须复制，否则调用方改顶层或嵌套字段都会污染其他结果。
 * 序列化回退保证非纯 JSON 结构也不会抛错。 */
function cloneResponse(value: ApiResponseObject): ApiResponseObject {
  const structured = (globalThis as typeof globalThis & {
    structuredClone?: (input: unknown) => unknown
  }).structuredClone
  if (typeof structured === 'function') {
    try {
      return structured(value) as ApiResponseObject
    } catch {
      // 含不可克隆值时退回 JSON 往返
    }
  }
  return JSON.parse(JSON.stringify(value)) as ApiResponseObject
}

/** 每个消费者在自己的传输结果上应用自己的响应契约（2026-09-10 复核 R2）。
 * 共享层只负责传输、解析与通用 HTTP 错误；首个消费者的专属校验不得代表其他消费者。 */
function applyResponseContract<T extends object>(
  value: ApiResponseObject,
  status: number,
  validate: ((value: ApiResponseObject) => boolean) | undefined,
): T {
  if (validate && !validate(value)) {
    throw invalidResponse(status, '响应对象不符合预期格式', value)
  }
  return value as T
}

/** GET 请求并发去重与显式 TTL 缓存（2026-08-28 审计 P1-8）。
 * inflight：同 URL 同代 GET 并发时共享一次底层请求；搭车者的 abort/timeout 只作用于自己。
 * 缓存：仅显式传 cacheTtlMs 的 GET 走内存 TTL 缓存；写请求成功即失效同 URL 缓存并推进代际。 */
interface TransportedResponse {
  /** 传输层解析结果：内存中唯一副本，只用于缓存与共享，不直接交给消费者。 */
  value: ApiResponseObject
  status: number
}

interface CacheEntry extends TransportedResponse {
  expiresAt: number
}

function requestKey(url: string, method: string): string {
  return `${method} ${url}`
}

export function createApiClient(fetchImplementation: FetchImplementation = defaultFetch): ApiClient {
  const responseCache = new Map<string, CacheEntry>()
  interface InflightEntry {
    response: Promise<TransportedResponse>
    controller: AbortController
    generation: number
    consumers: number
    settled: boolean
    cancelled: boolean
  }
  const inflight = new Map<string, InflightEntry>()
  /** 每个 URL 的写入代际（2026-09-10 复核 R1）：写请求成功即自增。
   * 写前发起的 GET 属于旧代，不得回填缓存；写后发起的 GET 属于新代，不得搭乘旧代 inflight。 */
  const generations = new Map<string, number>()
  // Explicit refreshes supersede older reads even without a successful write.
  const readVersions = new Map<string, { version: number; pending: number }>()
  const generationOf = (url: string): number => generations.get(url) ?? 0

  function releaseSharedConsumer(key: string, entry: InflightEntry) {
    if (entry.consumers > 0) entry.consumers -= 1
    if (entry.consumers !== 0 || entry.settled) return
    entry.cancelled = true
    // A refresh may have replaced this map entry; the old transport still
    // needs to be cancelled, but must not delete the replacement.
    if (inflight.get(key) === entry) inflight.delete(key)
    entry.controller.abort()
  }

  function trackSharedConsumer(
    key: string,
    entry: InflightEntry,
    callerSignal: AbortSignal | undefined,
  ): () => void {
    let released = false
    const release = () => {
      if (released) return
      released = true
      releaseSharedConsumer(key, entry)
    }
    if (callerSignal) callerSignal.addEventListener('abort', release, { once: true })
    return () => {
      if (callerSignal) callerSignal.removeEventListener('abort', release)
      release()
    }
  }

  /** 搭车等待：共享响应与调用方自己的 abort/timeout 竞速。
   * 只返回传输结果与取消语义，对象隔离与响应契约由各消费者独立执行。 */
  async function awaitShared(
    shared: Promise<TransportedResponse>,
    callerSignal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<TransportedResponse> {
    let abortListener: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const guard = new Promise<never>((_, reject) => {
      if (callerSignal?.aborted) {
        reject(new ApiClientError('请求已取消', { kind: 'aborted' }))
        return
      }
      if (callerSignal) {
        abortListener = () => reject(new ApiClientError('请求已取消', { kind: 'aborted' }))
        callerSignal.addEventListener('abort', abortListener, { once: true })
      }
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
          reject(
            new ApiClientError(`请求超时（${Math.ceil(timeoutMs / 1000)} 秒）`, { kind: 'timeout' }),
          )
        }, timeoutMs)
      }
    })
    try {
      return await Promise.race([shared, guard])
    } catch (error) {
      if (error instanceof ApiClientError) throw error
      // 最后一个共享消费者离开后，底层可能以原生 AbortError 结束；
      // 其余保持 network 语义，与非共享请求路径一致。
      if ((error as Error)?.name === 'AbortError') {
        throw new ApiClientError('请求已取消', { kind: 'aborted', detail: errorDetail(error) })
      }
      throw new ApiClientError('网络请求失败', { kind: 'network', detail: errorDetail(error) })
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (callerSignal && abortListener) callerSignal.removeEventListener('abort', abortListener)
    }
  }

  const client: ApiClient = {
    async request<T extends object>(url: string, options: ApiRequestOptions = {}): Promise<T> {
      const callerSignal = options.signal
      if (callerSignal?.aborted) {
        throw new ApiClientError('请求已取消', { kind: 'aborted' })
      }

      const headers = new Headers(options.headers)
      const hasBody = options.body !== undefined
      const method = (options.method ?? GET_METHOD).toUpperCase()
      const isCacheableGet = method === GET_METHOD && !hasBody

      const {
        body: _body,
        signal: _signal,
        timeoutMs: _timeoutMs,
        cacheTtlMs: _cacheTtlMs,
        cachePolicy: requestedCachePolicy,
        validate,
        ...requestInit
      } = options

      // 只有 GET 才参与内存缓存；写请求与带 body 的 GET 固定按 bypass 处理。
      const cachePolicy: ApiCachePolicy = isCacheableGet ? requestedCachePolicy ?? 'default' : 'bypass'
      const usesMemoryCache = isCacheableGet && cachePolicy !== 'bypass'
      const joinsInflight = isCacheableGet && cachePolicy === 'default'
      const generation = generationOf(url)
      const key = requestKey(url, method)

      if (joinsInflight) {
        const cached = responseCache.get(url)
        if (cached && cached.expiresAt > Date.now()) {
          // 缓存命中同样要过本调用的校验，且返回独立副本
          return applyResponseContract<T>(cloneResponse(cached.value), cached.status, validate)
        }
        if (cached) responseCache.delete(url)

        // 写后读取不得搭乘写前 inflight：仅同代请求共享传输
        const pending = inflight.get(key)
        if (pending && !pending.controller.signal.aborted && pending.generation === generation) {
          pending.consumers += 1
          const release = trackSharedConsumer(key, pending, callerSignal)
          try {
            const transported = await awaitShared(
              pending.response,
              callerSignal,
              options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            )
            return applyResponseContract<T>(
              cloneResponse(transported.value),
              transported.status,
              validate,
            )
          } finally {
            release()
          }
        }
      }

      let serializedBody: string | undefined
      if (hasBody) {
        try {
          serializedBody = JSON.stringify(options.body)
        } catch (error) {
          throw new ApiClientError('请求数据无法序列化', {
            kind: 'network',
            detail: errorDetail(error),
          })
        }
        if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
      }

      const controller = new AbortController()
      let abortSource: 'caller' | 'timeout' | null = null
      let timeoutId: ReturnType<typeof setTimeout> | undefined
      let abortFromCaller: (() => void) | undefined
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

      // Shared GETs use awaitShared for each consumer. The underlying
      // controller is aborted only when the last consumer releases it;
      // non-shared requests keep the original one-caller cancellation path.
      if (!usesMemoryCache) {
        abortFromCaller = () => {
          if (abortSource !== null) return
          abortSource = 'caller'
          controller.abort()
        }
        if (callerSignal) callerSignal.addEventListener('abort', abortFromCaller, { once: true })

        if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
          timeoutId = setTimeout(() => {
            if (abortSource !== null) return
            abortSource = 'timeout'
            controller.abort()
          }, timeoutMs)
        }
      }

      // 发起前先占位 inflight：并发到达的同代 GET 在底层 fetch 未完成前即可搭车。
      // 失败的请求同样从 inflight 移除（finally），同 URL 后续请求重新发起。
      let readState = usesMemoryCache ? readVersions.get(url) : undefined
      if (usesMemoryCache && !readState) {
        readState = { version: 0, pending: 0 }
        readVersions.set(url, readState)
      }
      const readVersion = readState ? ++readState.version : 0
      if (readState) readState.pending++
      const entry: InflightEntry = {
        response: Promise.resolve({ value: {}, status: 0 }),
        controller,
        generation,
        consumers: usesMemoryCache ? 1 : 0,
        settled: false,
        cancelled: false,
      }
      const shared: Promise<TransportedResponse> = (async () => {
        try {
          const response = await fetchImplementation(url, {
            ...requestInit,
            headers,
            body: serializedBody,
            signal: controller.signal,
          })

          let text: string
          try {
            text = await response.text()
          } catch (error) {
            if (abortSource !== null) throw error
            throw invalidResponse(response.status, '响应正文未能完整读取')
          }
          if (!text.trim()) throw invalidResponse(response.status, '响应正文为空')

          let parsed: unknown
          try {
            parsed = JSON.parse(text)
          } catch {
            throw invalidResponse(response.status, '响应正文不是完整、有效的 JSON')
          }
          if (!isResponseObject(parsed)) {
            throw invalidResponse(response.status, 'JSON 顶层必须是对象')
          }

          if (!response.ok) throw httpFailure(response, parsed)
          if (parsed.ok === false) {
            throw explicitFailure(response, parsed)
          }
          // 共享层到此为止：调用者的 validate 由各消费者在副本上分别执行（R2）
          return { value: parsed, status: response.status }
        } finally {
          entry.settled = true
          // A cancelled request may finish after its replacement has started.
          if (inflight.get(key) === entry) inflight.delete(key)
        }
      })()
      entry.response = shared
      if (usesMemoryCache) inflight.set(key, entry)
      const release = usesMemoryCache ? trackSharedConsumer(key, entry, callerSignal) : undefined

      try {
        const transported = await (usesMemoryCache
          ? awaitShared(shared, callerSignal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
          : shared)
        if (usesMemoryCache) {
          const ttl = options.cacheTtlMs
          // 写入期间该 URL 已被作废的旧代读取不回填（R1）；同代并发时只允许最新一次读取
          // 动缓存，避免晚到的旧刷新覆盖或作废新结果。
          const superseded = entry.cancelled
            || generation !== generationOf(url)
            || readVersion !== readState?.version
          if (!superseded && typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0) {
            responseCache.set(url, {
              value: transported.value,
              status: transported.status,
              expiresAt: Date.now() + ttl,
            })
          } else if (!superseded && cachePolicy === 'refresh') {
            // 显式刷新成功后不得再让旧缓存服务后续读取：本次未声明 TTL 时也要作废旧条目
            responseCache.delete(url)
          }
        } else if (!isCacheableGet) {
          // 写请求成功即推进代际并失效同 URL 缓存，防止 saveHostConfig 之后再读到旧配置
          generations.set(url, generationOf(url) + 1)
          responseCache.delete(url)
        }
        // 参与内存缓存／共享的 GET 结果必须隔离后再交给消费者；其余请求结果仅本调用持有
        const value = usesMemoryCache ? cloneResponse(transported.value) : transported.value
        return applyResponseContract<T>(value, transported.status, validate)
      } catch (error) {
        if (error instanceof ApiClientError) throw error
        if (abortSource === 'caller') {
          throw new ApiClientError('请求已取消', { kind: 'aborted', detail: errorDetail(error) })
        }
        if (abortSource === 'timeout') {
          throw new ApiClientError(`请求超时（${Math.ceil(timeoutMs / 1000)} 秒）`, {
            kind: 'timeout',
            detail: errorDetail(error),
          })
        }
        throw new ApiClientError('网络请求失败', {
          kind: 'network',
          detail: errorDetail(error),
        })
      } finally {
        if (readState && --readState.pending === 0 && readVersions.get(url) === readState) {
          readVersions.delete(url)
        }
        if (timeoutId !== undefined) clearTimeout(timeoutId)
        if (callerSignal && abortFromCaller) callerSignal.removeEventListener('abort', abortFromCaller)
        release?.()
      }
    },
  }
  return {
    async request<T extends object>(url: string, options: ApiRequestOptions = {}): Promise<T> {
      const finish = startDiagnosticRequest(url, options.method)
      try {
        const result = await client.request<T>(url, options)
        finish('succeeded')
        return result
      } catch (error) {
        const kind = error instanceof ApiClientError ? error.kind : 'network'
        finish(kind === 'aborted' ? 'cancelled' : kind === 'timeout' ? 'timeout' : 'failed', error instanceof ApiClientError ? error.status : undefined)
        throw error
      }
    },
  }
}

let runtimeClient = createApiClient()
let runtimeGeneration = 0

/** Rebuild the existing cache/consumer-cancellation client when host identity
 * changes. An old response cannot reach either the new cache or its caller. */
export function configureApiTransport(fetchImplementation?: FetchImplementation): void {
  runtimeGeneration += 1
  runtimeClient = createApiClient(fetchImplementation)
}
export const apiClient: ApiClient = {
  async request<T extends object>(url: string, options?: ApiRequestOptions): Promise<T> {
    const generation = runtimeGeneration
    const result = await runtimeClient.request<T>(url, options)
    if (generation !== runtimeGeneration) throw new ApiClientError('运行时连接已更新，请重新读取', { kind: 'aborted', code: 'RUNTIME_EPOCH_CHANGED' })
    return result
  },
}

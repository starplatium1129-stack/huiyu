type ApiClientErrorKind =
  | 'http'
  | 'timeout'
  | 'aborted'
  | 'network'
  | 'invalid-response'

export type ApiResponseObject = Record<string, unknown>

interface ApiClientErrorOptions {
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

function httpFailure(response: Response, body: ApiResponseObject | null = null): ApiClientError {
  const fields = body ?? {}
  const detail = stringField(fields, 'detail')
  const fallback = response.ok ? '请求返回了失败状态' : `请求失败（HTTP ${response.status}）`
  const primary = stringField(fields, 'error') || fallback
  return new ApiClientError(detail && detail !== primary ? `${primary}：${detail}` : primary, {
    // An unstructured 4xx does not establish whether a write was admitted.
    kind: body || response.status >= 500 ? 'http' : 'invalid-response',
    status: response.status,
    code: stringField(fields, 'code'),
    detail,
    retryAfterSeconds: retryAfter(fields, response),
    responseBody: body,
  })
}

export async function readResponse(response: Response, signal: AbortSignal): Promise<ApiResponseObject> {
  const invalidBody = (detail: string) => response.ok
    ? invalidResponse(response.status, detail)
    : httpFailure(response)
  let text: string
  try {
    text = await response.text()
  } catch {
    signal.throwIfAborted()
    throw invalidBody('响应正文未能完整读取')
  }
  signal.throwIfAborted()
  if (!text.trim()) throw invalidBody('响应正文为空')

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw invalidBody('响应正文不是完整、有效的 JSON')
  }
  if (!isResponseObject(parsed)) throw invalidBody('JSON 顶层必须是对象')
  if (!response.ok || parsed.ok === false) throw httpFailure(response, parsed)
  return parsed
}

export function errorDetail(error: unknown): string | undefined {
  if (error instanceof Error && error.message) return error.message
  const detail = String(error ?? '').trim()
  return detail || undefined
}

/** 每个消费者在自己的传输结果上应用自己的响应契约（2026-09-10 复核 R2）。
 * 共享层只负责传输、解析与通用 HTTP 错误；首个消费者的专属校验不得代表其他消费者。 */
export function applyResponseContract<T extends object>(
  value: ApiResponseObject,
  status: number,
  validate: ((value: ApiResponseObject) => boolean) | undefined,
): T {
  if (validate && !validate(value)) {
    throw invalidResponse(status, '响应对象不符合预期格式', value)
  }
  return value as T
}

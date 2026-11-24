import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIPv4 } from 'node:net'
import { randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import pkg from './package.json' with { type: 'json' }

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function requestKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) {
    throw new Error('任务编号须为 1–160 个字母、数字、下划线或连字符。')
  }
  return value
}

export function uuidKey(value, label = '请求编号') {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error(`${label}须为标准 UUID。`)
  }
  return value
}

export function agentName(value) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,31}$/.test(value ?? '')) throw new Error('助手名须为 1–32 个字母、数字或连字符。')
  return value
}

export function newRequestKey() {
  const agent = process.env.HUIYU_CLI_SCOPE || process.env.HUIYU_CLI_AGENT
  return agent ? `${agentName(agent)}_${randomUUID()}` : randomUUID()
}

function problem(code, message, fields) {
  return Object.assign(new Error(message), { code }, fields)
}

export function connection() {
  const address = process.env.HUIYU_CLI_URL
  const port = process.env.HUIYU_CLI_PORT ?? '3211'
  if (!address && (!/^\d+$/.test(port) || +port < 1 || +port > 65535)) throw problem('CLI_PORT_INVALID', 'HUIYU_CLI_PORT 须为 1–65535。')
  let url
  try { url = new URL(address || `http://127.0.0.1:${port}`) } catch { throw problem('CLI_URL_INVALID', 'HUIYU_CLI_URL 需要完整的绘遇根地址。') }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.port === '0') {
    throw problem('CLI_URL_INVALID', '请填写绘遇根地址，凭据单独放入对应的环境变量。')
  }
  if (url.protocol === 'https:') return { mode: 'relay', endpoint: url.origin }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  const octets = url.hostname.split('.').map(Number)
  const tailnet = isIPv4(url.hostname) && octets[0] === 100 && octets[1] >= 64 && octets[1] < 128
  if (url.protocol !== 'http:' || !(loopback || tailnet)) throw problem('CLI_URL_INVALID', 'HTTP 直连请使用回环地址或 Tailscale IPv4，Muse 中转请使用 HTTPS。')
  return { mode: loopback ? 'local' : 'tailnet', endpoint: url.origin }
}

export function credentialStatus({ mode }) {
  const relay = mode === 'relay'
  const variable = relay ? 'MUSE_TOKEN' : 'HUIYU_CLI_TOKEN'
  const value = process.env[variable]
  const format = relay ? /^[\x21-\x7e]{32,256}$/ : /^[a-fA-F0-9]{64}$/
  return { variable, set: value !== undefined, valid: format.test(value ?? '') }
}

function response(method, path, body, { headers: extraHeaders, signal, publicGuide = false, timeoutMs = 45_000 } = {}) {
  const target = connection()
  const relay = target.mode === 'relay'
  const credentials = credentialStatus(target)
  if (!publicGuide && !credentials.valid) {
    throw problem('CLI_TOKEN_INVALID', relay ? '请把中转的 X-Token 设为 MUSE_TOKEN。' : '请把桌面原生绘图的 64 位连接密钥设为 HUIYU_CLI_TOKEN。')
  }
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\\\r\n]/.test(path)) {
    throw problem('CLI_PATH_INVALID', '接口地址须是当前出图机的相对路径。')
  }
  if (publicGuide && (method !== 'GET' || path !== '/' || body || extraHeaders)) {
    throw problem('CLI_PATH_INVALID', '公开连接说明只支持读取根地址。')
  }
  const headers = { ...extraHeaders, 'User-Agent': `cli-anything-huiyu/${pkg.version}` }
  if (!publicGuide) headers['X-Token'] = process.env[credentials.variable]
  if (body !== undefined) {
    if (!Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json'
    }
    headers['Content-Length'] = Buffer.byteLength(body)
  }
  return new Promise((accept, reject) => {
    const send = relay ? httpsRequest : httpRequest
    // The configured origin owns the credential. Receipt paths and redirects cannot select another host.
    const deadline = AbortSignal.timeout(timeoutMs)
    const req = send(target.endpoint, { path, method, headers, signal: signal ? AbortSignal.any([signal, deadline]) : deadline }, accept)
    req.on('error', reject)
    req.end(body)
  })
}

export async function bytes(res, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of res) {
    size += chunk.length
    if (size > limit) throw new Error('绘遇返回的数据超过了预期大小。')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size)
}

export function retryAfterSeconds(value) {
  if (typeof value !== 'string') return undefined
  if (/^\d{1,8}$/.test(value)) return Number(value)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : undefined
}

export async function exchange(method, path, body, options) {
  let res
  try {
    res = await response(method, path, body, options)
  } catch (error) {
    if (error.code === 'ECONNREFUSED') throw problem(error.code, '无法连接绘遇。请核对目标地址、监听端口及桌面端运行状态。')
    throw error
  }
  if (res.statusCode >= 200 && res.statusCode < 300) return res
  const data = await bytes(res, 64 * 1024)
  let problem
  try { problem = JSON.parse(data) } catch { /* Some status responses have no body. */ }
  const message = problem?.error || problem?.message || (res.statusCode === 401 ? '请核对桌面端的连接密钥。' : res.statusMessage)
  const delay = retryAfterSeconds(res.headers['retry-after'])
  const advertisedDelay = problem?.retryAfterSeconds
  throw Object.assign(new Error(`HTTP ${res.statusCode} · ${message}`), {
    code: problem?.code || `HTTP_${res.statusCode}`, httpStatus: res.statusCode,
    retryAfterSeconds: delay ?? (Number.isSafeInteger(advertisedDelay) && advertisedDelay >= 0 ? advertisedDelay : undefined),
    relayRequestId: res.headers['cf-ray'],
  })
}

export async function api(method, path, payload, options) {
  const body = payload === undefined ? undefined : JSON.stringify(payload)
  const res = await exchange(method, path, body, options)
  const data = await bytes(res, 16 * 1024 * 1024)
  try { return JSON.parse(data.toString('utf8')) }
  catch { throw problem('CLI_RESPONSE_INVALID', '服务未返回完整的 JSON 回执，请核对地址并重查原请求。') }
}

export async function apiRaw(method, path, body, contentType, options = {}) {
  const headers = { ...options.headers, 'Content-Type': contentType }
  const res = await exchange(method, path, body, { ...options, headers })
  const data = await bytes(res, 16 * 1024 * 1024)
  try { return JSON.parse(data.toString('utf8')) }
  catch { throw problem('CLI_RESPONSE_INVALID', '服务未返回完整的 JSON 回执，请核对地址并重查原请求。') }
}

export async function submit(input, explicitKey, batch, overrides) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('请求文件须包含一个 JSON 对象。')
  if (explicitKey !== undefined && input.requestKey !== undefined && explicitKey !== input.requestKey) {
    throw new Error('--key 须与请求文件里的 requestKey 一致。')
  }
  const key = requestKey(explicitKey ?? input.requestKey ?? newRequestKey())
  try {
    const result = await api('POST', batch ? '/api/muse/batches' : '/api/muse/jobs', { ...input, ...overrides, requestKey: key })
    if (result.batchKey !== key) throw new Error('返回的批次编号与提交编号不符。')
    return result
  } catch (error) {
    error.requestKey = key
    throw error
  }
}

export async function readStdin(limit, label) {
  if (process.stdin.isTTY) throw new Error(`${label}需要通过管道传入。`)
  const chunks = []
  let size = 0
  for await (const chunk of process.stdin) {
    size += chunk.length
    if (size > limit) throw new Error(`${label}须不超过 ${limit / 1024} KiB。`)
    chunks.push(chunk)
  }
  return decodeUtf8(Buffer.concat(chunks, size))
}

function decodeUtf8(data) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(data) }
  catch { throw new Error('请求内容需要使用 UTF-8 编码。') }
}

export async function readFileBytes(file, limit, label = '文件') {
  if (typeof file !== 'string' || !file.trim()) throw new Error(`${label}路径不能为空。`)
  const handle = await open(file, 'r')
  try {
    const stat = await handle.stat()
    const sizeText = limit >= 1024 * 1024 ? `${limit / (1024 * 1024)} MiB` : `${limit / 1024} KiB`
    const invalid = () => new Error(`${label}须为不超过 ${sizeText} 的普通文件。`)
    if (!stat.isFile() || stat.size > limit) throw invalid()
    const chunks = []
    let size = 0
    const chunkSize = Math.min(limit + 1, 256 * 1024)
    for (;;) {
      const buffer = Buffer.allocUnsafe(Math.min(chunkSize, limit + 1 - size))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length)
      if (!bytesRead) return Buffer.concat(chunks, size)
      size += bytesRead
      if (size > limit) throw invalid()
      chunks.push(bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead))
    }
  } finally {
    await handle.close()
  }
}

export async function readInput(file, batch) {
  const limit = (batch ? 256 : 64) * 1024
  if (file === '-') return JSON.parse(await readStdin(limit, 'JSON 请求'))
  const data = await readFileBytes(file, limit, 'JSON 请求')
  return JSON.parse(decodeUtf8(data))
}

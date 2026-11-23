import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIPv4 } from 'node:net'
import { createHash, randomUUID } from 'node:crypto'
import { link, open, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import pkg from './package.json' with { type: 'json' }

const MAX_PNG = 32 * 1024 * 1024
const PNG_HEADER = Buffer.from('89504e470d0a1a0a', 'hex')
const RESULT_PATH = /^\/api\/(?:anima|moss|creative|qwen)\/jobs\/[a-f0-9]{32}\/result$/

export function requestKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) {
    throw new Error('任务编号须为 1–160 个字母、数字、下划线或连字符。')
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

function response(method, path, body) {
  const { mode, endpoint } = connection()
  const relay = mode === 'relay'
  const token = relay ? process.env.MUSE_TOKEN : process.env.HUIYU_CLI_TOKEN
  if (relay ? !/^[\x21-\x7e]{32,256}$/.test(token ?? '') : !/^[a-fA-F0-9]{64}$/.test(token ?? '')) {
    throw problem('CLI_TOKEN_INVALID', relay ? '请把中转的 X-Token 设为 MUSE_TOKEN。' : '请把桌面原生绘图的 64 位连接密钥设为 HUIYU_CLI_TOKEN。')
  }
  const headers = { 'X-Token': token, 'User-Agent': `cli-anything-huiyu/${pkg.version}` }
  if (body) {
    headers['Content-Type'] = 'application/json'
    headers['Content-Length'] = Buffer.byteLength(body)
  }
  return new Promise((accept, reject) => {
    const send = relay ? httpsRequest : httpRequest
    // The configured origin owns the credential. Receipt paths and redirects cannot select another host.
    const req = send(endpoint, { path, method, headers, signal: AbortSignal.timeout(45_000) }, accept)
    req.on('error', reject)
    req.end(body)
  })
}

async function bytes(res, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of res) {
    size += chunk.length
    if (size > limit) throw new Error('绘遇返回的数据超过了预期大小。')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size)
}

async function exchange(method, path, body) {
  let res
  try {
    res = await response(method, path, body)
  } catch (error) {
    if (error.code === 'ECONNREFUSED') throw problem(error.code, '无法连接绘遇。请核对目标地址、监听端口及桌面端运行状态。')
    throw error
  }
  if (res.statusCode >= 200 && res.statusCode < 300) return res
  const data = await bytes(res, 64 * 1024)
  let problem
  try { problem = JSON.parse(data) } catch { /* Some status responses have no body. */ }
  const message = problem?.error || problem?.message || (res.statusCode === 401 ? '请核对桌面端的连接密钥。' : res.statusMessage)
  const delay = res.headers['retry-after']
  throw Object.assign(new Error(`HTTP ${res.statusCode} · ${message}`), {
    code: problem?.code || `HTTP_${res.statusCode}`, httpStatus: res.statusCode,
    retryAfterSeconds: /^\d{1,8}$/.test(delay ?? '') ? Number(delay) : undefined,
    relayRequestId: res.headers['cf-ray'],
  })
}

export async function api(method, path, payload) {
  const res = await exchange(method, path, payload && JSON.stringify(payload))
  const data = await bytes(res, 16 * 1024 * 1024)
  try { return JSON.parse(data.toString('utf8')) }
  catch { throw problem('CLI_RESPONSE_INVALID', '服务未返回完整的 JSON 回执，请核对地址并重查原请求。') }
}

export async function submit(input, explicitKey, batch) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('请求文件须包含一个 JSON 对象。')
  if (explicitKey !== undefined && input.requestKey !== undefined && explicitKey !== input.requestKey) {
    throw new Error('--key 须与请求文件里的 requestKey 一致。')
  }
  const key = requestKey(explicitKey ?? input.requestKey ?? newRequestKey())
  try {
    const result = await api('POST', batch ? '/api/muse/batches' : '/api/muse/jobs', { ...input, requestKey: key })
    if (result.batchKey !== key) throw new Error('返回的批次编号与提交编号不符。')
    return result
  } catch (error) {
    error.requestKey = key
    throw error
  }
}

export async function readInput(file, batch) {
  const limit = (batch ? 256 : 64) * 1024
  const handle = await open(file, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > limit) throw new Error(`请求须为不超过 ${limit / 1024} KiB 的 JSON 文件。`)
    return JSON.parse((await handle.readFile('utf8')).replace(/^\uFEFF/, ''))
  } finally {
    await handle.close()
  }
}

export async function saveOriginal(receipt, itemNumber, filename) {
  const item = receipt.items?.[itemNumber - 1]
  if (!item) throw new Error('批次中没有这一张图，请用 job 查看各项。')
  if (item.resultAvailable !== true) {
    throw problem(item.code || 'RESULT_UNAVAILABLE', item.error || `原图还不可用，任务状态为 ${item.status}。`, { deliveryStatus: item.deliveryStatus })
  }
  const { resultUrl, resultBytes, resultSha256 } = item
  if (typeof resultUrl !== 'string' || !RESULT_PATH.test(resultUrl) || !Number.isSafeInteger(resultBytes)
      || resultBytes < PNG_HEADER.length || resultBytes > MAX_PNG || !/^[0-9a-f]{64}$/.test(resultSha256)) {
    throw problem('RESULT_RECEIPT_INVALID', '原图回执的地址、大小或 SHA-256 无效。')
  }
  const res = await exchange('GET', resultUrl)
  if (res.statusCode !== 200 || res.headers['content-type']?.split(';')[0] !== 'image/png') {
    res.destroy()
    throw new Error('绘遇未返回完整的 PNG 原图。')
  }
  const data = await bytes(res, resultBytes)
  if (data.length !== resultBytes || !data.subarray(0, PNG_HEADER.length).equals(PNG_HEADER)
      || createHash('sha256').update(data).digest('hex') !== resultSha256) {
    throw problem('RESULT_INTEGRITY_MISMATCH', '原图与回执不一致，请重新查询任务后取图。')
  }
  const path = resolve(filename)
  const temp = join(dirname(path), `.huiyu-${randomUUID()}.tmp`)
  const output = await open(temp, 'wx')
  try {
    try {
      await output.writeFile(data)
    } finally {
      await output.close()
    }
    // Publish only complete bytes. Concurrent saves never replace another file.
    try {
      await link(temp, path)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const existing = await open(path, 'r')
      try {
        const stat = await existing.stat()
        if (!stat.isFile() || stat.size !== data.length || !(await existing.readFile()).equals(data)) {
          throw problem('OUTPUT_EXISTS', `目标文件已存在且内容不同：${path}`)
        }
      } finally {
        await existing.close()
      }
    }
  } finally {
    await unlink(temp)
  }
  return { path, bytes: resultBytes, sha256: resultSha256, batchKey: receipt.batchKey, item: itemNumber }
}

import { setTimeout as delay } from 'node:timers/promises'
import { bytes, connection, exchange, requestKey, retryAfterSeconds } from './muse.mjs'

const STOPPED = new Set(['failed', 'cancelled', 'interrupted'])
const DELIVERY_STOPPED = new Set(['expired', 'storageFull', 'integrityError', 'invalidReceipt'])
const DELIVERY_PENDING = new Set(['onDemand', 'transferring'])
const FAMILY_ROUTE = new Map([['anima', 'anima'], ['moss-image', 'moss'], ['qwen-image', 'qwen'], ['krea2', 'creative']])
const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504])
const TRANSIENT_ERROR = new Set(['ABORT_ERR', 'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN', 'EPIPE', 'ETIMEDOUT', 'ERR_STREAM_PREMATURE_CLOSE'])

export function isTerminalItem(item) {
  return STOPPED.has(item.status) || DELIVERY_STOPPED.has(item.deliveryStatus)
    || (item.status === 'succeeded' && !DELIVERY_PENDING.has(item.deliveryStatus))
}

function checkedBatch(receipt, key) {
  if (receipt?.batchKey !== key || !Array.isArray(receipt.items) || !receipt.items.length
      || receipt.items.some(item => !item || typeof item !== 'object' || typeof item.status !== 'string')) {
    throw Object.assign(new Error('绘遇未返回与查询编号相符的完整批次回执。'), { code: 'CLI_RESPONSE_INVALID' })
  }
  return receipt
}

async function fetchBatch(key, signal) {
  const res = await exchange('GET', '/api/muse/batches/' + key, undefined, { signal })
  const data = await bytes(res, 16 * 1024 * 1024)
  let receipt
  try { receipt = JSON.parse(data.toString('utf8')) }
  catch { throw Object.assign(new Error('绘遇未返回完整的 JSON 回执。'), { code: 'CLI_RESPONSE_INVALID' }) }
  return { receipt: checkedBatch(receipt, key), retrySeconds: retryAfterSeconds(res.headers['retry-after']) ?? 0 }
}

export async function readBatch(key, { signal } = {}) {
  return (await fetchBatch(requestKey(key), signal)).receipt
}

function isTransient(error) {
  return TRANSIENT_STATUS.has(error.httpStatus) || TRANSIENT_ERROR.has(error.code)
}

function waitTargets(receipt, item) {
  if (item === undefined) return receipt.items.map((row, index) => [row, index + 1])
  const row = receipt.items[item - 1]
  if (!row) throw Object.assign(new Error('批次中没有这一张图，请用 job 核对各项。'), { code: 'MUSE_ITEM_NOT_FOUND' })
  return [[row, item]]
}

function wakePath(pending, mode, batchPath, key) {
  for (const [row, number] of pending) {
    if (mode === 'relay') {
      const path = batchPath + '/original/' + number
      if (row.receivePath === path) return path
    } else {
      const route = FAMILY_ROUTE.get(row.family)
      if (route && row.jobId && typeof row.requestKey === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(row.requestKey)) {
        const requestPath = `/api/${route}/requests/${row.requestKey}`
        if (row.statusPath === batchPath + '/' + row.requestKey || (row.statusPath === requestPath && row.requestKey === key)) {
          return requestPath + '/completion'
        }
      }
    }
  }
}

function nextPollDelay(pending, batchPath) {
  return pending.reduce((seconds, [row]) => {
    const next = row.next
    if (next?.method !== 'GET' || next.path !== batchPath || !Number.isFinite(next.retryAfterSeconds)) return seconds
    return Math.max(seconds, next.retryAfterSeconds)
  }, 0)
}

export async function waitForBatch(key, { item, timeout = 300, interval = 2, initial } = {}) {
  key = requestKey(key)
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout * 1000 > 2_147_483_647) throw new Error('--timeout 需要在 0 到 2147483 秒之间。')
  if (!Number.isFinite(interval) || interval < 2) throw new Error('--interval 至少为 2 秒。')
  if (item !== undefined && (!Number.isSafeInteger(item) || item < 1)) throw new Error('--item 须为从 1 开始的整数。')

  const batchPath = '/api/muse/batches/' + key
  const { mode } = connection()
  const signal = AbortSignal.timeout(Math.ceil(timeout * 1000))
  const due = performance.now() + timeout * 1000
  let snapshot = initial ? checkedBatch(initial, key) : undefined
  let fresh = Boolean(snapshot)
  let canWake = true
  let pollAt = performance.now() + (fresh ? interval * 1000 : 0)

  for (;;) {
    const pending = fresh ? waitTargets(snapshot, item).filter(([row]) => !isTerminalItem(row)) : null
    if (pending?.length === 0) return snapshot
    if (signal.aborted || performance.now() >= due) break
    if (pending) {
      pollAt = Math.max(pollAt, performance.now() + nextPollDelay(pending, batchPath) * 1000)
      const path = canWake && wakePath(pending, mode, batchPath, key)
      if (path) {
        try {
          // The one-byte range signals that relay delivery is ready without downloading the PNG.
          const headers = mode === 'relay' ? { Range: 'bytes=0-0', 'Accept-Encoding': 'identity' } : undefined
          const res = await exchange('GET', path, undefined, { headers, signal })
          const retry = retryAfterSeconds(res.headers['retry-after']) ?? 0
          res.destroy()
          pollAt = Math.max(pollAt, performance.now() + retry * 1000)
        } catch (error) {
          if (signal.aborted) break
          if ([404, 405, 501].includes(error.httpStatus)) canWake = false
          else if ([401, 403].includes(error.httpStatus)) throw error
          // These endpoints only wake the loop. The batch receipt owns all status and delivery state.
          pollAt = Math.max(pollAt, performance.now() + (error.retryAfterSeconds ?? 0) * 1000)
        }
      }
      fresh = false
    }
    try {
      const remaining = due - performance.now()
      const sleep = Math.min(remaining, pollAt - performance.now())
      if (sleep > 0) await delay(Math.ceil(sleep), undefined, { signal })
      if (performance.now() >= due) break
      const result = await fetchBatch(key, signal)
      snapshot = result.receipt
      fresh = true
      pollAt = performance.now() + Math.max(interval, result.retrySeconds) * 1000
    } catch (error) {
      if (signal.aborted) break
      if (!isTransient(error)) throw error
      pollAt = performance.now() + Math.max(interval, error.retryAfterSeconds ?? 0) * 1000
    }
  }
  return { ...(snapshot ?? { batchKey: key, requestKey: key, statusPath: batchPath, items: [] }), timedOut: true }
}

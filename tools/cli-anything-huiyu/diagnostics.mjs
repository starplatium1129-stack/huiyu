import { api, connection } from './muse.mjs'

export async function status() {
  const target = connection()
  if (target.mode === 'relay') {
    const info = await api('GET', '/api/muse/connection')
    if (typeof info?.laptopOnline === 'boolean') {
      return { ...target, reachable: true, connected: info.laptopOnline, lastSeenAt: info.lastSeenAt ?? null }
    }
  } else {
    const guide = await api('GET', '/api/muse/guide')
    if (guide?.protocol === 'huiyu-muse') return { ...target, reachable: true, connected: true, protocol: guide.protocol, version: guide.version }
  }
  throw Object.assign(new Error('接口响应与绘遇协议不符，请核对目标地址。'), { code: 'CLI_PROTOCOL_MISMATCH' })
}

const delivery = {
  expired: '原图已过期，请在出图机检查是否仍有本地副本。',
  integrityError: '中转校验原图失败，请核对出图机的原图和回执。',
  storageFull: '中转存储已满，请检查容量。',
  invalidReceipt: '原图回执缺少有效的大小、地址或校验值。',
}

export function errorsFrom(receipt, { batchKey, agent } = {}) {
  if (!Array.isArray(receipt?.items)) throw Object.assign(new Error('回执缺少任务列表。'), { code: 'CLI_RESPONSE_INVALID' })
  const items = []
  for (const [index, row] of receipt.items.entries()) {
    const key = batchKey ?? row.batchKey
    if (agent && !key?.startsWith(agent + '_')) continue
    const context = { batchKey: key, requestKey: row.requestKey, jobId: row.jobId ?? (row.entryType === 'image' ? row.id : undefined),
      item: batchKey ? index + 1 : undefined, modelId: row.modelId, createdAt: row.createdAt ?? receipt.createdAt, statusPath: row.statusPath }
    if ((row.error && row.status !== 'cancelled') || row.failedCount > 0 || ['failed', 'interrupted'].includes(row.status)) {
      items.push({ ...context, stage: 'generation', status: row.status, code: row.code ?? null, failedCount: row.failedCount,
        message: row.error || (row.failedCount ? '此批次含失败项，请按批次编号查询明细。' : '任务已停止，回执没有详细错误信息。') })
    }
    if (Object.hasOwn(delivery, row.deliveryStatus)) {
      items.push({ ...context, stage: 'delivery', status: row.deliveryStatus, code: row.deliveryStatus, message: delivery[row.deliveryStatus] })
    } else if (row.status === 'succeeded' && row.resultAvailable === false && !row.deliveryStatus) {
      items.push({ ...context, stage: 'delivery', status: row.status, code: 'RESULT_UNAVAILABLE', message: '生成已完成，回执显示原图不可用。请核对保留期和出图机上的文件。' })
    }
  }
  return { scope: batchKey ? 'batch' : 'historyPage', batchKey, agent, scanned: receipt.items.length,
    nextBefore: receipt.nextBefore ?? null, items, ...(receipt.relayUpdatedAt ? { relayUpdatedAt: receipt.relayUpdatedAt, laptopOnline: receipt.laptopOnline } : {}) }
}

export function failure(error, command) {
  const code = error.code ?? 'CLI_ERROR'
  let target
  try { target = connection() } catch { /* An invalid address must not be echoed with embedded credentials. */ }
  const retryable = [408, 429, 500, 502, 503, 504].includes(error.httpStatus)
    || ['ABORT_ERR', 'ECONNRESET', 'EPIPE', 'EAI_AGAIN', 'ETIMEDOUT'].includes(code)
  let hint
  if (error.httpStatus === 401 || error.httpStatus === 403 || code === 'CLI_TOKEN_INVALID') hint = '核对当前连接方式和对应密钥后运行 status。'
  else if (code === 'MUSE_BATCH_CONFLICT') hint = '核对原编号的参数。提交不同任务时使用 key 生成新编号。'
  else if (retryable && ['draw', 'batch'].includes(command)) hint = '先用 job 和原请求编号查询。仍需重发时沿用同一编号和请求体。'
  else if (retryable) hint = '按 retryAfterSeconds 退避，再查询同一任务。'
  else if (code === 'MUSE_BATCH_NOT_FOUND') hint = '核对目标出图机和批次编号，用 recent 查询近期回执。'
  else if (command === 'save' && code === 'RESULT_UNAVAILABLE') hint = '用 job 查看是否仍在生成，用 errors 和批次编号检查生成或交付错误。'
  return { ok: false, command, target, code, message: error.message, httpStatus: error.httpStatus, requestKey: error.requestKey, deliveryStatus: error.deliveryStatus,
    retryable, retryAfterSeconds: error.retryAfterSeconds ?? (retryable ? 2 : undefined), relayRequestId: error.relayRequestId, hint }
}

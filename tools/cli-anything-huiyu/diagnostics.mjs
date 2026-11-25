import { api, connection, credentialStatus } from './muse.mjs'

const optionsPath = '/api/muse/options'
const statusPaths = ['anima', 'moss', 'qwen', 'creative'].map(family => `/api/${family}/status`)
const drawingFamilies = ['anima', 'moss-image', 'qwen-image', 'krea2']

export async function guide() {
  const value = await api('GET', '/api/muse/guide')
  if (value?.protocol !== 'huiyu-muse') {
    throw Object.assign(new Error('接口响应与绘遇协议不符，请核对目标地址。'), { code: 'CLI_PROTOCOL_MISMATCH' })
  }
  return value
}

function relayStorage(storage) {
  const counts = ['usedBytes', 'maxBytes', 'readyFiles', 'transferringFiles']
  if (!storage || !counts.every(key => Number.isSafeInteger(storage[key]) && storage[key] >= 0)
      || storage.maxBytes === 0
      || !(storage.oldestExpiresAt === null || Number.isSafeInteger(storage.oldestExpiresAt) && storage.oldestExpiresAt >= 0)) return null
  const { usedBytes, maxBytes, readyFiles, transferringFiles, oldestExpiresAt } = storage
  return { usedBytes, maxBytes, readyFiles, transferringFiles, oldestExpiresAt }
}

function readRelayCapabilities(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (typeof raw.voice !== 'boolean' || typeof raw.modelRead !== 'boolean') return null
  const result = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'boolean') result[key] = value
  }
  return result
}

export async function status() {
  const target = connection()
  if (target.mode === 'relay') {
    const info = await api('GET', '/api/muse/connection')
    if (typeof info?.laptopOnline === 'boolean') {
      return { ...target, reachable: true, connected: info.laptopOnline, lastSeenAt: info.lastSeenAt ?? null,
        storage: relayStorage(info.storage),
        relayCapabilities: readRelayCapabilities(info.capabilities) }
    }
  } else {
    const info = await guide()
    return { ...target, reachable: true, connected: true, protocol: info.protocol, version: info.version }
  }
  throw Object.assign(new Error('接口响应与绘遇协议不符，请核对目标地址。'), { code: 'CLI_PROTOCOL_MISMATCH' })
}

function probeError(error) {
  if (Number.isInteger(error.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599) {
    return { code: `HTTP_${error.httpStatus}`, httpStatus: error.httpStatus }
  }
  const codes = ['CLI_PORT_INVALID', 'CLI_URL_INVALID', 'CLI_PROTOCOL_MISMATCH', 'CLI_RESPONSE_INVALID',
    'ECONNREFUSED', 'ECONNRESET', 'ABORT_ERR', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN']
  return { code: codes.includes(error.code) ? error.code : 'CLI_CONNECTION_ERROR' }
}

export async function models({ modelId, character } = {}) {
  const query = new URLSearchParams()
  for (const [name, value] of Object.entries({ modelId, character })) {
    if (value === undefined) continue
    if (typeof value !== 'string' || !value.trim() || [...value].length > 160 || /\p{Cc}/u.test(value)) {
      throw new Error(`${name} 须为 1–160 字且不含控制字符。`)
    }
    query.set(name, value.trim())
  }
  try {
    const value = await api('GET', query.size ? `${optionsPath}?${query}` : optionsPath)
    if (!Array.isArray(value?.models)) {
      throw Object.assign(new Error('模型接口缺少模型列表。'), { code: 'CLI_RESPONSE_INVALID' })
    }
    return value
  } catch (error) {
    if (error.httpStatus !== 404) throw error
  }
  return legacyModels(query.get('modelId'), query.get('character'))
}

function uniqueRows(sources, field) {
  const rows = new Map()
  for (const source of sources) {
    for (const row of Array.isArray(source[field]) ? source[field] : []) {
      if (typeof row?.id === 'string' && (!rows.has(row.id) || row.available === true)) rows.set(row.id, row)
    }
  }
  return [...rows.values()]
}

async function legacyModels(modelId, character) {
  const outcomes = await Promise.allSettled([guide(), ...statusPaths.map(path => api('GET', path))])
  const [description, ...statuses] = outcomes.map(result => result.status === 'fulfilled' ? result.value : null)
  const sources = statuses.filter(value => Array.isArray(value?.models))
  const sceneModels = Array.isArray(description?.sceneModels) ? description.sceneModels : []
  const rows = uniqueRows(sources, 'models').filter(model => drawingFamilies.includes(model.family))
  const selected = rows.filter(model => modelId ? model.id === modelId : model.available === true)
  const models = selected.map(model => ({
    id: model.id, label: model.label, family: model.family, available: model.available ?? null,
    catalogRecipes: description ? sceneModels.includes(model.id) : null,
    sizes: model.sizes, sizeLimits: model.capabilities?.customSize ?? null,
    defaultSize: model.family === 'qwen-image' ? '1024x1024' : model.sizes?.[0] ?? null,
    defaults: model.defaults, negative: model.capabilities?.negative, teaCache: model.capabilities?.teaCache,
    hiresUpscalers: model.capabilities?.hiresUpscalers, mossErSde: model.mossErSde,
    mossAcceleration: model.mossAcceleration, mossAdaptiveSpectrum: model.mossAdaptiveSpectrum,
    mossSpectrumFlexWindow: model.mossSpectrumFlexWindow,
  }))
  for (const id of sceneModels) {
    if (typeof id === 'string' && (!modelId || modelId === id) && !rows.some(model => model.id === id)) {
      models.push({ id, available: null, catalogRecipes: true })
    }
  }
  const alias = character === '宁宁' ? 'nene' : character === '夏目' ? 'natsume' : character
  const binding = alias && uniqueRows(sources, 'characters').find(entry => entry.id === alias || entry.label === alias)
  const characterId = binding?.id ?? alias
  const loras = uniqueRows(sources, 'loras').filter(lora => lora.available === true
    && (!modelId || lora.compatibleModels?.includes(modelId))
    && (!characterId || lora.character === characterId || lora.characters?.includes(characterId)))
  const defaultLora = binding && loras.find(lora => lora.id === binding.loraId)
  const styleLoras = !modelId || selected.some(model => model.family === 'krea2')
    ? uniqueRows(sources, 'styleLoras').filter(lora => lora.available === true) : []
  const upscalers = sources.map(source => source.capabilities?.hiresUpscalers).find(Array.isArray)
    ?? rows.map(model => model.capabilities?.hiresUpscalers).find(choices => Array.isArray(choices) && choices.length)
  const missingSources = ['/api/muse/guide', ...statusPaths].flatMap((path, index) => {
    const outcome = outcomes[index]
    if (outcome.status === 'rejected') return [{ path, ...probeError(outcome.reason) }]
    if (index > 0 && !Array.isArray(outcome.value?.models)) return [{ path, code: 'CLI_RESPONSE_INVALID' }]
    return []
  })
  return { source: 'legacy', available: sources.length ? sources.some(source => source.online === true) : null,
    defaultModelId: sceneModels[0] ?? null, models, missingSources,
    characterDefaultLora: defaultLora ? { character: binding.id, loraId: defaultLora.id, compatibleModels: defaultLora.compatibleModels } : null,
    loras, styleLoras, installedUpscalers: { ultrasharp: upscalers?.includes('4x-UltraSharp') ?? null, remacri: upscalers?.includes('Remacri') ?? null },
    upscale: description?.upscale ?? null, teaCache: description?.teaCache ?? null, moss: description?.moss ?? null }
}

export async function doctor() {
  const result = { mode: null, endpoint: null, credentials: null, reachable: null, connected: null,
    protocol: null, version: null,
    capabilities: {
      teaCache: null, upscale: null, standaloneUpscale: null, moss: null, multiCast: null, drawPreview: null, options: null,
      health: null, video: null, videoH3Dwd: null, videoBatch: null,
      interrogate: null, voice: null, qq: null, desktopChat: null, gallery: null,
      partDownload: null, rangeDownload: null,
    } }
  let target
  try {
    target = connection()
  } catch (error) {
    return { ...result, credentials: [credentialStatus({ mode: 'local' }), credentialStatus({ mode: 'relay' })], error: probeError(error) }
  }
  Object.assign(result, target, { credentials: credentialStatus(target) })
  if (target.mode === 'relay') Object.assign(result, { storage: null, relayCapabilities: null })
  if (!result.credentials.valid) {
    result.error = { code: 'CLI_TOKEN_INVALID' }
    try {
      const description = await api('GET', '/', undefined, { publicGuide: true, signal: AbortSignal.timeout(8_000) })
      result.reachable = true
      if (description?.protocol === 'huiyu-muse') {
        describeCapabilities(result, description)
        if (target.mode !== 'relay') result.connected = true
      }
    } catch (error) {
      result.reachable = Boolean(error.httpStatus)
      result.connectionError = probeError(error)
    }
    return result
  }
  try {
    if (target.mode === 'relay') {
      const info = await status()
      result.reachable = info.reachable
      result.connected = info.connected
      result.lastSeenAt = Number.isSafeInteger(info.lastSeenAt) ? info.lastSeenAt : null
      result.storage = info.storage
      result.relayCapabilities = info.relayCapabilities
      if (!result.connected) return result
    }
    const description = await guide()
    result.reachable = true
    result.connected = true
    describeCapabilities(result, description)
    if (result.capabilities.options) {
      try {
        const value = await api('GET', `${optionsPath}?modelId=anima-miaomiao-v1.6`)
        result.capabilities.options = Array.isArray(value?.models)
        if (value?.standaloneUpscale !== undefined) {
          result.capabilities.standaloneUpscale = Boolean(value.standaloneUpscale)
        }
      } catch (error) {
        result.capabilities.options = error.httpStatus === 404 ? false : null
        result.optionsError = probeError(error)
      }
    }
    try {
      const health = await api('GET', '/api/muse/health', undefined, { signal: AbortSignal.timeout(10_000) })
      if (health?.ok === true && health.capabilities && typeof health.capabilities === 'object') {
        result.capabilities.health = true
        for (const key of ['multiCast', 'video', 'videoH3Dwd', 'videoBatch', 'interrogate', 'voice', 'qq', 'desktopChat', 'gallery', 'partDownload', 'rangeDownload']) {
          if (typeof health.capabilities[key] === 'boolean') result.capabilities[key] = health.capabilities[key]
        }
        result.health = { inference: health.inference ?? null, counts: health.counts ?? null }
      } else {
        result.capabilities.health = false
      }
    } catch (error) {
      result.capabilities.health = [404, 405].includes(error.httpStatus) ? false : null
      if (![404, 405].includes(error.httpStatus)) result.healthError = probeError(error)
    }
  } catch (error) {
    result.reachable ??= Boolean(error.httpStatus) || ['CLI_PROTOCOL_MISMATCH', 'CLI_RESPONSE_INVALID'].includes(error.code)
    result.error = probeError(error)
  }
  return result
}

function describeCapabilities(result, description) {
  result.protocol = description.protocol
  result.version = Number.isSafeInteger(description.version) ? description.version : null
  if (result.version !== null) {
    for (const capability of ['teaCache', 'upscale', 'moss']) result.capabilities[capability] = Boolean(description[capability])
    result.capabilities.options = Boolean(description.operations?.options)
    result.capabilities.drawPreview = Boolean(description.operations?.drawPreview)
    if (description.operations?.multiCast) result.capabilities.multiCast = true
  }
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
  else if (code === 'QQ_MUSE_SEND_UNCERTAIN') hint = '请先确认目标会话是否已收到消息，重试务必沿用原 requestKey 和原内容。'
  else if (code === 'VIDEO_UNAVAILABLE') hint = '请检查主力机视频生成引擎配置与运行状态，或运行 health / video status。'
  else if (code === 'VIDEO_INPUT_TOO_LARGE') hint = '中转 Base64 模式素材上限 3 MiB，直连上限 20 MiB，请压缩素材后重试。'
  else if (code === 'GALLERY_ITEM_NOT_FOUND') hint = '请先用 gallery list 核对作品 ID 与 idType。'
  else if (code === 'TASK_INPUT_MISSING' || code === 'TASK_INPUT_FORBIDDEN') hint = '请确认参考图已由当前连接身份通过 upload 上传且未过期。'
  else if (code === 'CAST_CHARACTER_NOT_FOUND') hint = '请先用 catalog --kind character 核对角色 ID（画室角色可用 nene / natsume）。'
  else if (code === 'CAST_OUTFIT_NOT_FOUND' || code === 'CAST_OUTFIT_MISMATCH') hint = '请先用 catalog --kind outfit --character <角色ID> 核对同角色的服装 ID，或省略服装改用默认穿搭。'
  else if (error.httpStatus === 400 && /unknown field [`'"](?:cast|formation|castFormation|interaction|outfitPrompt|bbox)[`'"]/i.test(error.message ?? '')) hint = '当前出图机桌面端版本过旧，尚不支持最新多角色参数（cast/outfitPrompt/interaction/bbox）；请先在出图机更新并重启绘遇桌面端。'
  else if (code === 'INTERROGATE_UNAVAILABLE') hint = '请确认主力机图像反推模型已就绪，可运行 interrogate status 或 health 检查。'
  else if (code === 'NATIVE_UPSCALER_UNAVAILABLE') hint = '请确认主力机已安装 Remacri/UltraSharp 放大权重，可用 models 检查。'
  else if (command === 'save' && code === 'RESULT_UNAVAILABLE') hint = '用 job 查看是否仍在生成，用 errors 和批次编号检查生成或交付错误。'
  return { ok: false, command, target, code, message: error.message, httpStatus: error.httpStatus, requestKey: error.requestKey, deliveryStatus: error.deliveryStatus,
    retryable, retryAfterSeconds: error.retryAfterSeconds ?? (retryable ? 2 : undefined), relayRequestId: error.relayRequestId, hint }
}

import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { api, apiRaw, connection, newRequestKey, readFileBytes, readStdin, requestKey } from './muse.mjs'
import { uploadImage } from './upload.mjs'
import { waitForBatch } from './wait.mjs'
import { saveOriginal } from './download.mjs'

const MAX_RAW_INTERROGATE_BYTES = 20 * 1024 * 1024
const MAX_JSON_IMAGE_BYTES = 8 * 1024 * 1024
const MIN_INTERROGATE_BYTES = 1024
const PNG_HEADER = Buffer.from('89504e470d0a1a0a', 'hex')
const MODES = new Set(['tag', 'caption'])
const SUBJECT_MODES = new Set(['free', 'bound'])
const UPSCALERS = new Set(['remacri', 'ultrasharp'])

export const interrogateCommand = {
  usage: '(status | <图片文件> [--mode tag|caption] [--threshold 0.05-0.95] [--assist] [--subject-mode free|bound] [--layout] [--no-cache] [--transport auto|raw|json] [--key 编号] [--out-json 文件])',
  args: 1,
  about: '查询远程反推状态或对本地图片反推标签/描述与 MOSS 构图布局。传 status 查看可用状态与缓存统计；--layout 需搭配 --assist；默认命中服务端结果缓存，传 --no-cache 强制重算；--out-json 可直接供 draw --from-interrogate 或 --layout-file 衔接。',
  options: ['mode', 'threshold', 'assist', 'subject-mode', 'layout', 'no-cache', 'transport', 'key', 'out-json'],
  booleans: ['assist', 'layout', 'no-cache'],
}

export const upscaleCommand = {
  usage: '(<图片文件> | --image-id 已上传ID) [--upscaler remacri|ultrasharp] [--scale 倍率] [--model 模型ID] [--prompt 文本|-] [--negative 文本] [--hires-denoise 强度] [--hires-steps 步数] [--hires-cfg 值] [--seed 种子] [--source-task 任务ID] [--transport auto|base64|upload] [--key 编号] [--wait] [--timeout 秒] [--out PNG] [--single-connection]',
  minArgs: 0,
  args: 1,
  about: '提交独立图像放大任务（支持 Remacri 纯像素放大与 UltraSharp 放大重绘）。≤8 MiB 本地图片默认 Base64 直传以兼容中转，也可先 upload 后传 --image-id。',
  options: [
    'image-id', 'upscaler', 'scale', 'model', 'prompt', 'negative',
    'hires-denoise', 'hires-steps', 'hires-cfg', 'seed', 'source-task',
    'transport', 'key', 'wait', 'timeout', 'out', 'single-connection',
  ],
  booleans: ['wait', 'single-connection'],
}

function sniffImageMime(buffer) {
  if (buffer.length >= PNG_HEADER.length && buffer.subarray(0, PNG_HEADER.length).equals(PNG_HEADER)) return 'image/png'
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return null
}

function finiteInRange(raw, min, max, label) {
  const value = Number(raw)
  if (!raw.trim() || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} 需要 ${min}–${max} 的数值。`)
  }
  return value
}

function positiveInt(raw, label) {
  if (!/^\d+$/.test(raw)) throw new Error(`${label} 需要正整数。`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} 需要正整数。`)
  return value
}

function nonNegativeInt(raw, label) {
  if (!/^\d+$/.test(raw)) throw new Error(`${label} 需要非负整数。`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) throw new Error(`${label} 需要非负整数。`)
  return value
}

async function writeJsonAtomic(outputPath, value) {
  const target = resolve(outputPath)
  const dir = dirname(target)
  await mkdir(dir, { recursive: true })
  const temporary = join(dir, `.huiyu-json-${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    try {
      await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8')
    } finally {
      await handle.close()
    }
    await rename(temporary, target)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
  return target
}

export async function interrogateStatus() {
  return api('GET', '/api/muse/interrogate/status')
}

export async function interrogateJson(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('反推请求须为 JSON 对象。')
  }
  const key = requestKey(payload.requestKey ?? newRequestKey())
  try {
    return await api('POST', '/api/muse/interrogate', { ...payload, requestKey: key }, { timeoutMs: 180_000 })
  } catch (error) {
    error.requestKey = key
    throw error
  }
}

export async function runInterrogate(options, args) {
  if (args[0] === 'status' && Object.keys(options).length === 0) {
    return interrogateStatus()
  }

  const mode = options.mode
  if (mode !== undefined && !MODES.has(mode)) throw new Error('--mode 须为 tag 或 caption。')
  const threshold = options.threshold === undefined ? undefined : finiteInRange(options.threshold, 0.05, 0.95, '--threshold')
  const assist = Boolean(options.assist)
  const subjectMode = options['subject-mode']
  if (subjectMode !== undefined && !SUBJECT_MODES.has(subjectMode)) {
    throw new Error('--subject-mode 须为 free 或 bound。')
  }
  const layout = Boolean(options.layout)
  const noCache = Boolean(options['no-cache'])
  if (layout && !assist) throw new Error('--layout 需要搭配 --assist 开启视觉协同。')
  if (subjectMode !== undefined && !assist) throw new Error('--subject-mode 需要搭配 --assist 开启视觉协同。')
  if (options['out-json'] !== undefined && !options['out-json'].trim()) {
    throw new Error('--out-json 需要有效的输出 JSON 文件路径。')
  }

  const transport = options.transport ?? 'auto'
  if (!['auto', 'raw', 'json'].includes(transport)) {
    throw new Error('--transport 须为 auto、raw 或 json。')
  }
  const useJson = transport === 'json' || (transport === 'auto' && connection().mode === 'relay')
  const limit = useJson ? MAX_JSON_IMAGE_BYTES : MAX_RAW_INTERROGATE_BYTES
  const data = await readFileBytes(args[0], limit, '反推图片')
  if (data.length < MIN_INTERROGATE_BYTES) {
    throw new Error('图片文件过小（至少 1024 字节）或已损坏。')
  }
  const mimeType = sniffImageMime(data)
  if (!mimeType) {
    throw new Error('仅支持 PNG、JPEG 或 WebP 图片。')
  }

  let result
  if (useJson) {
    const key = requestKey(options.key ?? newRequestKey())
    const body = {
      requestKey: key,
      imageBase64: data.toString('base64'),
      mimeType,
      ...(mode !== undefined && { mode }),
      ...(threshold !== undefined && { threshold }),
      ...(assist && { assist: true }),
      ...(subjectMode !== undefined && { subjectMode }),
      ...(layout && { layout: true }),
      ...(noCache && { noCache: true }),
    }
    result = await interrogateJson(body)
  } else {
    const query = new URLSearchParams()
    if (mode !== undefined) query.set('mode', mode)
    if (threshold !== undefined) query.set('threshold', String(threshold))
    if (assist) query.set('assist', 'true')
    if (subjectMode !== undefined) query.set('subjectMode', subjectMode)
    if (layout) query.set('layout', 'true')
    if (noCache) query.set('noCache', 'true')
    const path = query.size ? `/api/muse/interrogate?${query}` : '/api/muse/interrogate'
    result = await apiRaw('POST', path, data, mimeType, { timeoutMs: 180_000 })
  }

  if (options['out-json'] !== undefined) {
    const savedPath = await writeJsonAtomic(options['out-json'], result)
    return { ...result, savedJsonPath: savedPath }
  }
  return result
}

export async function submitUpscale(payload, explicitKey) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('放大请求须为 JSON 对象。')
  }
  const key = requestKey(explicitKey ?? payload.requestKey ?? newRequestKey())
  try {
    const result = await api('POST', '/api/muse/upscale', { ...payload, requestKey: key }, { timeoutMs: 90_000 })
    if (result.batchKey && result.batchKey !== key) throw new Error('返回的批次编号与提交编号不符。')
    return result
  } catch (error) {
    error.requestKey = key
    throw error
  }
}

export async function runUpscale(options, args, session) {
  const hasFile = args.length > 0
  const hasImageId = options['image-id'] !== undefined
  if (hasFile === hasImageId) {
    throw new Error('请提供本地图片路径或 --image-id 已上传文件名，两者二选一。')
  }
  const output = options.out
  const shouldWait = Boolean(options.wait) || output !== undefined
  if (options.timeout !== undefined && !shouldWait) throw new Error('--timeout 需要搭配 --wait 或 --out。')
  if (options['single-connection'] && output === undefined) throw new Error('--single-connection 需要搭配 --out。')
  if (output !== undefined && (!output.trim() || !/\.png$/i.test(output))) {
    throw new Error('--out 需要 .png 文件路径。')
  }

  const transport = options.transport ?? 'auto'
  if (!['auto', 'base64', 'upload'].includes(transport)) {
    throw new Error('--transport 须为 auto、base64 或 upload。')
  }

  const payload = {}
  if (hasImageId) {
    payload.initImage = options['image-id']
  } else {
    const useUpload = transport === 'upload'
    if (useUpload) {
      payload.initImage = (await uploadImage(args[0], { family: 'anima' })).name
    } else {
      let data
      try {
        data = await readFileBytes(args[0], MAX_JSON_IMAGE_BYTES, '放大图片')
      } catch (error) {
        if (transport === 'base64' || connection().mode === 'relay') throw error
        payload.initImage = (await uploadImage(args[0], { family: 'anima' })).name
      }
      if (data) {
        if (!data.length) throw new Error('图片文件为空。')
        const mimeType = sniffImageMime(data)
        if (!mimeType) throw new Error('放大仅支持 PNG、JPEG 或 WebP 图片。')
        payload.imageBase64 = data.toString('base64')
        payload.mimeType = mimeType
      }
    }
  }

  if (options.upscaler !== undefined) {
    if (!UPSCALERS.has(options.upscaler)) throw new Error('--upscaler 须为 remacri 或 ultrasharp。')
    payload.upscaler = options.upscaler
  }
  if (options.scale !== undefined) {
    payload.scale = finiteInRange(options.scale, 1.1, 3.0, '--scale')
  }
  if (options.model !== undefined) payload.modelId = options.model
  if (options['source-task'] !== undefined) payload.sourceTaskId = options['source-task']
  if (options.prompt !== undefined) {
    payload.prompt = options.prompt === '-' ? await readStdin(64 * 1024, '放大提示词') : options.prompt
  }
  if (options.negative !== undefined) payload.negative = options.negative
  if (options['hires-denoise'] !== undefined) {
    payload.hiresDenoise = finiteInRange(options['hires-denoise'], 0.05, 1.0, '--hires-denoise')
  }
  if (options['hires-steps'] !== undefined) {
    payload.hiresSteps = positiveInt(options['hires-steps'], '--hires-steps')
  }
  if (options['hires-cfg'] !== undefined) {
    payload.hiresCfg = finiteInRange(options['hires-cfg'], 0.1, 30, '--hires-cfg')
  }
  if (options.seed !== undefined) payload.seed = nonNegativeInt(options.seed, '--seed')

  const submitted = await submitUpscale(payload, options.key)
  session.last = submitted.batchKey
  if (!shouldWait) return submitted

  const timeout = options.timeout === undefined ? undefined : positiveInt(options.timeout, '--timeout')
  if (timeout !== undefined && timeout > 2_147_483) throw new Error('--timeout 最多为 2147483 秒。')

  try {
    const receipt = await waitForBatch(submitted.batchKey, { timeout, initial: submitted })
    if (output === undefined) return receipt
    const item = receipt.items?.[0]
    const result = { saved: [], pending: [], failed: [] }
    if (item?.resultAvailable === true) {
      try {
        result.saved.push(await saveOriginal(receipt, 1, output, { singleConnection: Boolean(options['single-connection']) }))
      } catch (error) {
        result.failed.push({ item: 1, status: item.status, code: error.code ?? 'OUTPUT_FAILED', error: error.message })
      }
    } else {
      const bucket = ['failed', 'cancelled', 'interrupted'].includes(item?.status) ? result.failed : result.pending
      bucket.push({ item: 1, status: item?.status, deliveryStatus: item?.deliveryStatus, code: item?.code, error: item?.error })
    }
    return { ...receipt, ...result }
  } catch (error) {
    error.requestKey = submitted.batchKey
    throw error
  }
}

import { api, newRequestKey, readInput, readStdin, requestKey } from './muse.mjs'
import { saveVerifiedMedia } from './download.mjs'
import {
  MAX_BATCH_JSON_BYTES,
  VIDEO_CREATE_TEXT_OPTIONS,
  parseDuration,
  parseNonNegativeInt,
  parsePositiveInt,
  parseWaitInterval,
  parseWaitTimeout,
  readLargeJson,
  saveFromVideoJob,
  validIdOrKey,
  videoCancel,
  videoJob,
  videoPreview,
  videoSave,
  videoStatus,
  videoUpload,
  videoWait,
} from './video-ops.mjs'

export { videoCancel, videoJob, videoPreview, videoSave, videoStatus, videoUpload, videoWait }

export const videoCommand = {
  usage: '<status|preview|upload|create|job|wait|cancel|save|batch|concat|retry> [参数]',
  about: '远程短视频生成、素材上传、分镜批次、拼接与校验下载。',
  subcommands: {
    status: {
      usage: '[--model 模型ID]',
      about: '查询远程视频服务状态、可用模型、队列与限制。',
      options: ['model'],
    },
    preview: {
      usage: '(--file JSON|- | --model 模型ID [参数])',
      about: '预览编译后的视频正向/负向提示词。可传 --file 或命令行参数。',
      options: ['file', 'model', 'mode', 'duration', 'camera', 'motion', 'prompt', 'negative', 'aspect-ratio', 'quality'],
    },
    upload: {
      usage: '<文件> [--kind 类型] [--mode auto|raw|json]',
      args: 1,
      about: '上传视频输入素材（图片/参考图/驱动视频/驱动音频）。直连默认 raw（≤20 MiB），中转自动切 Base64 JSON（≤3 MiB）。',
      options: ['kind', 'mode'],
    },
    create: {
      usage: '(--file JSON|- | --model 模型ID [参数]) [--key 编号] [--wait] [--timeout 秒] [--out 视频文件] [--single-connection]',
      about: '提交单个视频生成任务。支持已上传素材 ID（--image/--last-frame/--ref/--driving-audio/--driving-video）或直接指定本地文件自动上传（--image-file 等）。',
      options: [
        'file', 'prompt', 'duration', 'steps', 'seed', 'ref',
        'image-file', 'last-frame-file', 'ref-file', 'driving-audio-file', 'driving-video-file',
        'key', 'wait', 'timeout', 'out', 'single-connection',
        ...Object.keys(VIDEO_CREATE_TEXT_OPTIONS),
      ],
      booleans: ['wait', 'single-connection'],
      multiple: ['ref', 'ref-file'],
    },
    job: {
      usage: '<任务ID或请求编号> [--by-request] [--batch]',
      args: 1,
      about: '查询单个视频任务或分镜批次状态（默认自动兼容任务 ID 与 requestKey）。',
      options: ['by-request', 'batch'],
      booleans: ['by-request', 'batch'],
    },
    wait: {
      usage: '<任务ID或请求编号> [--by-request] [--batch] [--timeout 秒] [--interval 秒]',
      args: 1,
      about: '等待视频任务或分镜批次结束。默认等待 1800 秒，轮询间隔至少 2 秒。',
      options: ['by-request', 'batch', 'timeout', 'interval'],
      booleans: ['by-request', 'batch'],
    },
    cancel: {
      usage: '<任务ID或请求编号> [--by-request] [--batch]',
      args: 1,
      about: '取消视频任务或分镜批次。',
      options: ['by-request', 'batch'],
      booleans: ['by-request', 'batch'],
    },
    save: {
      usage: '<任务ID或请求编号> <输出文件> [--by-request] [--batch] [--shot 序号] [--single-connection]',
      args: 2,
      about: '校验 SHA-256 并下载视频成片。支持直连 Range 与中转分片自动切换；--batch 可下拼接成片或指定 --shot 1-based 分镜。',
      options: ['by-request', 'batch', 'shot', 'single-connection'],
      booleans: ['by-request', 'batch', 'single-connection'],
    },
    batch: {
      usage: '<批量.json|-> [--key 编号] [--wait] [--timeout 秒] [--concat] [--out 视频文件] [--single-connection]',
      args: 1,
      about: '提交视频分镜批次（JSON 上限 1 MiB）。可选 --wait 等待完成、--concat 自动拼接、--out 下载拼接成片。',
      options: ['key', 'wait', 'timeout', 'concat', 'out', 'single-connection'],
      booleans: ['wait', 'concat', 'single-connection'],
    },
    concat: {
      usage: '<批次ID或请求编号> [--by-request] [--out 视频文件] [--single-connection]',
      args: 1,
      about: '将已完成的视频分镜批次拼接为完整视频，可选 --out 下载。',
      options: ['by-request', 'out', 'single-connection'],
      booleans: ['by-request', 'single-connection'],
    },
    retry: {
      usage: '<批次ID> --shots 1,3 [--key 编号] [--wait] [--timeout 秒]',
      args: 1,
      about: '重试视频分镜批次中失败或已取消的分镜（1-based 序号）。',
      options: ['shots', 'key', 'wait', 'timeout'],
      booleans: ['wait'],
      multiple: ['shots'],
    },
  },
}

export async function videoCreate(options) {
  const output = options.out
  const shouldWait = Boolean(options.wait) || output !== undefined
  if (options.timeout !== undefined && !shouldWait) throw new Error('--timeout 需要搭配 --wait 或 --out。')
  if (options['single-connection'] && output === undefined) throw new Error('--single-connection 需要搭配 --out。')
  if (output !== undefined && !output.trim()) throw new Error('--out 需要有效的输出文件路径。')

  let body = {}
  if (options.file !== undefined) {
    const loaded = await readInput(options.file, false)
    if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) {
      throw new Error('--file 须包含一个 JSON 对象。')
    }
    body = { ...loaded }
  }

  for (const [flag, field] of Object.entries(VIDEO_CREATE_TEXT_OPTIONS)) {
    if (options[flag] !== undefined) body[field] = options[flag]
  }
  if (options.prompt !== undefined) {
    body.prompt = options.prompt === '-' ? await readStdin(32 * 1024, '视频提示词') : options.prompt
  }
  if (options.duration !== undefined) body.duration = parseDuration(options.duration)
  if (options.steps !== undefined) body.steps = parsePositiveInt(options.steps, '--steps')
  if (options.seed !== undefined) body.seed = parseNonNegativeInt(options.seed, '--seed')
  if (options.ref !== undefined) {
    const refs = options.ref.flatMap(value => value.split(',').map(v => v.trim())).filter(Boolean)
    if (refs.length) body.references = [...(Array.isArray(body.references) ? body.references : []), ...refs]
  }

  if (options['image-file'] !== undefined) {
    body.image = (await videoUpload(options['image-file'], { kind: 'image' })).inputId
  }
  if (options['last-frame-file'] !== undefined) {
    body.lastFrame = (await videoUpload(options['last-frame-file'], { kind: 'last-frame' })).inputId
  }
  if (options['driving-audio-file'] !== undefined) {
    body.drivingAudio = (await videoUpload(options['driving-audio-file'], { kind: 'driving-audio' })).inputId
  }
  if (options['driving-video-file'] !== undefined) {
    body.drivingVideo = (await videoUpload(options['driving-video-file'], { kind: 'driving-video' })).inputId
  }
  if (options['ref-file'] !== undefined) {
    const uploadedRefs = []
    for (const refPath of options['ref-file']) {
      uploadedRefs.push((await videoUpload(refPath, { kind: 'reference' })).inputId)
    }
    body.references = [...(Array.isArray(body.references) ? body.references : []), ...uploadedRefs]
  }

  if (options.key !== undefined && body.requestKey !== undefined && options.key !== body.requestKey) {
    throw new Error('--key 须与请求文件里的 requestKey 一致。')
  }
  const key = requestKey(options.key ?? body.requestKey ?? newRequestKey())
  body.requestKey = key

  let submitted
  try {
    submitted = await api('POST', '/api/muse/video/jobs', body)
  } catch (error) {
    error.requestKey = key
    throw error
  }
  if (!shouldWait) return submitted

  try {
    const timeout = parseWaitTimeout(options.timeout, 1800)
    const settled = await videoWait(key, { byRequest: true, batch: false, timeout, initial: submitted })
    if (output === undefined || settled.timedOut) return settled
    const saved = await saveFromVideoJob(settled.job ?? settled, output, Boolean(options['single-connection']))
    return { ...settled, saved }
  } catch (error) {
    error.requestKey = key
    throw error
  }
}

export async function videoConcat(idOrKey, { byRequest = false, out, singleConnection = false } = {}) {
  if (singleConnection && out === undefined) throw new Error('--single-connection 需要搭配 --out。')
  if (out !== undefined && !out.trim()) throw new Error('--out 需要有效的输出文件路径。')
  const target = validIdOrKey(idOrKey)
  let batchId = target
  if (byRequest) {
    const found = await api('GET', `/api/muse/video/batch-requests/${target}`)
    batchId = found?.batch?.id
    if (!batchId) throw new Error('未能从请求编号解析分镜批次 ID。')
  }
  let result
  try {
    result = await api('POST', `/api/muse/video/batches/${batchId}/concat`, undefined, { timeoutMs: 180_000 })
  } catch (error) {
    if (byRequest || error.httpStatus !== 404) throw error
    const found = await api('GET', `/api/muse/video/batch-requests/${target}`)
    batchId = found?.batch?.id
    if (!batchId) throw error
    result = await api('POST', `/api/muse/video/batches/${batchId}/concat`, undefined, { timeoutMs: 180_000 })
  }
  if (out === undefined) return result
  const batchObj = result.batch ?? result
  const saved = await saveVerifiedMedia({
    url: batchObj.concatUrl,
    bytes: batchObj.concatBytes,
    sha256: batchObj.concatSha256,
    mimeType: batchObj.concatMime,
    partBytes: batchObj.partBytes,
    outputPath: out,
    singleConnection,
  })
  return { ...result, saved }
}

export async function videoBatch(options, args) {
  const output = options.out
  const shouldConcat = Boolean(options.concat) || output !== undefined
  const shouldWait = Boolean(options.wait) || shouldConcat
  if (options.timeout !== undefined && !shouldWait) throw new Error('--timeout 需要搭配 --wait、--concat 或 --out。')
  if (options['single-connection'] && output === undefined) throw new Error('--single-connection 需要搭配 --out。')
  if (output !== undefined && !output.trim()) throw new Error('--out 需要有效的输出文件路径。')

  const input = await readLargeJson(args[0], MAX_BATCH_JSON_BYTES, '视频分镜批次 JSON')
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('视频分镜批次文件须包含一个 JSON 对象。')
  }
  if (options.key !== undefined && input.requestKey !== undefined && options.key !== input.requestKey) {
    throw new Error('--key 须与请求文件里的 requestKey 一致。')
  }
  const key = requestKey(options.key ?? input.requestKey ?? newRequestKey())

  let submitted
  try {
    submitted = await api('POST', '/api/muse/video/batches', { ...input, requestKey: key })
  } catch (error) {
    error.requestKey = key
    throw error
  }
  if (!shouldWait) return submitted

  try {
    const timeout = parseWaitTimeout(options.timeout, 3600)
    const settled = await videoWait(key, { byRequest: true, batch: true, timeout, initial: submitted })
    if (!shouldConcat || settled.timedOut || settled.rejected) return settled
    const batchId = settled.batch?.id
    if (!batchId) return settled
    const concatted = settled.batch?.concatAvailable
      ? settled
      : await api('POST', `/api/muse/video/batches/${batchId}/concat`, undefined, { timeoutMs: 180_000 })
    if (output === undefined) return concatted
    const batchObj = concatted.batch ?? concatted
    const saved = await saveVerifiedMedia({
      url: batchObj.concatUrl,
      bytes: batchObj.concatBytes,
      sha256: batchObj.concatSha256,
      mimeType: batchObj.concatMime,
      partBytes: batchObj.partBytes,
      outputPath: output,
      singleConnection: Boolean(options['single-connection']),
    })
    return { ...concatted, saved }
  } catch (error) {
    error.requestKey = key
    throw error
  }
}

export async function videoRetry(options, args) {
  const batchId = validIdOrKey(args[0], '分镜批次 ID')
  if (!options.shots?.length) throw new Error('请使用 --shots 指定要重试的 1-based 分镜序号，例如 --shots 1,3。')
  const indices = [...new Set(
    options.shots.flatMap(value => value.split(',').map(v => parsePositiveInt(v.trim(), '--shots'))),
  )]
  if (options.timeout !== undefined && !options.wait) throw new Error('--timeout 需要搭配 --wait。')
  const key = requestKey(options.key ?? newRequestKey())

  let submitted
  try {
    submitted = await api('POST', `/api/muse/video/batches/${batchId}/retry`, { indices, requestKey: key })
  } catch (error) {
    error.requestKey = key
    throw error
  }
  if (!options.wait) return submitted
  const timeout = parseWaitTimeout(options.timeout, 1800)
  return videoWait(batchId, { byRequest: false, batch: true, timeout, initial: submitted })
}

export async function runVideo(subcommand, options, args) {
  switch (subcommand) {
    case 'status': return videoStatus(options)
    case 'preview': return videoPreview(options)
    case 'upload': return videoUpload(args[0], { kind: options.kind ?? 'image', mode: options.mode ?? 'auto' })
    case 'create': return videoCreate(options)
    case 'job': return videoJob(args[0], { byRequest: Boolean(options['by-request']), batch: Boolean(options.batch) })
    case 'wait': return videoWait(args[0], {
      byRequest: Boolean(options['by-request']),
      batch: Boolean(options.batch),
      timeout: parseWaitTimeout(options.timeout, 1800),
      interval: parseWaitInterval(options.interval, 3),
    })
    case 'cancel': return videoCancel(args[0], { byRequest: Boolean(options['by-request']), batch: Boolean(options.batch) })
    case 'save': return videoSave(args[0], args[1], {
      byRequest: Boolean(options['by-request']),
      batch: Boolean(options.batch),
      shot: options.shot,
      singleConnection: Boolean(options['single-connection']),
    })
    case 'batch': return videoBatch(options, args)
    case 'concat': return videoConcat(args[0], {
      byRequest: Boolean(options['by-request']),
      out: options.out,
      singleConnection: Boolean(options['single-connection']),
    })
    case 'retry': return videoRetry(options, args)
    default: throw new Error(`未知 video 子命令：${subcommand}`)
  }
}

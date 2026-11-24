import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { api, newRequestKey, readStdin, requestKey } from './muse.mjs'

const VOICES = new Set(['nene', 'natsume'])
const EMOTIONS = new Set(['neutral', 'gentle', 'happy', 'shy', 'serious', 'sad'])
const CONSISTENCIES = new Set(['locked', 'adaptive'])
const FORMATS = new Set(['mp3', 'wav'])
const SHA256 = /^[0-9a-f]{64}$/
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

export const voiceCommand = {
  usage: '<status|say> [参数]',
  about: '查询远程语音服务状态或合成角色日语语音。',
  subcommands: {
    status: {
      about: '查看远程语音引擎、声线与格式可用状态。',
    },
    say: {
      usage: '<日语台词|-> [--voice nene|natsume] [--emotion 情绪] [--reference-emotion 情绪] [--consistency locked|adaptive] [--speed 语速] [--format mp3|wav] [--key 编号] [--out 音频文件]',
      args: 1,
      about: '合成日语台词语音并校验字节数与 SHA-256。传 - 从标准输入读取台词；传 --out 解码并保存音频文件。情绪可选 neutral、gentle、happy、shy、serious、sad。',
      options: ['voice', 'emotion', 'reference-emotion', 'consistency', 'speed', 'format', 'key', 'out'],
    },
  },
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

async function writeAtomic(targetPath, data) {
  const dir = dirname(targetPath)
  await mkdir(dir, { recursive: true })
  const temporary = join(dir, `.huiyu-voice-${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    try {
      await handle.writeFile(data)
    } finally {
      await handle.close()
    }
    await rename(temporary, targetPath)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

export async function voiceStatus() {
  return api('GET', '/api/muse/voice/status')
}

export async function voiceSynthesize(payload, explicitKey) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('语音合成参数须为 JSON 对象。')
  }
  const key = requestKey(explicitKey ?? payload.requestKey ?? newRequestKey())
  let receipt
  try {
    receipt = await api('POST', '/api/muse/voice/synthesize', { language: 'ja', ...payload, requestKey: key }, { timeoutMs: 95_000 })
  } catch (error) {
    error.requestKey = key
    throw error
  }
  if (typeof receipt?.data !== 'string' || !receipt.data.length || receipt.data.length % 4 !== 0 || !BASE64.test(receipt.data)
      || !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 1
      || typeof receipt.sha256 !== 'string' || !SHA256.test(receipt.sha256)) {
    throw Object.assign(new Error('语音回执缺少有效的音频数据、字节数或 SHA-256。'), {
      code: 'VOICE_RECEIPT_INVALID', requestKey: key,
    })
  }
  const audio = Buffer.from(receipt.data, 'base64')
  if (audio.length !== receipt.bytes || sha256Hex(audio) !== receipt.sha256) {
    throw Object.assign(new Error('解码后的语音字节数或 SHA-256 与回执不一致。'), {
      code: 'VOICE_INTEGRITY_MISMATCH', requestKey: key,
    })
  }
  return { receipt, audio }
}

export async function voiceSay(options, args) {
  const rawText = args[0] === '-' ? await readStdin(16 * 1024, '日语台词') : args[0]
  const text = rawText.trim()
  const length = [...text].length
  if (length < 1 || length > 500) {
    throw new Error('日语台词长度须为 1–500 字。')
  }

  const payload = { text, language: 'ja' }
  if (options.voice !== undefined) {
    if (!VOICES.has(options.voice)) throw new Error('--voice 须为 nene 或 natsume。')
    payload.voice = options.voice
  }
  if (options.emotion !== undefined) {
    if (!EMOTIONS.has(options.emotion)) throw new Error('--emotion 须为 neutral、gentle、happy、shy、serious 或 sad。')
    payload.emotion = options.emotion
  }
  if (options['reference-emotion'] !== undefined) {
    if (!EMOTIONS.has(options['reference-emotion'])) throw new Error('--reference-emotion 须为 neutral、gentle、happy、shy、serious 或 sad。')
    payload.referenceEmotion = options['reference-emotion']
  }
  if (options.consistency !== undefined) {
    if (!CONSISTENCIES.has(options.consistency)) throw new Error('--consistency 须为 locked 或 adaptive。')
    payload.consistency = options.consistency
  }
  if (options.speed !== undefined) {
    const speed = Number(options.speed)
    if (!options.speed.trim() || !Number.isFinite(speed) || speed < 0.25 || speed > 4.0) {
      throw new Error('--speed 需要 0.25–4.0 的数值。')
    }
    payload.speed = speed
  }
  if (options.format !== undefined) {
    if (!FORMATS.has(options.format)) throw new Error('--format 须为 mp3 或 wav。')
    payload.format = options.format
  }
  if (options.out !== undefined && !options.out.trim()) {
    throw new Error('--out 需要有效的输出音频路径。')
  }

  const { receipt, audio } = await voiceSynthesize(payload, options.key)

  if (options.out !== undefined) {
    const outputPath = resolve(options.out)
    await writeAtomic(outputPath, audio)
    const { data: _data, ...meta } = receipt
    return { ...meta, path: outputPath, verified: true }
  }
  return { ...receipt, verified: true }
}

export async function runVoice(subcommand, options, args) {
  if (subcommand === 'status') return voiceStatus()
  if (subcommand === 'say') return voiceSay(options, args)
  throw new Error(`未知 voice 子命令：${subcommand}`)
}

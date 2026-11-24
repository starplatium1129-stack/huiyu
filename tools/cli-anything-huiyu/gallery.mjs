import { api } from './muse.mjs'
import { saveVerifiedMedia } from './download.mjs'

const GALLERY_KINDS = new Set(['all', 'image', 'video', 'audio'])
const REVIEW_STATES = new Set(['candidate', 'preferred', 'rejected'])
const ID_TYPES = new Set(['string', 'number'])

export const healthCommand = {
  about: '只读查询出图机各模块在线状态、模型数量、推理配置与能力开关。',
}

export const galleryCommand = {
  usage: '<list|show|save> [参数]',
  about: '只读查询桌面作品册清单、作品详情并校验下载原文件。',
  subcommands: {
    list: {
      usage: '[--page 页码] [--page-size 条数] [--kind all|image|video|audio] [--character 角色] [--search 关键词] [--favorite true|false] [--tag 标签] [--engine 引擎] [--model 模型] [--review-state 状态]',
      about: '分页查询作品册列表（每页 1–50 条）。',
      options: ['page', 'page-size', 'kind', 'character', 'search', 'favorite', 'tag', 'engine', 'model', 'review-state'],
    },
    show: {
      usage: '<作品ID> [--id-type string|number]',
      args: 1,
      about: '读取单件作品的完整元数据（含 prompt、negative、SHA-256 与文件大小）。',
      options: ['id-type'],
    },
    save: {
      usage: '<作品ID> <输出文件> [--id-type string|number] [--single-connection]',
      args: 2,
      about: '校验 SHA-256 并下载作品原文件（支持图片/视频/音频，直连 Range 与中转分片自动兼容）。',
      options: ['id-type', 'single-connection'],
      booleans: ['single-connection'],
    },
  },
}

function validGalleryId(raw) {
  if (typeof raw !== 'string' || !raw.trim() || [...raw].length > 256 || /[\p{Cc}\/\\]/u.test(raw) || raw.includes('..')) {
    throw new Error('作品 ID 格式无效。')
  }
  return raw.trim()
}

function validIdType(raw) {
  if (raw === undefined) return undefined
  if (!ID_TYPES.has(raw)) throw new Error('--id-type 须为 string 或 number。')
  return raw
}

function boundedInt(raw, min, max, label) {
  if (!/^\d+$/.test(raw)) throw new Error(`${label} 须为 ${min}–${max} 的整数。`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} 须为 ${min}–${max} 的整数。`)
  }
  return String(value)
}

export async function runHealth() {
  return api('GET', '/api/muse/health')
}

export async function galleryList(options = {}) {
  const query = new URLSearchParams()
  if (options.page !== undefined) query.set('page', boundedInt(options.page, 1, 200, '--page'))
  if (options['page-size'] !== undefined) query.set('pageSize', boundedInt(options['page-size'], 1, 50, '--page-size'))
  if (options.kind !== undefined) {
    const kind = options.kind.trim().toLowerCase()
    if (!GALLERY_KINDS.has(kind)) throw new Error('--kind 须为 all、image、video 或 audio。')
    query.set('kind', kind)
  }
  if (options.favorite !== undefined) {
    const fav = options.favorite.trim().toLowerCase()
    if (!['true', 'false', '1', '0'].includes(fav)) throw new Error('--favorite 须为 true/false 或 1/0。')
    query.set('favorite', fav)
  }
  if (options['review-state'] !== undefined) {
    if (!REVIEW_STATES.has(options['review-state'])) {
      throw new Error('--review-state 须为 candidate、preferred 或 rejected。')
    }
    query.set('reviewState', options['review-state'])
  }
  for (const [flag, max] of [['character', 160], ['search', 200], ['tag', 160], ['engine', 80], ['model', 160]]) {
    if (options[flag] === undefined) continue
    const val = options[flag].trim()
    if ([...val].length > max || /\p{Cc}/u.test(val)) {
      throw new Error(`--${flag} 须不超过 ${max} 字且不含控制字符。`)
    }
    if (val) query.set(flag, val)
  }
  return api('GET', query.size ? `/api/muse/gallery?${query}` : '/api/muse/gallery')
}

export async function galleryShow(id, { idType } = {}) {
  const cleanId = validGalleryId(id)
  const cleanType = validIdType(idType)
  const suffix = cleanType ? `?idType=${cleanType}` : ''
  return api('GET', `/api/muse/gallery/${encodeURIComponent(cleanId)}${suffix}`)
}

export async function gallerySave(id, outputPath, { idType, singleConnection = false } = {}) {
  const detail = await galleryShow(id, { idType })
  const item = detail?.item
  if (!item || item.hasFile !== true || typeof item.fileUrl !== 'string') {
    throw Object.assign(new Error('该作品当前没有可下载的关联原文件。'), { code: 'GALLERY_MEDIA_NOT_FOUND' })
  }
  const saved = await saveVerifiedMedia({
    url: item.fileUrl,
    bytes: item.bytes,
    sha256: item.sha256,
    mimeType: item.mimeType,
    partBytes: item.partBytes,
    outputPath,
    singleConnection,
  })
  return { ok: true, id: item.id, mediaType: item.mediaType, ...saved }
}

export async function runGallery(subcommand, options, args) {
  switch (subcommand) {
    case 'list': return galleryList(options)
    case 'show': return galleryShow(args[0], { idType: options['id-type'] })
    case 'save': return gallerySave(args[0], args[1], {
      idType: options['id-type'],
      singleConnection: Boolean(options['single-connection']),
    })
    default: throw new Error(`未知 gallery 子命令：${subcommand}`)
  }
}

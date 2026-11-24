import { createHash } from 'node:crypto'
import { api, apiRaw, connection, readFileBytes } from './muse.mjs'

const MAX_UPLOAD_BYTES = 16 * 1024 * 1024

export const UPLOAD_FAMILY_ROUTES = new Map([
  ['anima', 'anima'],
  ['krea2', 'creative'],
  ['creative', 'creative'],
  ['moss', 'moss'],
  ['moss-image', 'moss'],
  ['qwen', 'qwen'],
  ['qwen-image', 'qwen'],
  ['keyframe', 'keyframe'],
  ['manga', 'manga'],
  ['manga-screen', 'manga'],
])

export const uploadCommand = {
  usage: '<图片文件> [--family anima|krea2|moss|qwen|keyframe|manga]',
  args: 1,
  about: '上传本地参考图或底图（≤16 MiB）。先按 SHA-256 查询可复用素材，未命中再上传到对应模型族（HTTPS 中转仅支持已缓存 SHA-256 复用，新图上传需本机或 Tailscale 直连）。',
  options: ['family'],
}

export function resolveUploadRoute(family = 'anima') {
  const route = UPLOAD_FAMILY_ROUTES.get(family)
  if (!route) {
    throw new Error('--family 须为 anima、krea2、moss、qwen、keyframe 或 manga。')
  }
  return route
}

export async function uploadImage(filePath, { family = 'anima' } = {}) {
  const route = resolveUploadRoute(family)
  const data = await readFileBytes(filePath, MAX_UPLOAD_BYTES, '参考图')
  if (!data.length) throw new Error('图片文件为空。')
  const sha256 = createHash('sha256').update(data).digest('hex')

  try {
    const lookup = await api('POST', '/api/muse/inputs/lookup', [sha256])
    const existing = lookup?.inputs?.[sha256]
    if (typeof existing === 'string' && existing.length > 0 && existing.length <= 128) {
      return { ok: true, name: existing, reused: true, sha256, bytes: data.length, family, route }
    }
  } catch (error) {
    // Older desktops or relays may not expose /api/muse/inputs/lookup.
    if (![404, 405].includes(error.httpStatus)) throw error
  }

  if (connection().mode === 'relay') {
    throw Object.assign(
      new Error('HTTPS 中转仅支持已缓存参考图的 SHA-256 复用；上传新参考图（/api/{family}/images/raw）需使用本机或 Tailscale 直连。图像反推、独立放大与视频素材请直接使用 interrogate、upscale 或 video upload 的 Base64 JSON 通道。'),
      { code: 'CLI_RELAY_UPLOAD_UNSUPPORTED' },
    )
  }

  const uploaded = await apiRaw('POST', `/api/${route}/images/raw`, data, 'application/octet-stream', { timeoutMs: 90_000 })
  if (typeof uploaded?.name !== 'string' || !uploaded.name.length || uploaded.name.length > 128) {
    throw Object.assign(new Error('上传接口未返回有效的文件名。'), { code: 'CLI_RESPONSE_INVALID' })
  }
  return {
    ok: true,
    name: uploaded.name,
    reused: false,
    inputReuse: typeof uploaded.inputReuse === 'boolean' ? uploaded.inputReuse : null,
    sha256,
    bytes: data.length,
    family,
    route,
  }
}

export async function runUpload(options, args) {
  return uploadImage(args[0], { family: options.family ?? 'anima' })
}

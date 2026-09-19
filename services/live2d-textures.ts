import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import sharp from 'sharp'
import { mapModelReferences, modelFormat } from './live2d-manifest'

const scales = new Map([['standard', 2], ['compact', 4]])

/** Derived atlases are optional, bounded, and never overwrite imported model assets. */
export function createLive2dTextureService(rootDir: string, options: {
  characters?: () => string[]; manifestName?: (character: string) => string; assetBase?: string
} = {}) {
  const cache = new Map<string, { bytes: Buffer; etag: string }>()
  const pending = new Map<string, Promise<{ bytes: Buffer; etag: string }>>()
  let cachedBytes = 0
  let queue: Promise<unknown> = Promise.resolve()

  function source(character: string, reference: string) {
    if (!(options.characters?.() || ['nene', 'natsume']).includes(character) || !reference || path.isAbsolute(reference)) throw new Error('Invalid Live2D asset')
    const directory = path.resolve(rootDir, character)
    const file = path.resolve(directory, reference)
    if (!file.startsWith(directory + path.sep)) throw new Error('Invalid Live2D asset')
    const real = fs.realpathSync(file)
    if (!real.startsWith(fs.realpathSync(directory) + path.sep)) throw new Error('Invalid Live2D asset')
    return real
  }

  function manifest(character: string, quality: string) {
    if (!scales.has(quality)) throw new Error('Invalid Live2D quality')
    const model = JSON.parse(fs.readFileSync(source(character, options.manifestName?.(character) || character + '.model3.json'), 'utf8'))
    const modern = modelFormat(model) === 'cubism3'
    const refs = modern ? model.FileReferences : model
    const textureKey = modern ? 'Textures' : 'textures'
    const originalTextures = [...refs[textureKey]]
    const assetUrl = (reference: string) => {
      source(character, reference)
      return (options.assetBase || '/assets/live2d-current/') + character + '/' + reference.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')
    }
    mapModelReferences(model, assetUrl)
    refs[textureKey] = originalTextures.map((file: string, index: number) => {
      source(character, file)
      return `/api/live2d-texture/${character}/${quality}/${index}.webp`
    })
    return model
  }

  async function texture(character: string, quality: string, index: number) {
    const scale = scales.get(quality)
    if (!scale || !Number.isInteger(index) || index < 0 || index > 63) throw new Error('Invalid Live2D texture')
    const model = JSON.parse(fs.readFileSync(source(character, options.manifestName?.(character) || character + '.model3.json'), 'utf8'))
    const file = source(character, (modelFormat(model) === 'cubism3' ? model.FileReferences.Textures : model.textures)[index])
    const stat = fs.statSync(file)
    const key = `${file}:${stat.size}:${stat.mtimeMs}:${scale}`
    const hit = cache.get(key)
    if (hit) { cache.delete(key); cache.set(key, hit); return hit }
    const running = pending.get(key)
    if (running) return running
    // Decode one atlas at a time: parallel 8K/4K decodes would create a large CPU-memory spike.
    const job = queue.then(async () => {
      const metadata = await sharp(file).metadata()
      if (!metadata.width || !metadata.height) throw new Error('Invalid texture dimensions')
      const bytes = await sharp(file).resize(Math.max(1, Math.floor(metadata.width / scale)), Math.max(1, Math.floor(metadata.height / scale)), {
        kernel: 'lanczos3',
      }).webp({ lossless: true, effort: 3 }).toBuffer()
      const entry = { bytes, etag: '"' + crypto.createHash('sha256').update(bytes).digest('hex') + '"' }
      if (bytes.length <= 32 * 1024 * 1024) {
        cache.set(key, entry)
        cachedBytes += bytes.length
        while (cachedBytes > 32 * 1024 * 1024) {
          const oldest = cache.keys().next().value!
          cachedBytes -= cache.get(oldest)!.bytes.length
          cache.delete(oldest)
        }
      }
      return entry
    })
    pending.set(key, job)
    queue = job.catch(() => {})
    try { return await job } finally { pending.delete(key) }
  }
  return { manifest, texture }
}

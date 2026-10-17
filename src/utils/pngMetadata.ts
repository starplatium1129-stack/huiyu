/**
 * PNG Chunk / Civitai & A1111 兼容元数据写入工具
 * 在 PNG 图像中注入 tEXt 'parameters' 数据段
 */

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) {
    if (c & 1) c = 0xedb88320 ^ (c >>> 1)
    else c = c >>> 1
  }
  CRC_TABLE[n] = c
}

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

export interface GenerationMetadata {
  prompt?: string
  negative?: string
  steps?: number
  sampler?: string
  cfg?: number
  seed?: number | string
  size?: string
  model?: string
  character?: string
  [key: string]: unknown
}

/** 格式化为 A1111 / Civitai 通用 parameters 文本块 */
export function formatA1111Parameters(meta: GenerationMetadata): string {
  const parts: string[] = []
  if (meta.prompt) parts.push(meta.prompt.trim())
  if (meta.negative) parts.push(`Negative prompt: ${meta.negative.trim()}`)

  const params: string[] = []
  if (meta.steps !== undefined) params.push(`Steps: ${meta.steps}`)
  if (meta.sampler) params.push(`Sampler: ${meta.sampler}`)
  if (meta.cfg !== undefined) params.push(`CFG scale: ${meta.cfg}`)
  if (meta.seed !== undefined) params.push(`Seed: ${meta.seed}`)
  if (meta.size) params.push(`Size: ${meta.size}`)
  if (meta.model) params.push(`Model: ${meta.model}`)
  if (meta.character) params.push(`Character: ${meta.character}`)

  if (params.length > 0) parts.push(params.join(', '))
  return parts.join('\n')
}

/** 检查 ArrayBuffer 是否为有效 PNG */
export function isPng(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 8) return false
  const head = new Uint8Array(buffer, 0, 8)
  for (let i = 0; i < 8; i++) {
    if (head[i] !== PNG_SIGNATURE[i]) return false
  }
  return true
}

/** 在 PNG 文件中注入 tEXt parameters 数据段并返回新的 Uint8Array */
export function injectPngMetadata(pngBuffer: ArrayBuffer, parametersText: string): Uint8Array<ArrayBuffer> {
  if (!isPng(pngBuffer)) return new Uint8Array(pngBuffer)

  const encoder = new TextEncoder()
  const keyBytes = encoder.encode('parameters')
  const valBytes = encoder.encode(parametersText)

  // Chunk Data: keyword + null byte + text
  const chunkData = new Uint8Array(keyBytes.length + 1 + valBytes.length)
  chunkData.set(keyBytes, 0)
  chunkData[keyBytes.length] = 0
  chunkData.set(valBytes, keyBytes.length + 1)

  // Chunk Type: "tEXt"
  const typeBytes = encoder.encode('tEXt')

  // CRC input: Type + Data
  const crcInput = new Uint8Array(typeBytes.length + chunkData.length)
  crcInput.set(typeBytes, 0)
  crcInput.set(chunkData, typeBytes.length)
  const chunkCrc = crc32(crcInput)

  // Total Chunk: Length (4) + Type (4) + Data (N) + CRC (4)
  const chunkLength = chunkData.length
  const totalChunk = new Uint8Array(4 + 4 + chunkLength + 4)
  const view = new DataView(totalChunk.buffer)
  view.setUint32(0, chunkLength, false)
  totalChunk.set(typeBytes, 4)
  totalChunk.set(chunkData, 8)
  view.setUint32(8 + chunkLength, chunkCrc, false)

  // 寻找 IHDR chunk 并在其后插入新 chunk（IHDR 位于 offset 8，长度为 8 + 4 + 4 + 13 + 4 = 33）
  const source = new Uint8Array(pngBuffer)
  const srcView = new DataView(pngBuffer)
  const ihdrLen = srcView.getUint32(8, false)
  const insertPos = 8 + 8 + ihdrLen + 4 // 8 header + 4 len + 4 type + ihdrLen + 4 crc

  const result = new Uint8Array(source.length + totalChunk.length)
  result.set(source.subarray(0, insertPos), 0)
  result.set(totalChunk, insertPos)
  result.set(source.subarray(insertPos), insertPos + totalChunk.length)

  return result
}

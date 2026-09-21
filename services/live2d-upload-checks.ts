// Server-side resource limits mirror the static model inspector; no browser trust.
const MODEL_IMPORT_LIMITS = { depth: 32 }
function checkJsonDepth(value: unknown, depth = 0): boolean {
  if (depth > MODEL_IMPORT_LIMITS.depth) return false
  if (value === null || typeof value !== 'object') return true
  return Object.entries(value).every(([key, child]) => !['__proto__', 'prototype', 'constructor'].includes(key) && checkJsonDepth(child, depth + 1))
}
function textureDimensions(bytes: Uint8Array): [number, number] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length >= 24 && [137,80,78,71,13,10,26,10].every((v, i) => bytes[i] === v)
    && String.fromCharCode(...bytes.slice(12,16)) === 'IHDR') return [view.getUint32(16), view.getUint32(20)]
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') {
    const kind = String.fromCharCode(...bytes.slice(12,16))
    const uint24 = (offset: number) => bytes[offset]! + (bytes[offset + 1]! << 8) + (bytes[offset + 2]! << 16)
    if (kind === 'VP8X' && bytes.length >= 30) return [uint24(24) + 1, uint24(27) + 1]
    if (kind === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true)
      return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1]
    }
    if (kind === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a)
      return [view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff]
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) return null
      const marker = bytes[offset + 1]!
      if (marker === 0xda || marker === 0xd9) return null
      if (marker === 0xff) { offset++; continue }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue }
      const size = view.getUint16(offset + 2)
      if (size < 2 || offset + size + 2 > bytes.length) return null
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && size >= 7)
        return [view.getUint16(offset + 7), view.getUint16(offset + 5)]
      offset += size + 2
    }
  }
  return null
}

export function inspectUploadBytes(files: { path: string; bytes: Buffer }[]): Map<string, Record<string, any>> {
  const json = new Map<string, Record<string, any>>()
  for (const file of files) {
    if (/\.json$/i.test(file.path)) {
      if (file.bytes.length > 4 * 1024 * 1024) throw new Error('JSON exceeds 4 MiB')
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes))
      if (!value || typeof value !== 'object' || Array.isArray(value) || !checkJsonDepth(value)) throw new Error('Invalid JSON shape, depth or key')
      json.set(file.path, value)
    }
    if (/\.(png|jpe?g|webp)$/i.test(file.path)) {
      const size = textureDimensions(file.bytes)
      if (!size || size.some(side => !side || side > 8192) || size[0] * size[1] > 32 * 1024 * 1024) throw new Error('Invalid texture header or dimensions')
    }
    if (/\.moc3$/i.test(file.path) && (file.bytes.length < 8 || file.bytes.subarray(0, 4).toString() !== 'MOC3')) throw new Error('Invalid moc3 header')
  }
  return json
}

export function validateReferences(model: Record<string, any>, entry: string, files: Set<string>) {
  const object = (v: any) => v && typeof v === 'object' && !Array.isArray(v)
  const identifier = (v: any) => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\u0000-\u001f]/.test(v)
  const refs = model.FileReferences
  if (!object(refs)) throw new Error('FileReferences required')
  const prefix = entry.slice(0, entry.lastIndexOf('/') + 1)
  const reference = (value: unknown, extension: RegExp) => {
    if (typeof value !== 'string' || !value || value.length > 512 || /[\\:%?#<>|"*\u0000-\u001f\u007f]/.test(value)
      || value.normalize('NFC') !== value || value.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p))) throw new Error('Invalid model reference')
    if (!extension.test(value) || !files.has(prefix + value)) throw new Error('Missing or unsupported model reference')
  }
  reference(refs.Moc, /\.moc3$/i)
  if (!Array.isArray(refs.Textures) || !refs.Textures.length) throw new Error('Textures required')
  for (const file of refs.Textures) reference(file, /\.(png|jpe?g|webp)$/i)
  for (const field of ['Physics', 'Pose', 'DisplayInfo', 'UserData']) if (refs[field] !== undefined) reference(refs[field], /\.json$/i)
  if (refs.Expressions !== undefined && !Array.isArray(refs.Expressions)) throw new Error('Invalid expression list')
  const expressionNames = new Set<string>()
  for (const expression of refs.Expressions || []) {
    if (!object(expression) || !identifier(expression.Name) || expressionNames.has(expression.Name)) throw new Error('Invalid expression name')
    expressionNames.add(expression.Name)
    reference(expression.File, /\.exp3\.json$/i)
  }
  if (refs.Motions !== undefined && !object(refs.Motions)) throw new Error('Invalid motion groups')
  for (const [group, motions] of Object.entries(refs.Motions || {}) as [string, any][]) {
    if (!identifier(group) || !Array.isArray(motions)) throw new Error('Invalid motion group')
    for (const motion of motions) {
      if (!object(motion)) throw new Error('Invalid motion')
      reference(motion.File, /\.motion3\.json$/i)
      if (motion.Sound !== undefined) reference(motion.Sound, /\.(wav|ogg|mp3)$/i)
    }
  }
  for (const field of ['Groups', 'HitAreas']) if (model[field] !== undefined && !Array.isArray(model[field])) throw new Error('Invalid model groups')
}

/** Local, static inspection only. SDK integrity and visual verification happen at runtime. */
export interface ModelIssue {
  severity: 'error' | 'warning'
  code: string
  message: string
  path?: string
}
export interface ModelParameterCandidate {
  id: string
  name?: string
  sources: string[]
  semantics: string[]
}
export interface ModelInspection {
  valid: boolean
  entryPath: string
  entries: { path: string; file: File; sha256: string }[]
  fingerprint: string
  modelJson: Record<string, unknown> | null
  issues: ModelIssue[]
  candidates: {
    parameters: ModelParameterCandidate[]
    expressions: { name: string; path: string }[]
    motions: { group: string; index: number; path: string }[]
    hitAreas: { id: string; name: string }[]
  }
  totalBytes: number
}
export const MODEL_IMPORT_LIMITS = Object.freeze({
  files: 512, fileBytes: 64 * 1024 * 1024, totalBytes: 256 * 1024 * 1024,
  jsonBytes: 4 * 1024 * 1024, depth: 32, textureSide: 8192,
  texturePixels: 32 * 1024 * 1024, readTimeoutMs: 10_000, inspectionTimeoutMs: 30_000,
})

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value)

/** Strict portable paths: never decode attacker-controlled references or resolve parent segments. */
export function normalizeModelPath(value: string): string | null {
  if (!value || value.length > 512 || /[\\:%?#<>|"*\u0000-\u001f\u007f]/.test(value) || value.startsWith('/')) return null
  const segments = value.split('/')
  if (segments.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return null
  return value.normalize('NFC') === value ? value : null
}

async function boundedRead(file: File): Promise<ArrayBuffer> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      file.arrayBuffer(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('read-timeout')), MODEL_IMPORT_LIMITS.readTimeoutMs) }),
    ])
  } finally { clearTimeout(timer) }
}
async function sha256(data: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), byte => byte.toString(16).padStart(2, '0')).join('')
}
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

export async function inspectModelFiles(files: readonly File[], entryPath?: string): Promise<ModelInspection> {
  const report: ModelInspection = {
    valid: false, entryPath: '', entries: [], fingerprint: '', modelJson: null, issues: [],
    candidates: { parameters: [], expressions: [], motions: [], hitAreas: [] }, totalBytes: 0,
  }
  const issue = (code: string, message: string, path?: string, severity: ModelIssue['severity'] = 'error') => {
    report.issues.push({ severity, code, message, ...(path ? { path } : {}) })
  }
  if (!files.length || files.length > MODEL_IMPORT_LIMITS.files) {
    issue('file-count', '请选择包含 1–512 个文件的模型文件夹。'); return report
  }
  const rawPaths = files.map(file => file.webkitRelativePath || file.name)
  if (rawPaths.some(path => !normalizeModelPath(path))) {
    issue('unsafe-path', '文件路径包含不安全或不可移植的片段。'); return report
  }
  const root = rawPaths[0]!.split('/')[0]!
  const stripRoot = files.every(file => file.webkitRelativePath) && rawPaths.every(path => path.startsWith(`${root}/`))
  const entries = new Map<string, File>()
  const casePaths = new Set<string>()
  for (const [index, file] of files.entries()) {
    const path = stripRoot ? rawPaths[index]!.slice(root.length + 1) : rawPaths[index]!
    const folded = path.toLowerCase()
    if (casePaths.has(folded)) issue('duplicate-path', '存在重复或大小写冲突的文件路径。', path)
    casePaths.add(folded)
    if (!/\.(json|moc3|png|jpe?g|webp|wav|mp3|ogg)$/i.test(path)) issue('unsupported-file', '文件夹包含不支持的资源类型；请仅选择模型资源。', path)
    if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MODEL_IMPORT_LIMITS.fileBytes) issue('file-size', '资源为空或超过单文件 64 MiB 限制。', path)
    report.totalBytes += file.size
    entries.set(path, file)
  }
  if (report.totalBytes > MODEL_IMPORT_LIMITS.totalBytes) issue('total-size', '模型超过总资源 256 MiB 限制。')
  const models = [...entries.keys()].filter(path => /\.model3\.json$/i.test(path))
  const selected = entryPath && stripRoot && entryPath.startsWith(`${root}/`) ? entryPath.slice(root.length + 1) : entryPath
  if (selected && (!normalizeModelPath(selected) || !models.includes(selected))) issue('entry-invalid', '选择的入口不在合法 model3.json 清单内。')
  report.entryPath = selected || (models.length === 1 ? models[0]! : '')
  if (!report.entryPath) issue('entry-required', models.length > 1 ? '发现多个模型，请明确选择入口。' : '未发现 model3.json 模型入口。')
  if (report.issues.length) return report

  const jsonFiles = new Map<string, Record<string, unknown>>()
  const inspectionStarted = Date.now()
  for (const [path, file] of [...entries.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (Date.now() - inspectionStarted > MODEL_IMPORT_LIMITS.inspectionTimeoutMs) {
      issue('inspection-timeout', '模型检查超时，请减少资源数量后重试。'); return report
    }
    try {
      if (/\.json$/i.test(path) && file.size > MODEL_IMPORT_LIMITS.jsonBytes) { issue('json-size', 'JSON 超过 4 MiB 限制。', path); continue }
      const buffer = await boundedRead(file)
      if (buffer.byteLength !== file.size) { issue('read-size', '读取的资源大小与清单不一致。', path); continue }
      report.entries.push({ path, file, sha256: await sha256(buffer) })
      if (/\.json$/i.test(path)) {
        const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer))
        if (!record(parsed) || !checkJsonDepth(parsed)) issue('json-shape', 'JSON 必须为对象，且不能超过深度限制或包含危险键。', path)
        else jsonFiles.set(path, parsed as Record<string, unknown>)
      }
      if (/\.(png|jpe?g|webp)$/i.test(path)) {
        const size = textureDimensions(new Uint8Array(buffer))
        if (!size || size.some(side => !side || side > MODEL_IMPORT_LIMITS.textureSide) || size[0] * size[1] > MODEL_IMPORT_LIMITS.texturePixels)
          issue('texture-size', '纹理头无效，或尺寸超过 8192 边长／32M 像素限制。', path)
      }
      if (/\.moc3$/i.test(path) && (buffer.byteLength < 8 || new TextDecoder().decode(buffer.slice(0, 4)) !== 'MOC3')) issue('moc-header', 'moc3 文件头无效。', path)
    } catch { issue('read-failed', '资源读取、指纹计算或 JSON 解析失败。', path) }
  }
  report.modelJson = jsonFiles.get(report.entryPath) || null
  const model = report.modelJson
  if (!model) { issue('model-json', '模型入口无法解析。'); return report }
  if (model.Version !== 3) issue('model-version', '仅支持 Cubism model3 格式 Version 3。')
  const refs = record(model.FileReferences)
  if (!refs) { issue('references', '模型入口缺少 FileReferences。'); return report }
  for (const field of ['Expressions']) if (refs[field] !== undefined && !Array.isArray(refs[field])) issue('reference-shape', '表情引用必须为数组。')
  if (refs.Motions !== undefined && !record(refs.Motions)) issue('reference-shape', '动作引用必须为分组对象。')
  for (const field of ['Groups', 'HitAreas']) if (model[field] !== undefined && !Array.isArray(model[field])) issue('model-shape', '参数分组和命中区域必须为数组。')
  const directory = report.entryPath.includes('/') ? report.entryPath.slice(0, report.entryPath.lastIndexOf('/') + 1) : ''
  const reference = (value: unknown, extension: RegExp): string | null => {
    if (typeof value !== 'string' || !normalizeModelPath(value)) { issue('unsafe-reference', '模型引用缺失或含越界／远程路径。'); return null }
    const path = `${directory}${value}`
    if (!extension.test(path)) { issue('reference-type', '模型引用资源类型不受支持。', path); return null }
    if (!entries.has(path)) { issue('missing-reference', '找不到模型引用的资源。', path); return null }
    return path
  }
  reference(refs.Moc, /\.moc3$/i)
  if (!Array.isArray(refs.Textures) || !refs.Textures.length) issue('textures-required', '模型至少需要一张纹理。')
  for (const texture of list(refs.Textures)) reference(texture, /\.(png|jpe?g|webp)$/i)
  for (const field of ['Physics', 'Pose', 'UserData']) if (refs[field] !== undefined) reference(refs[field], /\.json$/i)
  const parameterMap = new Map<string, ModelParameterCandidate>()
  const parameter = (id: unknown, source: string, semantic?: string, name?: unknown) => {
    if (!identifier(id)) return
    const item = parameterMap.get(id) || { id, sources: [], semantics: [] }
    if (!item.sources.includes(source)) item.sources.push(source)
    if (semantic && !item.semantics.includes(semantic)) item.semantics.push(semantic)
    if (identifier(name)) item.name = name
    parameterMap.set(id, item)
  }
  for (const groupValue of list(model.Groups)) {
    const group = record(groupValue)
    if (group?.Target === 'Parameter') for (const id of list(group.Ids)) parameter(id, 'model3-group', typeof group.Name === 'string' ? group.Name : undefined)
  }
  if (refs.DisplayInfo !== undefined) {
    const cdi = reference(refs.DisplayInfo, /\.json$/i)
    for (const value of list(cdi && jsonFiles.get(cdi)?.Parameters)) {
      const item = record(value)
      if (item) parameter(item.Id, 'cdi', undefined, item.Name)
    }
  }
  for (const value of list(refs.Expressions)) {
    const item = record(value)
    const path = reference(item?.File, /\.exp3\.json$/i)
    if (path && identifier(item?.Name)) {
      report.candidates.expressions.push({ name: item.Name, path })
      for (const value of list(jsonFiles.get(path)?.Parameters)) parameter(record(value)?.Id, 'expression')
    } else if (path) issue('expression-name', '表情缺少合法名称。', path)
  }
  for (const [group, motions] of Object.entries(record(refs.Motions) || {})) {
    if (!identifier(group) || !Array.isArray(motions)) { issue('motion-group', '动作组定义无效。'); continue }
    for (const [index, value] of motions.entries()) {
      const motion = record(value)
      const path = reference(motion?.File, /\.motion3\.json$/i)
      if (motion?.Sound !== undefined) reference(motion.Sound, /\.(wav|ogg|mp3)$/i)
      if (path) {
        report.candidates.motions.push({ group, index, path })
        for (const value of list(jsonFiles.get(path)?.Curves)) {
          const curve = record(value)
          if (curve?.Target === 'Parameter') parameter(curve.Id, 'motion')
        }
      }
    }
  }
  for (const value of list(model.HitAreas)) {
    const hit = record(value)
    if (identifier(hit?.Id) && identifier(hit?.Name)) report.candidates.hitAreas.push({ id: hit.Id, name: hit.Name })
  }
  const semantics: Record<string, string> = { ParamMouthOpenY: 'LipSync', ParamEyeLOpen: 'EyeBlink', ParamEyeROpen: 'EyeBlink', ParamAngleX: 'GazeX', ParamAngleY: 'GazeY' }
  for (const candidate of parameterMap.values()) if (semantics[candidate.id] && !candidate.semantics.includes(semantics[candidate.id]!)) candidate.semantics.push(semantics[candidate.id]!)
  report.candidates.parameters = [...parameterMap.values()]
  try {
    report.fingerprint = await sha256(new TextEncoder().encode(`${report.entryPath}\n${report.entries.map(entry => `${entry.path}\0${entry.sha256}`).join('\n')}`).buffer)
  } catch { issue('fingerprint-failed', '无法生成资源指纹；请在本地安全环境中重新导入。') }
  issue('runtime-required', '文件检查通过后，请加载预览，确认模型能正确显示，并逐项观察参数与动作的实际效果。', undefined, 'warning')
  report.valid = !report.issues.some(item => item.severity === 'error')
  return report
}

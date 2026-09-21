import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { inspectModelFiles, mapModelReferences, modelFile, modelFormat } from './live2d-manifest'
import { validateImportProfile } from './live2d-import-profile'
import { inspectUploadBytes, validateReferences } from './live2d-upload-checks'

const hash = (value: Buffer | string) => crypto.createHash('sha256').update(value).digest('hex')
const identity = (id: string) => /^[a-z0-9][a-z0-9_-]{0,79}$/.test(id) && !['nene', 'natsume', 'raiden_shogun'].includes(id)
function relative(file: string): string {
  if (typeof file !== 'string' || file.length > 512 || file.normalize('NFC') !== file || /[\\:%?#<>|"*\x00-\x1f\x7f]/.test(file)
    || file.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Invalid file path')
  return file
}
function safeRoot(root: string) {
  if (!root) throw new Error('Local import storage unavailable')
  fs.mkdirSync(root, { recursive: true })
  if (fs.realpathSync(root).toLowerCase() !== path.resolve(root).toLowerCase()) throw new Error('Import root cannot be a link')
}
function directory(root: string, id: string) {
  if (!identity(id)) throw new Error('Invalid companion ID')
  safeRoot(root)
  const dir = path.join(root, id)
  if (fs.existsSync(dir) && fs.realpathSync(dir).toLowerCase() !== path.resolve(dir).toLowerCase()) throw new Error('Import directory cannot be a link')
  return dir
}
function locked<T>(root: string, work: () => T): T {
  safeRoot(root)
  const lock = path.join(root, '.editor-lock')
  let fd: number
  try { fd = fs.openSync(lock, 'wx') } catch { throw Object.assign(new Error('Import editor busy; retry after the other operation completes'), { status: 409 }) }
  try { return work() } finally { fs.closeSync(fd); fs.unlinkSync(lock) }
}
function read(root: string, id: string) {
  const dir = directory(root, id)
  const bytes = fs.readFileSync(modelFile(dir, 'companion.json'))
  const receipt = JSON.parse(bytes.toString())
  if (receipt.character?.id !== id || !Array.isArray(receipt.files)
    || receipt.avatar?.characterId !== id || receipt.character.defaultAvatarId !== receipt.avatar.id
    || receipt.avatar.profileId !== receipt.profile?.profileId || receipt.profile.avatarId !== receipt.avatar.id
    || receipt.avatar.modelPath !== `/api/live2d-local/${id}/${receipt.manifest}`) throw new Error('Invalid import receipt identity')
  const allFiles = (base: string, prefix = ''): string[] => fs.readdirSync(base, { withFileTypes: true }).flatMap(entry => {
    if (entry.isSymbolicLink()) throw new Error('Imported assets cannot be links')
    const file = prefix + entry.name
    return entry.isDirectory() ? allFiles(path.join(base, entry.name), file + '/') : file === 'companion.json' ? [] : [relative(file)]
  })
  const fileHashes = allFiles(dir).sort().map(file => [file, hash(fs.readFileSync(modelFile(dir, file)))])
  for (const file of receipt.files) modelFile(dir, relative(file))
  modelFile(dir, relative(receipt.manifest))
  return { dir, receipt, revision: hash(bytes), fingerprint: hash(JSON.stringify([receipt.entryPath || receipt.manifest, receipt.manifest, fileHashes])) }
}
function saveReceipt(dir: string, receipt: unknown) {
  const temp = path.join(dir, `.receipt-${crypto.randomUUID()}.tmp`)
  try {
    fs.writeFileSync(temp, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
    fs.renameSync(temp, path.join(dir, 'companion.json'))
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp) }
}
function checkRevision(actual: string, expected: unknown) {
  if (typeof expected !== 'string' || actual !== expected) throw Object.assign(new Error('Model or profile changed; reload before saving'), { status: 409 })
}
export function getImportProfile(root: string, id: string) {
  const { receipt, revision, fingerprint } = read(root, id)
  return { id, profile: receipt.profile, revision, fingerprint, disabled: receipt.disabled === true, canRollback: Boolean(receipt.previousProfile) }
}
export function editImportProfile(root: string, id: string, input: Record<string, unknown>, action: 'save' | 'rollback' | 'disable') {
  return locked(root, () => {
    const current = read(root, id)
    checkRevision(current.revision, input.revision)
    checkRevision(current.fingerprint, input.fingerprint)
    const receipt = current.receipt
    if (action === 'disable') receipt.disabled = true
    else {
      const profile = validateImportProfile(action === 'rollback' ? receipt.previousProfile : input.profile, action === 'rollback')
      if (profile.profileId !== receipt.profile.profileId || profile.avatarId !== receipt.avatar.id) throw new Error('Profile identity cannot change')
      receipt.previousProfile = receipt.profile
      receipt.profile = profile
    }
    saveReceipt(current.dir, receipt)
    return getImportProfile(root, id)
  })
}
export interface ImportFile { path: string; bytes: Buffer }
export function addLocalImport(root: string, metadata: Record<string, any>, uploads: ImportFile[]) {
  return locked(root, () => {
    const id = metadata.id
    if (typeof id !== 'string' || !identity(id)) throw new Error('Invalid companion ID')
    const target = directory(root, id)
    if (fs.existsSync(target)) throw Object.assign(new Error('Companion ID already exists'), { status: 409 })
    for (const field of ['name', 'persona', 'author', 'terms']) if (typeof metadata[field] !== 'string' || !metadata[field].trim() || metadata[field].length > (field === 'persona' ? 12000 : 2000)) throw new Error(`Invalid ${field}`)
    if (!Array.isArray(uploads) || uploads.length < 3 || uploads.length > 512 || uploads.reduce((n, f) => n + f.bytes.length, 0) > 256 * 1024 * 1024) throw new Error('Model upload exceeds limits')
    const names = new Set<string>()
    for (const file of uploads) {
      relative(file.path)
      if (!/\.(json|moc3|png|jpe?g|webp|wav|mp3|ogg)$/i.test(file.path)) throw new Error('Unsupported model file type')
      if (names.has(file.path.toLowerCase()) || /(^|\/)companion\.json$/i.test(file.path) || !file.bytes.length || file.bytes.length > 64 * 1024 * 1024) throw new Error('Duplicate, reserved or oversized file')
      names.add(file.path.toLowerCase())
    }
    const entry = relative(metadata.entryPath)
    if (!names.has(entry.toLowerCase()) || !/\.model3\.json$/i.test(entry)) throw new Error('Choose a Cubism3 model manifest')
    const profile = validateImportProfile(metadata.profile)
    const usedAvatars = new Set(['avatar-nene-default', 'avatar-natsume-default'])
    const usedProfiles = new Set(['profile-nene-v1', 'profile-natsume-v1'])
    for (const item of fs.readdirSync(root, { withFileTypes: true })) {
      if (!item.isDirectory() || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(item.name)) continue
      const prior = JSON.parse(fs.readFileSync(modelFile(path.join(root, item.name), 'companion.json'), 'utf8'))
      usedAvatars.add(prior.avatar?.id); usedProfiles.add(prior.profile?.profileId)
    }
    if (usedAvatars.has(profile.avatarId) || usedProfiles.has(profile.profileId)) throw new Error('Avatar or profile ID already registered')
    const jsonFiles = inspectUploadBytes(uploads)
    const inspected = jsonFiles.get(entry)
    if (!inspected || inspected.Version !== 3) throw new Error('Only Cubism3 Version 3 is supported')
    validateReferences(inspected, entry, new Set(uploads.map(file => file.path)))
    const staging = fs.mkdtempSync(path.join(root, '.editor-import-'))
    try {
      for (const file of uploads) {
        const out = path.join(staging, file.path)
        fs.mkdirSync(path.dirname(out), { recursive: true })
        fs.writeFileSync(out, file.bytes, { flag: 'wx' })
      }
      const model = JSON.parse(fs.readFileSync(modelFile(staging, entry), 'utf8'))
      delete model.Controllers; delete model.Options
      const format = modelFormat(model)
      const source = path.dirname(path.join(staging, entry))
      const missing = inspectModelFiles(source, model)
      if (missing.length) throw new Error('Missing model dependencies: ' + missing.join(', '))
      // Publish a root-level manifest with normalized references, so the existing
      // texture service and asset allowlist resolve nested uploads consistently.
      const prefix = path.posix.dirname(entry)
      const files = new Set<string>()
      mapModelReferences(model, ref => {
        const file = relative(prefix === '.' ? ref : prefix + '/' + ref)
        files.add(file)
        return file
      })
      const manifest = `imported-${crypto.randomUUID()}.model${format === 'cubism3' ? '3' : ''}.json`
      fs.writeFileSync(path.join(staging, manifest), JSON.stringify(model))
      files.add(manifest)
      const avatarId = profile.avatarId
      const character = { id, name: metadata.name, shortName: metadata.name, defaultAvatarId: avatarId, personaPrompt: metadata.persona, tags: ['local-import'],
        presentation: { id, name: metadata.name, image: '', caption: `${metadata.author} · ${metadata.terms}`, description: '本机导入模型', icon: 'character', greeting: '你好，今天想聊些什么？', roomCode: 'LOCAL · LIVE2D', roomMood: '一起聊聊今天的生活与灵感', starters: ['聊聊今天吧'], voice: '', accent: 'var(--accent)', live2dLayout: { scale: 1, anchorX: 0.5, bottomOffset: 0 } } }
      const expressions = (model.FileReferences.Expressions || []).map((expression: { Name: string; File: string }) => ({ id: expression.Name, label: expression.Name,
        parameterIds: (JSON.parse(fs.readFileSync(modelFile(staging, expression.File), 'utf8')).Parameters || []).map((p: { Id: string }) => p.Id).filter((id: unknown) => typeof id === 'string' && id.length > 0) }))
      const avatar = { id: avatarId, characterId: id, name: '本机模型', modelPath: `/api/live2d-local/${id}/${manifest}`, version: '1.0.0', profileId: profile.profileId, defaultOutfitId: 'default', outfits: [{ id: 'default', label: '原版服装' }], expressions, license: { author: metadata.author, terms: metadata.terms } }
      const receipt = { character, avatar, profile, manifest, entryPath: entry, files: [...files], format,
        hashes: Object.fromEntries([...files].map(file => [file, hash(fs.readFileSync(modelFile(staging, file)))])) }
      fs.writeFileSync(path.join(staging, 'companion.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
      fs.renameSync(staging, target)
      return getImportProfile(root, id)
    } catch (error) {
      // Retain failed staging for diagnosis; it is hidden from discovery/serving.
      console.warn('[live2d-import] rejected staging retained', { id, staging: path.basename(staging) })
      throw error
    }
  })
}

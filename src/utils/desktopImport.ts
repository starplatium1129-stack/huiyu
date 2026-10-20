import { artworkRepository } from '../storage/artworkRepository'
import { readLocalImageImportJournal, retainLocalImageImport, settleLocalImageImport } from '../storage/localImageImportJournal'
import { imageImportOwnerKey, type ImageImportOwner, type LocalImageImport, type ArtworkImportOutcome } from '../application/artwork/localImageImport'
import { imageMediaSession } from '../platform/imageMediaSession'
import { getDesktopRuntime, onDesktopRuntime } from '../platform/desktop/runtime'
import { registerMaintenanceParticipant } from '../platform/maintenanceParticipants'
import { registerMigrationArtworkSource } from '../platform/web/migrationBarrier'
import { LOCAL_IMAGE_IMPORT_PENDING_PREFIX } from './storageKeys'
import { imageFormat, withImageMime } from './imageFormat'
import { imageBlobDigest } from './imageBlobDigest'
import { measureImageBlob } from './measureImageBlob'
import { buildImportedRecord, filterImageFiles, type ImportResult, type ImportSourceFile } from './desktopImportCore'

interface Pending {
  id: string
  owner: ImageImportOwner
  name: string
  intent?: LocalImageImport
  source?: ImportSourceFile
  blob?: Blob
  error?: string
  flight?: Promise<ArtworkImportOutcome>
}
class RejectedImage extends Error {}
// Accepted imports outlive cards, characters and routes, including the first
// MIME/digest wait. Unprepared sources are memory-only and have never uploaded.
const pending = new Map<string, Pending>()
const listeners = new Set<() => void>()
let preparing = false
let initialized = false
const notify = () => { listeners.forEach(listener => listener()) }
const describe = (intent: LocalImageImport): Pending => ({ id: intent.input.operationId, owner: intent.owner, name: intent.name, intent })
function currentOwner(): ImageImportOwner {
  const state = getDesktopRuntime(), workspace = state.bootstrap?.runtime?.workspace
  if (artworkRepository.getWorkspaceMediaReference) {
    if (state.connection !== 'ready' || !workspace?.domains.includes('artwork') || !workspace.principalId)
      throw new Error('作品库尚未连接，请恢复原工作区连接后重试')
    return { kind: 'workspace', workspaceId: workspace.workspaceId, principalId: workspace.principalId }
  }
  if (workspace?.domains.includes('artwork')) throw new Error('作品库正在切换，请等待原工作区连接完成')
  return { kind: 'web', origin: location.origin, sourceProfileId: state.bootstrap?.sourceProfileId }
}
function allPending() {
  const journal = readLocalImageImportJournal()
  const entries = new Map(journal.entries.map(intent => [intent.input.operationId, describe(intent)]))
  for (const [id, item] of pending) entries.set(id, item)
  return { entries: [...entries.values()], error: journal.error }
}
function owns(item: Pending): boolean {
  try { return imageImportOwnerKey(currentOwner()) === imageImportOwnerKey(item.owner) } catch { return false }
}
function captureAccess(owner?: ImageImportOwner) {
  const repository = artworkRepository, session = imageMediaSession(), selected = currentOwner()
  if (owner && imageImportOwnerKey(owner) !== imageImportOwnerKey(selected)) throw new Error('请回到原工作区或浏览器资料来源恢复；不会在当前作品库重新导入')
  const controller = new AbortController()
  const checkOwner = () => {
    if (repository !== artworkRepository || session !== imageMediaSession()) controller.abort(new Error('作品库连接已变化，原导入已保留；请恢复连接后重试'))
  }
  const stop = onDesktopRuntime(checkOwner)
  const check = () => { checkOwner(); controller.signal.throwIfAborted() }
  return { repository, owner: selected, check, stop, signal: controller.signal }
}
export interface LocalImageImportStatus {
  items: Array<{ id: string; name: string; error: string; busy: boolean; available: boolean; canSelectOriginal: boolean }>
  error: string
  busy: boolean
}
export function localImageImportStatus(): LocalImageImportStatus {
  const saved = allPending()
  return { items: saved.entries.map(item => {
    const available = owns(item)
    return { id: item.id, name: item.name, busy: Boolean(item.flight), canSelectOriginal: Boolean(item.intent),
      available, error: available ? item.error ?? '' : '请回到原工作区或浏览器资料来源恢复' }
  }), error: saved.error, busy: preparing || saved.entries.some(item => Boolean(item.flight)) }
}
export function watchLocalImageImports(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Installed at platform startup, not only while the companion page is visible. */
export function initializeLocalImageImports(): () => void {
  if (initialized) return () => {}
  initialized = true
  const releaseSource = registerMigrationArtworkSource(() => preparing || [...pending.values()].some(item => Boolean(item.source || item.blob)))
  const releaseMaintenance = registerMaintenanceParticipant(() => {
    const saved = allPending()
    if (preparing || saved.error || saved.entries.some(owns)) throw new Error('仍有待恢复的图片导入，请先完成原导入或明确结束待办，再迁移或清理资料')
  })
  const storage = (event: StorageEvent) => { if (event.key === null || event.key.startsWith(LOCAL_IMAGE_IMPORT_PENDING_PREFIX)) notify() }
  window.addEventListener('storage', storage)
  const stopRuntime = onDesktopRuntime(notify)
  return () => {
    initialized = false; releaseSource(); releaseMaintenance(); stopRuntime()
    window.removeEventListener('storage', storage)
  }
}

function findPending(id: string): Pending {
  const saved = allPending()
  if (saved.error) throw new Error(saved.error)
  const item = saved.entries.find(entry => entry.id === id)
  if (!item) throw new Error('这条导入已由另一窗口处理，请刷新恢复列表')
  pending.set(id, item)
  return item
}
async function preparePending(item: Pending, check: () => void): Promise<LocalImageImport> {
  if (item.intent) return item.intent
  const file = item.source
  if (!file) throw new Error('原图片尚未准备，原导入已保留')
  check()
  const header = await file.blob.slice(0, 12).arrayBuffer(); check()
  let format: ReturnType<typeof imageFormat>
  try { format = imageFormat(header) } catch { throw new RejectedImage('原图格式无法识别，请选择有效图片') }
  if (item.owner.kind === 'workspace' && format.mime === 'image/bmp') throw new RejectedImage('桌面作品库暂不支持 BMP，请先另存为 PNG')
  const blob = await withImageMime(file.blob, format.mime); check()
  const measured = await measureImageBlob(blob); check()
  const digest = await imageBlobDigest(blob, check), alias = `image-${crypto.randomUUID()}`
  item.intent = { version: 1, owner: item.owner, name: item.name,
    input: { operationId: item.id, artwork: buildImportedRecord({ ...file, name: item.name }, alias, measured),
      media: { alias, sha256: digest.sha256, bytes: blob.size, mime: blob.type } } }
  item.blob = blob; item.source = undefined
  return item.intent
}
async function resolvePending(item: Pending, kind: 'save' | 'abort'): Promise<ArtworkImportOutcome> {
  if (item.flight) return item.flight
  const access = captureAccess(item.owner)
  item.error = ''
  const run = async () => {
    access.check()
    if (!navigator.locks?.request) throw new Error('当前环境不支持安全恢复，请使用新版桌面应用或 HTTPS 浏览器')
    const signal = AbortSignal.any([access.signal, AbortSignal.timeout(30_000)])
    return navigator.locks.request(`huiyu:local-image-import:${item.id}`, { signal }, async () => {
      access.check()
      // No intent means no journal or platform write has ever been attempted.
      if (kind === 'abort' && !item.intent) { pending.delete(item.id); return 'aborted' }
      return access.repository.withStaging(async () => {
        const intent = await preparePending(item, access.check)
        access.check(); retainLocalImageImport(intent)
        const result = await access.repository.resolveArtworkImport(intent.input, kind === 'save' ? { kind, blob: item.blob } : { kind }, access)
        access.check()
        settleLocalImageImport(intent)
        pending.delete(item.id)
        return result
      })
    })
  }
  item.flight = run().catch(error => {
    item.error = error instanceof Error ? error.message : '图片导入尚未确认，请重试原导入，或重新选择原文件继续'
    throw error
  }).finally(() => { access.stop(); item.flight = undefined; notify() })
  notify()
  return item.flight
}

/** Explicit recovery only. A new media session must re-establish the same logical owner. */
export async function retryLocalImageImport(id: string, file?: Blob): Promise<ArtworkImportOutcome> {
  const item = findPending(id)
  if (item.flight) return item.flight
  // An unprepared entry still owns the accepted original; never replace it with
  // an unverified picker result before its original digest exists.
  const intent = item.intent
  if (file && intent) {
    const access = captureAccess(item.owner)
    try {
      const format = imageFormat(await file.slice(0, 12).arrayBuffer()); access.check()
      const blob = await withImageMime(file, format.mime); access.check()
      const digest = await imageBlobDigest(blob, access.check)
      if (digest.sha256 !== intent.input.media.sha256 || blob.size !== intent.input.media.bytes || blob.type !== intent.input.media.mime)
        throw new Error('所选文件不是原导入图片，请选择原文件；不会另建作品')
      item.blob = blob
    } finally { access.stop() }
  }
  return resolvePending(item, 'save')
}
export function endLocalImageImport(id: string): Promise<ArtworkImportOutcome> {
  return resolvePending(findPending(id), 'abort')
}

/** Every valid entry receives a durable identity before any upload in the batch. */
export async function importLocalImages(files: readonly ImportSourceFile[]): Promise<ImportResult> {
  if (preparing || [...pending.values()].some(item => item.flight)) throw new Error('正在导入图片，请等待当前操作完成')
  const saved = allPending()
  if (saved.error) throw new Error(saved.error)
  if (saved.entries.some(owns)) throw new Error('还有待确认的图片，请使用下方“继续原导入”；不会重复创建作品')
  const access = captureAccess(), candidates = filterImageFiles(files.map(file => ({ ...file })))
  const accepted: Pending[] = candidates.map(file => ({ id: `local-import:${crypto.randomUUID()}`, owner: access.owner,
    name: file.name.slice(0, 1024) || '本地图片', source: file }))
  for (const item of accepted) pending.set(item.id, item)
  let imported = 0, skipped = files.length - candidates.length, markersReady = true
  preparing = true; notify()
  try {
    for (const item of accepted) {
      try { await preparePending(item, access.check) }
      catch (error) {
        item.error = error instanceof Error ? error.message : '原图片尚未准备，请继续原导入'
        if (!(error instanceof RejectedImage)) { markersReady = false; break }
        console.warn('[local-image-import] file rejected before upload', error)
        pending.delete(item.id); skipped++; continue
      }
      try { access.check(); retainLocalImageImport(item.intent!) }
      catch (error) {
        item.error = error instanceof Error ? error.message : '恢复记录未保存，请保持窗口打开并重试'
        markersReady = false; break
      }
    }
    if (markersReady) for (const item of accepted.filter(item => pending.has(item.id))) {
      try {
        access.check()
        const result = await resolvePending(item, 'save')
        if (result === 'saved') imported++
        access.check()
      } catch { break }
    }
    return { imported, skipped, pending: accepted.filter(item => pending.has(item.id)).map(item => item.id) }
  } finally { preparing = false; access.stop(); notify() }
}

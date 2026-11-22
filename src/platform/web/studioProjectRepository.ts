import type { StudioAsset, StudioAssetVersion, StudioProject, StudioProjectSnapshot, StudioShot } from '../../../types/studioProject'
import type { StudioProjectRepository, StudioShotEdit } from '../../application/studio/projectRepository'
import { checkedImport, studioShotEdit, studioText, studioWorkbench } from '../../application/studio/projectRepository'
import { imageBlobDigest } from '../../utils/imageBlobDigest'
import { openImageDatabase, imgGet, type StoredImageRecord } from './imageStore'
import { assertWebArtworkWritable, withMigrationWrite } from './migrationBarrier'
import { studioMediaPrefix, studioStores, type StudioStore } from './studioStores'
import { normalizeStudioMedia } from '../../application/studio/studioMedia'

function result<T>(req: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error) })
}
async function transaction<T>(stores: string[], mode: IDBTransactionMode, check: () => void, work: (tx: IDBTransaction) => Promise<T>) {
  const run = async () => {
    const db = await openImageDatabase()
    check()
    if (mode === 'readwrite') assertWebArtworkWritable()
    const tx = db.transaction(stores, mode)
    const committed = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error ?? new Error('创作资料事务已取消'))
      tx.onerror = () => reject(tx.error ?? new Error('创作资料无法保存'))
    })
    // Install both handlers before the first IDB event. Only IDB requests are awaited inside work.
    try {
      const [value] = await Promise.all([work(tx), committed])
      check()
      return value
    } catch (error) {
      try { tx.abort() } catch { /* A completed/aborted transaction cannot be aborted again. */ }
      throw error
    }
  }
  return mode === 'readwrite' ? withMigrationWrite(run) : run()
}
async function requireRow<T>(store: IDBObjectStore, id: string): Promise<T> {
  const row = await result(store.get(id))
  if (!row) throw new Error('项目、镜头或素材版本已失效')
  return row as T
}
function nextRevision(row: { revision: number }, expected?: number) {
  if (row.revision !== expected) throw new Error('资料已在另一处更改，请重新读取')
  return row.revision + 1
}
async function checkFrame(tx: IDBTransaction, versionId: string | null) {
  if (versionId === null) return
  const frame = await requireRow<StudioAssetVersion>(tx.objectStore('studioVersions'), versionId)
  if (!frame.mime.startsWith('image/')) throw new Error('帧槽只接受图片')
}
export function createWebStudioRepository(check: () => void): StudioProjectRepository {
  const write = <T>(stores: string[], work: (tx: IDBTransaction) => Promise<T>) => transaction(stores, 'readwrite', check, work)
  async function editShot(shot: StudioShot, patch: StudioShotEdit, clip?: { versionId: string; taskId: string }) {
    return write(['studioShots', 'studioVersions'], async tx => {
      const store = tx.objectStore('studioShots')
      const current = await requireRow<StudioShot>(store, shot.id), revision = nextRevision(current, shot.revision)
      if (current.projectId !== shot.projectId) throw new Error('镜头不属于当前创作项目')
      if (patch.firstVersionId !== undefined) await checkFrame(tx, patch.firstVersionId)
      if (patch.lastVersionId !== undefined) await checkFrame(tx, patch.lastVersionId)
      if (patch.audioVersionId) {
        const audio = await requireRow<StudioAssetVersion>(tx.objectStore('studioVersions'), patch.audioVersionId)
        if (audio.mime !== 'audio/wav') throw new Error('镜头配音需要 WAV 音频版本')
      }
      if (clip) {
        const version = await requireRow<StudioAssetVersion>(tx.objectStore('studioVersions'), clip.versionId)
        if (!version.mime.startsWith('video/') || version.source.kind !== 'generation' || version.source.taskId !== clip.taskId)
          throw new Error('片段版本与原镜头任务不符')
      }
      const value = { ...current, ...patch, ...(clip ? { currentClipVersionId: clip.versionId } : {}), revision }
      await result(store.put(value))
      return value
    })
  }
  return {
    assertCurrent: check,
    listProjects: () => transaction(['studioProjects'], 'readonly', check, tx => result<StudioProject[]>(tx.objectStore('studioProjects').getAll())),
    createProject(title) {
      const value: StudioProject = { id: crypto.randomUUID(), title: studioText(title, 160), revision: 1, workbench: null }
      return write(['studioProjects'], async tx => { await result(tx.objectStore('studioProjects').add(value)); return value })
    },
    saveWorkbench(project, draft) {
      const workbench = studioWorkbench(draft)
      return write(['studioProjects'], async tx => {
        const store = tx.objectStore('studioProjects'), previous = await requireRow<StudioProject>(store, project.id)
        const value = { ...previous, revision: nextRevision(previous, project.revision), workbench }
        await result(store.put(value))
        return value
      })
    },
    getProject(id) {
      return transaction([...studioStores], 'readonly', check, async tx => {
        const range = IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER])
        const [project, shots, assets, versions] = await Promise.all([requireRow<StudioProject>(tx.objectStore('studioProjects'), id),
        result<StudioShot[]>(tx.objectStore('studioShots').index('projectPosition').getAll(range)),
        result<StudioAsset[]>(tx.objectStore('studioAssets').getAll()),
        result<StudioAssetVersion[]>(tx.objectStore('studioVersions').index('assetNumber').getAll())])
        return { project, shots, assets, versions } satisfies StudioProjectSnapshot
      })
    },
    createShot(projectId, title, initial) {
      const id = studioText(initial?.id ?? crypto.randomUUID(), 160), prompt = studioText(initial?.prompt ?? '', 32_768, true)
      const firstVersionId = initial?.firstVersionId ?? null, legacy = studioWorkbench(initial?.legacy ?? null, 65_536)
      return write(['studioProjects', 'studioVersions', 'studioShots'], async tx => {
        const store = tx.objectStore('studioShots')
        const previous = await result<StudioShot | undefined>(store.get(id))
        if (previous) {
          if (previous.projectId !== projectId) throw new Error('镜头编号已用于其他项目')
          return previous
        }
        await requireRow(tx.objectStore('studioProjects'), projectId)
        await checkFrame(tx, firstVersionId)
        const range = IDBKeyRange.bound([projectId, 0], [projectId, Number.MAX_SAFE_INTEGER])
        const last = await result(store.index('projectPosition').openKeyCursor(range, 'prev'))
        const position = last ? Number((last.key as IDBValidKey[])[1]) + 1 : 0
        const value: StudioShot = {
          id, projectId, position, title: studioText(title, 160), prompt, firstVersionId, lastVersionId: null,
          audioVersionId: null, currentClipVersionId: null, revision: 1,
          ...(legacy ? { legacy } : {})
        }
        await result(store.add(value))
        return value
      })
    },
    updateShot: (shot, patch) => editShot(shot, studioShotEdit(patch)),
    selectBrowserClip: (shot, versionId, taskId) => editShot(shot, {}, { versionId, taskId }),
    bindFrame: (shot, slot, versionId) => editShot(shot, slot === 'first' ? { firstVersionId: versionId } : { lastVersionId: versionId }),
    async importAsset(input) {
      const data = checkedImport(input)
      check()
      const raw = input.blob ?? (input.mediaAlias && await imgGet(input.mediaAlias))
      if (!(raw instanceof Blob) || !raw.size) throw new Error('未找到素材原件')
      const blob = await normalizeStudioMedia(raw, data.kind)
      const { sha256 } = await imageBlobDigest(blob, check), mediaAlias = studioMediaPrefix + sha256
      return write(['images', 'studioAssets', 'studioVersions'], async tx => {
        const assets = tx.objectStore('studioAssets'), versions = tx.objectStore('studioVersions')
        const previous = await result<StudioAssetVersion | undefined>(versions.get(data.versionId))
        if (previous) {
          if (previous.assetId !== data.assetId || previous.sha256 !== sha256 || JSON.stringify(previous.source) !== JSON.stringify(data.source))
            throw new Error('版本编号已用于其他原件或来源')
          return previous
        }
        const asset = await result<StudioAsset | undefined>(assets.get(data.assetId))
        const revision = asset ? nextRevision(asset, data.expectedRevision) : 1
        if (!asset && data.expectedRevision !== 0 || asset && asset.kind !== data.kind) throw new Error('素材种类或修订号不符')
        if (data.source.kind === 'generation') {
          for (const ref of data.source.inputVersionIds) {
            if (data.kind === 'clip') await requireRow(versions, ref)
            else await checkFrame(tx, ref)
          }
          const origin = data.source.keyframe
          if (origin) {
            const character = await requireRow<StudioAssetVersion>(versions, origin.characterVersionId)
            const subject = await requireRow<StudioAsset>(assets, character.assetId)
            if (subject.kind !== 'character' || (character.source.kind === 'generation' && character.source.keyframe?.neutralAnchor))
              throw new Error('请选择原始角色立绘')
            if (origin.sceneVersionId) {
              const scene = await requireRow<StudioAssetVersion>(versions, origin.sceneVersionId)
              if ((await requireRow<StudioAsset>(assets, scene.assetId)).kind !== 'scene') throw new Error('请选择场景空镜')
            }
          }
        }
        const images = tx.objectStore('images')
        if (await result(images.getKey(mediaAlias)) === undefined) {
          await result(images.add({ id: mediaAlias, blob, name: '', type: blob.type, size: blob.size, created_at: Date.now() } satisfies StoredImageRecord))
        }
        await result(assets.put({ id: data.assetId, title: asset?.title ?? data.title, kind: data.kind, revision } satisfies StudioAsset))
        const version: StudioAssetVersion = {
          id: data.versionId, assetId: data.assetId, number: revision,
          mediaAlias, sha256, bytes: blob.size, mime: blob.type, source: data.source
        }
        await result(versions.add(version))
        return version
      })
    },
    async readOriginal(version, signal) {
      check(); signal?.throwIfAborted()
      const blob = await imgGet(version.mediaAlias)
      check(); signal?.throwIfAborted()
      if (!blob || blob.size !== version.bytes || blob.type !== version.mime
        || (await imageBlobDigest(blob, check)).sha256 !== version.sha256) throw new Error('素材原件已失效')
      signal?.throwIfAborted()
      return blob
    },
  }
}

/** Origins are frozen by migrationExport for the duration of all store reads. */
export async function visitStudioMigrationRows(visit: (store: StudioStore, value: unknown, index: number) => Promise<void>) {
  const db = await openImageDatabase()
  for (const store of studioStores) {
    let index = 0, after: string | undefined
    while (true) {
      const values = await result(db.transaction(store).objectStore(store).getAll(after ? IDBKeyRange.lowerBound(after, true) : undefined, 100))
      for (const value of values) await visit(store, value, index++)
      if (values.length < 100) break
      after = values[values.length - 1].id
    }
  }
}

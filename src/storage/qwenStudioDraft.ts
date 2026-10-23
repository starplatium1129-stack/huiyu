import { profileLocalStorage, writeProfileLocal } from '@/platform/web/profileStorage'
import { sameTempResultOwner, tempResultOwner, type TempResultOwner } from '@/utils/tempResult'
import { artworkRepository } from './artworkRepository'
import { inspectMangaImage, type MangaImage } from '@/composables/manga/mangaImage'
import { qwenModels } from '@/api/qwenApi'
import { mossModels } from '@/api/mossApi'

// Registered model-draft namespace: profile media_refs recursively retains imageId.
// All mounted instances hand off through one queue. A fullPath remount must
// restore after the previous instance's disposal save, never overtake it.
let pendingWrites = Promise.resolve()
function activeKey(key: string, selectionKey: string, recoveryKey: string) {
  const selected = profileLocalStorage.getItem(selectionKey)
  if (selected === null) return key
  if (selected !== key && selected !== recoveryKey) throw new Error('Qwen 草稿入口无法读取，原记录已保留')
  return selected
}
export interface QwenForm { modelId: string; prompt: string; negative: string; width: number; height: number; steps: number; cfg: number; seed: number; mossAcceleration?: 'off' | 'spectrum' }
export interface QwenDraftState {
  form: QwenForm; randomSeed: boolean; resize: boolean; parentId: string | number | null
  resultTaskId: string | null; source: MangaImage | null; references: Array<{ id: string; image: MangaImage }>
}
interface ImageRef { imageId: string; name: string; id: string }
interface StoredDraft {
  version: 1; owner: TempResultOwner; form: QwenForm; randomSeed: boolean; resize: boolean
  parentId: string | number | null; resultTaskId: string | null; source: ImageRef | null; references: ImageRef[]
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const imageRef = (value: unknown): value is ImageRef => object(value) && typeof value.imageId === 'string' && /^[\w-]{1,220}$/.test(value.imageId)
  && typeof value.name === 'string' && value.name.length <= 500 && typeof value.id === 'string' && /^[\w-]{1,160}$/.test(value.id)
export const qwenParentId = (value: unknown): value is string | number => typeof value === 'string' && value.length > 0 && value.length <= 240
  || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const validForm = (form: unknown, models: readonly { value: string }[]): form is QwenForm => object(form)
  && models.some(model => model.value === form.modelId)
  && typeof form.prompt === 'string' && form.prompt.length <= 12000 && typeof form.negative === 'string' && form.negative.length <= 8000
  && (form.mossAcceleration === undefined || form.mossAcceleration === 'off'
    || form.mossAcceleration === 'spectrum' && mossModels.some(model => model.value === form.modelId))
  && ['width', 'height', 'steps', 'cfg', 'seed'].every(key => typeof form[key] === 'number' && Number.isFinite(form[key]))
const copyForm = (form: QwenForm): QwenForm => ({ modelId: form.modelId, prompt: form.prompt, negative: form.negative,
  width: form.width, height: form.height, steps: form.steps, cfg: form.cfg, seed: form.seed,
  ...(mossModels.some(model => model.value === form.modelId) ? { mossAcceleration: form.mossAcceleration ?? 'off' } : {}) })
function read(selectedKey: string, models: readonly { value: string }[]): StoredDraft | null {
  const raw = profileLocalStorage.getItem(selectedKey)
  if (!raw) return null
  const value: unknown = JSON.parse(raw)
  if (!object(value) || value.version !== 1 || !object(value.owner) || !sameTempResultOwner(value.owner as TempResultOwner)
    || !validForm(value.form, models)
    || value.resultTaskId !== null && (typeof value.resultTaskId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value.resultTaskId))
    || typeof value.randomSeed !== 'boolean' || typeof value.resize !== 'boolean' || value.parentId !== null && !qwenParentId(value.parentId)
    || value.source !== null && !imageRef(value.source) || !Array.isArray(value.references) || value.references.length > 3
    || !value.references.every(imageRef) || value.references.length > 0 && !value.source) throw new Error('Qwen 草稿来源或内容无法核对，原草稿已保留')
  return value as unknown as StoredDraft
}

export function createQwenDraftStorage(mode: 'qwen' | 'moss' = 'qwen') {
  const key = `aics-model-draft-${mode}-studio-v1`
  const recoveryKey = `aics-model-draft-${mode}-studio-recovery-v1`
  const selectionKey = `aics-model-draft-${mode}-studio-active-v1`
  const models = mode === 'moss' ? mossModels : qwenModels
  let owner: TempResultOwner | null = null
  const repository = artworkRepository, aliases = new WeakMap<Blob, string>()
  const releasedTemporary = new Set<string>()
  const check = () => {
    owner ??= tempResultOwner()
    if (!sameTempResultOwner(owner) || repository !== artworkRepository) throw new Error('草稿所属工作区已变化')
  }
  let selectedKey = key, previous: StoredDraft | null = null
  async function restore(signal: AbortSignal): Promise<QwenDraftState | null> {
    let pending: Promise<void>
    do { pending = pendingWrites; await pending.catch(() => {}); check(); signal.throwIfAborted() } while (pending !== pendingWrites)
    selectedKey = activeKey(key, selectionKey, recoveryKey)
    const draft = read(selectedKey, models); previous = draft; if (!draft) return null
    if (mode === 'moss' && (draft.source || draft.references.length)) throw new Error('MOSS 草稿只支持文生图，原草稿已保留')
    const load = async (ref: ImageRef) => {
      const blob = await repository.getImage(ref.imageId, signal); check(); signal.throwIfAborted()
      if (!blob) throw new Error('草稿图片不可用，原草稿已保留；请恢复工作区后重试')
      const image = await inspectMangaImage(blob, ref.name); check(); signal.throwIfAborted()
      aliases.set(image.blob, ref.imageId); return image
    }
    const source = draft.source ? await load(draft.source) : null, references: QwenDraftState['references'] = []
    for (const ref of draft.references) references.push({ id: ref.id, image: await load(ref) })
    return { form: copyForm(draft.form), resultTaskId: draft.resultTaskId, source, references, parentId: draft.parentId, resize: draft.resize, randomSeed: draft.randomSeed }
  }
  function save(state: QwenDraftState, preservePrevious = false): Promise<void> {
    // Snapshot before entering the queue. File blobs are immutable; form is detached.
    const snapshot = { ...state, form: { ...state.form }, references: state.references.map(ref => ({ ...ref })) }
    const work = pendingWrites.catch(() => {}).then(async () => {
      check()
      const destination = preservePrevious ? selectedKey === key ? recoveryKey : key : selectedKey
      if (!validForm(snapshot.form, models)) throw new Error('请补全数值参数后保存草稿；上一份草稿仍保留')
      const store = async (image: MangaImage, id: string): Promise<ImageRef> => {
        let imageId = aliases.get(image.blob)
        if (!imageId) { imageId = await repository.putImage(image.blob); check(); aliases.set(image.blob, imageId) }
        return { imageId, name: image.name.slice(0, 500), id }
      }
      const source = snapshot.source ? await store(snapshot.source, 'source') : null, references: ImageRef[] = []
      for (const ref of snapshot.references) references.push(await store(ref.image, ref.id))
      check()
      const draft: StoredDraft = { version: 1, owner: owner!, form: snapshot.form, randomSeed: snapshot.randomSeed,
        resize: snapshot.resize, parentId: snapshot.parentId, resultTaskId: snapshot.resultTaskId, source, references }
      await writeProfileLocal(destination, JSON.stringify(draft)).confirm(); check()
      if (preservePrevious) {
        // Publish the new pointer only after the new draft is durable. The old
        // record and its media refs stay intact, including unreadable originals.
        await writeProfileLocal(selectionKey, destination).confirm(); check()
        selectedKey = destination
      }
      const old = previous; previous = draft
      // Desktop release drops temporary ownership only: confirmed profile refs
      // retain the bytes. Web deletes only aliases no longer in the new draft.
      const retained = new Set([source, ...references].filter((ref): ref is ImageRef => !!ref).map(ref => ref.imageId))
      const released = repository.getWorkspaceMediaReference ? [...retained].filter(alias => !releasedTemporary.has(alias))
        : preservePrevious ? []
        : [old?.source, ...(old?.references ?? [])].filter((ref): ref is ImageRef => !!ref && !retained.has(ref.imageId)).map(ref => ref.imageId)
      for (const alias of new Set(released)) {
        check()
        // Cleanup cannot undo the confirmed draft. Unreleased temporary aliases
        // stay protected and retry on the next save, rather than risking bytes.
        try { await repository.deleteImage(alias); releasedTemporary.add(alias) } catch { check() }
      }
      check()
    })
    pendingWrites = work; return work
  }
  return { restore, save }
}

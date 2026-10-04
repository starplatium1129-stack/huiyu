import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { catalogApi, isCatalogRecord, type CatalogChange, type CatalogKind, type CatalogPage, type CatalogReceipt, type CatalogRecord, type CatalogSummary, type CatalogSnapshot } from '@/api/catalogApi'
import { ApiClientError } from '@/api/client'
import { useSceneStore } from '@/stores/sceneStore'
import { confirmAction } from '@/composables/useConfirm'
import { registerMaintenanceParticipant } from '@/platform/maintenanceParticipants'
import { blankRecord } from './catalogFields'
import { recordTitle } from './catalogPresentation'
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const key = (kind: string, id: string) => `${kind}:${id}`
export function useCatalogMaintenance() {
  const kind = ref<CatalogKind>('scene'), search = ref(''), character = ref(''), category = ref(''), rating = ref(''), sort = ref('order'), page = ref(1)
  const result = ref<CatalogPage | null>(null), counts = ref<Record<string, number>>({}), loading = ref(false), error = ref(''), hint = ref('')
  const selected = ref<CatalogRecord | null>(null), currentServer = ref<CatalogRecord | null>(null), detailLoading = ref(false)
  const pending = ref<CatalogChange[]>([]), busy = ref(false), preview = ref<CatalogReceipt | null>(null)
  const history = ref<Array<{ revision: number; at: string; removed: boolean }>>([])
  const baseline = ref(''), bulkInput = ref(''), bulkError = ref('')
  const nextSceneId = ref('')
  const characterNames = ref<Record<string, string>>({})
  let namesVersion = -1, namesController: AbortController | null = null
  async function loadCharacterNames(version: number) {
    if (version === namesVersion) return
    namesController?.abort()
    const controller = new AbortController(); namesController = controller
    try {
      const first = await catalogApi.query({ kind: 'character', pageSize: 100 }, controller.signal)
      const remaining = await Promise.all(Array.from({ length: Math.max(0, Math.ceil(first.total / 100) - 1) }, (_, index) => catalogApi.query({ kind: 'character', pageSize: 100, page: index + 2 }, controller.signal)))
      if (controller.signal.aborted) return
      characterNames.value = Object.fromEntries([first, ...remaining].flatMap(result => result.items).map(item => [item.id, item.title]))
      namesVersion = version
    } catch { /* The content list stays usable while display names are unavailable. */ }
  }
  const importSnapshot = ref<CatalogSnapshot | null>(null), importPreview = ref(false)
  let listController: AbortController | null = null, detailController: AbortController | null = null, listSeq = 0, detailSeq = 0
  const dirtyEditor = computed(() => !!selected.value && JSON.stringify(selected.value) !== baseline.value)
  const dirty = computed(() => !!pending.value.length || dirtyEditor.value)
  const totalPages = computed(() => Math.max(1, Math.ceil((result.value?.total ?? 0) / 24)))
  async function load() {
    listController?.abort(); const controller = new AbortController(); listController = controller; const seq = ++listSeq
    loading.value = true; error.value = ''
    try {
      const data = await catalogApi.query({ kind: kind.value, search: search.value, character: character.value, category: category.value, rating: rating.value, sort: sort.value, page: page.value }, controller.signal)
      if (seq !== listSeq) return
      result.value = data; page.value = data.page
      void loadCharacterNames(data.version)
      const stats = await catalogApi.stats(controller.signal)
      if (seq === listSeq) { counts.value = stats.counts; nextSceneId.value = stats.nextSceneId }
    } catch (e) { if (seq === listSeq && !controller.signal.aborted) error.value = (e as Error).message }
    finally { if (seq === listSeq) loading.value = false }
  }
  async function canSwitch() {
    return !dirtyEditor.value || await confirmAction({ title: '放下这次修改？', message: '当前内容还没有暂存，离开后这些修改会丢失。', confirmLabel: '放弃修改', danger: true })
  }
  async function select(item: CatalogSummary | { kind: CatalogKind; id: string }) {
    if (busy.value || !await canSwitch()) return
    detailController?.abort(); const controller = new AbortController(); detailController = controller; const seq = ++detailSeq
    detailLoading.value = true; hint.value = ''; currentServer.value = null; history.value = []
    try {
      const draft = pending.value.find(c => key(c.kind, c.id) === key(item.kind, item.id))
      const record = (await catalogApi.record(item.kind, item.id, undefined, controller.signal)).record
      if (seq !== detailSeq) return
      selected.value = clone(draft?.data ? { ...record, revision: draft.expectedRevision, data: draft.data, sortOrder: draft.sortOrder ?? record.sortOrder } : record)
      if (draft && draft.expectedRevision !== record.revision) currentServer.value = clone(record)
      baseline.value = JSON.stringify(selected.value)
      const versions = await catalogApi.history(item.kind, item.id, controller.signal)
      if (seq === detailSeq) history.value = versions.items
    } catch (e) { if (seq === detailSeq && !controller.signal.aborted) hint.value = (e as Error).message }
    finally { if (seq === detailSeq) detailLoading.value = false }
  }
  async function add(copy = false) {
    if (busy.value || !await canSwitch() || kind.value === 'document') return
    const record = copy && selected.value ? clone(selected.value) : blankRecord(kind.value)
    record.id = ''; record.revision = 0; record.createdAt = null; record.updatedAt = null
    if (record.kind === 'scene' && nextSceneId.value) {
      const occupied = new Set(pending.value.filter(c => c.kind === 'scene').map(c => c.id))
      let number = Number(nextSceneId.value.slice(2))
      while (occupied.has('sc' + String(number).padStart(3, '0'))) number++
      record.id = 'sc' + String(number).padStart(3, '0')
    } else if (record.kind === 'blueprint') record.id = 'bp_' + crypto.randomUUID().replaceAll('-', '')
    selected.value = record; baseline.value = JSON.stringify(record); history.value = []; currentServer.value = null
  }
  function stage() {
    const record = selected.value
    if (!record || busy.value) return
    if (!record.id.trim() || record.id.trim() !== record.id) { hint.value = '请在管理信息中填写编号，首尾不要留空白'; return }
    if (!Number.isSafeInteger(record.sortOrder)) { hint.value = '展示顺序需要一个整数'; return }
    const data = clone(record.data) as Record<string, unknown>
    if (record.kind === 'character') {
      data.id = record.id
      for (const field of ['profile', 'popular']) if (data[field] && typeof data[field] === 'object') (data[field] as Record<string, unknown>).id = record.id
    } else if (record.kind === 'outfit') {
      const outfit = data.outfit as Record<string, unknown>
      if (record.id !== `${data.characterId}/${outfit.id}`) { hint.value = '服装记录 ID 必须为「角色ID/服装ID」'; return }
    } else if (record.kind !== 'document') data.id = record.id
    const change: CatalogChange = { kind: record.kind, id: record.id, expectedRevision: record.revision, data, sortOrder: record.sortOrder }
    pending.value = [...pending.value.filter(c => key(c.kind, c.id) !== key(change.kind, change.id)), change]
    selected.value = { ...record, data }; baseline.value = JSON.stringify(selected.value); preview.value = null; hint.value = '这项修改已暂存，可以继续整理其他内容'
  }
  async function remove() {
    const record = selected.value
    if (!record || busy.value || !record.revision || record.kind === 'document') return
    if (!await confirmAction({ title: '归档「' + recordTitle(record) + '」？', message: '保存后会从内容列表移出，历史仍会保留。正在被使用的内容不能直接归档。', confirmLabel: '归档', danger: true })) return
    pending.value = [...pending.value.filter(c => key(c.kind, c.id) !== key(record.kind, record.id)), { kind: record.kind, id: record.id, expectedRevision: record.revision, remove: true }]
    selected.value = null; baseline.value = ''; preview.value = null
  }
  async function submit(previewOnly = false) {
    if (busy.value || !pending.value.length || dirtyEditor.value) return
    const submission = clone(pending.value)
    busy.value = true; hint.value = ''; preview.value = null
    try {
      const receipt = await catalogApi.changes(submission, previewOnly)
      if (previewOnly) preview.value = receipt
      else {
        pending.value = []; selected.value = null; baseline.value = ''; useSceneStore().invalidate()
        hint.value = '已保存 ' + receipt.items.length + ' 项修改'; await load()
      }
    } catch (e) {
      hint.value = (e as Error).message
      if (selected.value && (e instanceof ApiClientError && (e.status === 409 || e.kind === 'network' || e.kind === 'timeout'))) {
        try { currentServer.value = clone((await catalogApi.record(selected.value.kind, selected.value.id)).record) }
        catch { /* Keep the original failure and draft when confirmation is unavailable. */ }
      }
    } finally { busy.value = false }
  }
  async function compareCurrent() {
    if (!selected.value?.revision || busy.value) return
    busy.value = true
    try { currentServer.value = clone((await catalogApi.record(selected.value.kind, selected.value.id)).record) }
    catch (e) { hint.value = (e as Error).message }
    finally { busy.value = false }
  }
  function adoptRevision() {
    if (!selected.value || !currentServer.value) return
    selected.value.revision = currentServer.value.revision; preview.value = null
    hint.value = '已对齐最新版本，请确认合并后的内容再保存'
  }
  async function restore(revision: number) {
    if (!selected.value || busy.value || !await canSwitch()) return
    busy.value = true
    try {
      const old = (await catalogApi.record(selected.value.kind, selected.value.id, revision)).record
      selected.value.data = clone(old.data); selected.value.sortOrder = old.sortOrder
      hint.value = '已找回这版内容，确认后保存即可'
    } catch (e) { hint.value = (e as Error).message }
    finally { busy.value = false }
  }
  function loadBulk() {
    bulkError.value = ''
    importSnapshot.value = null; importPreview.value = false
    try {
      const value: unknown = JSON.parse(bulkInput.value)
      if (value && typeof value === 'object' && Array.isArray((value as CatalogSnapshot).records)) {
        const snapshot = value as CatalogSnapshot
        if (snapshot.version !== 1 || !snapshot.records.every(isCatalogRecord) || !Array.isArray(snapshot.retired)) throw new Error('快照格式无效')
        importSnapshot.value = clone(snapshot); return
      }
      if (!value || typeof value !== 'object' || !Array.isArray((value as { changes?: unknown }).changes)) throw new Error('需要包含 changes 数组的变更文件')
      const changes = (value as { changes: CatalogChange[] }).changes
      if (!changes.length || changes.some(c => !c || !['character', 'outfit', 'scene', 'blueprint', 'document'].includes(c.kind) || typeof c.id !== 'string' || !Number.isSafeInteger(c.expectedRevision))) throw new Error('每条修改需要 kind、id、expectedRevision')
      const keys = changes.map(c => key(c.kind, c.id)); if (new Set(keys).size !== keys.length) throw new Error('批量文件包含重复记录')
      pending.value = [...pending.value.filter(c => !keys.includes(key(c.kind, c.id))), ...clone(changes)]; preview.value = null
    } catch (e) { bulkError.value = (e as Error).message }
  }
  async function importContent(previewOnly: boolean) {
    if (!importSnapshot.value || busy.value || dirty.value || (!previewOnly && !importPreview.value)) return
    busy.value = true; hint.value = ''; preview.value = null
    try {
      const receipt = await catalogApi.importSnapshot(clone(importSnapshot.value), previewOnly)
      preview.value = receipt; importPreview.value = previewOnly
      if (!previewOnly) { selected.value = null; baseline.value = ''; useSceneStore().invalidate(); hint.value = '快照已导入；本地修改与冲突按记录核对'; await load() }
    } catch (e) { importPreview.value = false; hint.value = (e as Error).message }
    finally { busy.value = false }
  }
  function download(value: unknown, name: string) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2) + '\n'], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url)
  }
  const exportDraft = () => download({ changes: pending.value, editor: selected.value }, 'content-draft.json')
  async function exportSnapshot() { try { download(await catalogApi.snapshot(), 'content-snapshot.json') } catch (e) { hint.value = (e as Error).message } }
  let timer: ReturnType<typeof setTimeout> | undefined
  watch([kind, character, category, rating, sort], () => { page.value = 1; void load() })
  watch(search, () => { clearTimeout(timer); timer = setTimeout(() => { page.value = 1; void load() }, 180) })
  watch(page, () => { if (page.value !== result.value?.page) void load() })
  watch(pending, () => { preview.value = null }, { deep: true })
  const release = registerMaintenanceParticipant(() => { if (dirty.value) throw new Error('UNSAVED_CONTENT'); if (busy.value) throw new Error('CONTENT_BUSY') })
  const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty.value || busy.value) event.preventDefault() }
  onMounted(() => { window.addEventListener('beforeunload', beforeUnload); void load() })
  onBeforeUnmount(() => { ++listSeq; ++detailSeq; listController?.abort(); detailController?.abort(); namesController?.abort(); clearTimeout(timer); release(); window.removeEventListener('beforeunload', beforeUnload) })
  onBeforeRouteLeave(async () => !busy.value && (!dirty.value || await confirmAction({ title: '离开内容维护？', message: '未保存修改将丢失，可先导出草稿。', confirmLabel: '离开', danger: true })))
  return { kind, search, character, category, rating, sort, page, result, counts, loading, error, hint, selected, currentServer, detailLoading, pending, busy, preview, history, dirtyEditor, dirty, totalPages, bulkInput, bulkError, importSnapshot, importPreview, importContent, load, select, add, stage, remove, submit, compareCurrent, adoptRevision, restore, loadBulk, exportDraft, exportSnapshot, characterNames }
}

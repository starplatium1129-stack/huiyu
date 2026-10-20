import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { catalogApi, isCatalogRecord, type CatalogChange, type CatalogKind, type CatalogPage, type CatalogReceipt, type CatalogRecord, type CatalogSummary, type CatalogSnapshot } from '@/api/catalogApi'
import { ApiClientError } from '@/api/client'
import { useSceneStore } from '@/stores/sceneStore'
import { confirmAction } from '@/composables/useConfirm'
import { registerMaintenanceParticipant } from '@/platform/maintenanceParticipants'
import { blankRecord } from './catalogFields'
import { recordTitle } from './catalogPresentation'
import { downloadBlob } from '@/utils/downloadBlob'
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const key = (kind: string, id: string) => `${kind}:${id}`
const needsBatchReview = (change?: CatalogChange) => !!change && (change.patch !== undefined || !!change.remove)
// Project whole data and metadata only; patch planning remains owned by the server.
const editorRecord = (record: CatalogRecord, change?: CatalogChange): CatalogRecord => clone(change
  ? { ...record, revision: change.expectedRevision, data: change.data ?? record.data,
    sortOrder: change.sortOrder ?? record.sortOrder, createdAt: change.createdAt ?? record.createdAt }
  : record)
// New, unfinished records may not have an ID yet; the server still validates saved records.
const isDraftRecord = (value: unknown): value is CatalogRecord => !!value && typeof value === 'object'
  && typeof (value as CatalogRecord).id === 'string' && isCatalogRecord({ ...value, id: (value as CatalogRecord).id || 'draft' })
export function useCatalogMaintenance() {
  const kind = ref<CatalogKind>('scene'), search = ref(''), character = ref(''), category = ref(''), rating = ref(''), sort = ref('order'), page = ref(1)
  const result = ref<CatalogPage | null>(null), counts = ref<Record<string, number>>({}), loading = ref(false), error = ref(''), hint = ref('')
  const listScope = ref(''), listKind = ref<CatalogKind>()
  const listMatchesKind = computed(() => listKind.value === kind.value)
  const selected = ref<CatalogRecord | null>(null), currentServer = ref<CatalogRecord | null>(null), detailLoading = ref(false)
  const pending = ref<CatalogChange[]>([]), busy = ref(false), preview = ref<CatalogReceipt | null>(null)
  const history = ref<Array<{ revision: number; at: string; removed: boolean }>>([])
  const historyLoading = ref(false), historyError = ref('')
  const baseline = ref(''), bulkInput = ref(''), bulkError = ref('')
  const nextSceneId = ref('')
  const characterNames = ref<Record<string, string>>({})
  let namesVersion = -1, namesController: AbortController | null = null
  let namesLoadingVersion: number | null = null, statsVersion = -1
  async function loadCharacterNames(version: number) {
    if (version === namesVersion || version === namesLoadingVersion) return
    namesController?.abort()
    const controller = new AbortController(); namesController = controller
    namesLoadingVersion = version
    try {
      const first = await catalogApi.query({ kind: 'character', pageSize: 100 }, controller.signal)
      const remaining = await Promise.all(Array.from({ length: Math.max(0, Math.ceil(first.total / 100) - 1) }, (_, index) => catalogApi.query({ kind: 'character', pageSize: 100, page: index + 2 }, controller.signal)))
      if (controller.signal.aborted) return
      characterNames.value = Object.fromEntries([first, ...remaining].flatMap(result => result.items).map(item => [item.id, item.title]))
      namesVersion = version
    } catch { /* The content list stays usable while display names are unavailable. */ }
    finally { if (namesController === controller) namesLoadingVersion = null }
  }
  const importSnapshot = ref<CatalogSnapshot | null>(null), importPreview = ref(false)
  let listController: AbortController | null = null, detailController: AbortController | null = null, historyController: AbortController | null = null
  let listSeq = 0, detailSeq = 0, historySeq = 0
  const dirtyEditor = computed(() => !!selected.value && JSON.stringify(selected.value) !== baseline.value)
  const dirty = computed(() => !!pending.value.length || dirtyEditor.value)
  const editorPendingNotice = computed(() => {
    const record = selected.value
    if (!record || !needsBatchReview(pending.value.find(change => key(change.kind, change.id) === key(record.kind, record.id)))) return ''
    return dirtyEditor.value
      ? '这项还有局部修改或归档待保存，当前编辑已保留。请先备份草稿或撤回这项暂存，核对后继续编辑。'
      : '这项还有局部修改或归档待保存，请先保存或撤回这项，再打开编辑。'
  })
  let disposed = false, requestedPage = 1, bulkReadSeq = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  function invalidateDetail() {
    detailController?.abort(); detailController = null; detailLoading.value = false
    return ++detailSeq
  }
  function resetEditor(record: CatalogRecord | null = null) {
    invalidateDetail()
    selected.value = record; baseline.value = record ? JSON.stringify(record) : ''
    currentServer.value = null; clearHistory()
  }
  function clearHistory() {
    historyController?.abort(); historyController = null; historySeq++
    history.value = []; historyLoading.value = false; historyError.value = ''
  }
  async function loadHistory() {
    const record = selected.value
    if (disposed || !record?.revision) return
    historyController?.abort()
    const controller = new AbortController(), seq = ++historySeq; historyController = controller
    const current = () => !disposed && seq === historySeq && !controller.signal.aborted
      && selected.value?.kind === record.kind && selected.value.id === record.id
    historyLoading.value = true; historyError.value = ''
    try {
      const versions = await catalogApi.history(record.kind, record.id, controller.signal)
      if (current()) history.value = versions.items
    } catch (e) { if (current()) historyError.value = (e as Error).message }
    finally { if (current()) { historyLoading.value = false; historyController = null } }
  }
  const totalPages = computed(() => listMatchesKind.value ? Math.max(1, Math.ceil((result.value?.total ?? 0) / 24)) : 1)
  async function load() {
    if (disposed) return
    clearTimeout(timer); requestedPage = page.value
    listController?.abort(); const controller = new AbortController(); listController = controller; const seq = ++listSeq
    loading.value = true; error.value = ''
    try {
      const query = { kind: kind.value, search: search.value, character: character.value, category: category.value, rating: rating.value, sort: sort.value, page: page.value }
      const data = await catalogApi.query(query, controller.signal)
      if (seq !== listSeq) return
      result.value = data; listKind.value = query.kind; listScope.value = JSON.stringify({ ...query, page: data.page }); page.value = data.page
      void loadCharacterNames(data.version)
      if (data.version !== statsVersion) {
        const stats = await catalogApi.stats(controller.signal)
        if (seq === listSeq) { counts.value = stats.counts; nextSceneId.value = stats.nextSceneId; statsVersion = data.version }
      }
    } catch (e) { if (seq === listSeq && !controller.signal.aborted) error.value = (e as Error).message }
    finally { if (seq === listSeq) loading.value = false }
  }
  async function canSwitch() {
    return !dirtyEditor.value || await confirmAction({ title: '放下这次修改？', message: '当前内容还没有暂存，离开后这些修改会丢失。', confirmLabel: '放弃修改', danger: true })
  }
  async function select(item: CatalogSummary | { kind: CatalogKind; id: string }): Promise<boolean> {
    if (busy.value || disposed || item.kind !== kind.value) return false
    const seq = invalidateDetail()
    if (!await canSwitch() || seq !== detailSeq || busy.value || disposed || item.kind !== kind.value) return false
    const controller = new AbortController(); detailController = controller
    let opened = false
    detailLoading.value = true; hint.value = ''; currentServer.value = null
    try {
      const record = (await catalogApi.record(item.kind, item.id, undefined, controller.signal)).record
      if (seq !== detailSeq) return false
      // Pending may have been replaced or withdrawn while the detail request was running.
      const draft = pending.value.find(c => key(c.kind, c.id) === key(item.kind, item.id))
      if (needsBatchReview(draft)) {
        hint.value = '这项还有局部修改或归档待保存，请先保存或撤回这项，再打开编辑。'
        return false
      }
      selected.value = editorRecord(record, draft)
      currentServer.value = draft && draft.expectedRevision !== record.revision ? clone(record) : null
      baseline.value = JSON.stringify(selected.value)
      opened = true
      clearHistory(); void loadHistory()
    } catch (e) { if (seq === detailSeq && !controller.signal.aborted) hint.value = (e as Error).message }
    finally { if (seq === detailSeq) detailLoading.value = false }
    return opened && seq === detailSeq && !disposed
  }
  async function add(copy = false) {
    if (busy.value || disposed || kind.value === 'document' || copy && editorPendingNotice.value) return
    const seq = invalidateDetail()
    if (!await canSwitch() || seq !== detailSeq || busy.value || disposed) return
    const record = copy && selected.value ? clone(selected.value) : blankRecord(kind.value)
    record.id = ''; record.revision = 0; record.createdAt = null; record.updatedAt = null
    if (record.kind === 'scene' && nextSceneId.value) {
      const occupied = new Set(pending.value.filter(c => c.kind === 'scene').map(c => c.id))
      let number = Number(nextSceneId.value.slice(2))
      while (occupied.has('sc' + String(number).padStart(3, '0'))) number++
      record.id = 'sc' + String(number).padStart(3, '0')
    } else if (record.kind === 'blueprint') record.id = 'bp_' + crypto.randomUUID().replaceAll('-', '')
    resetEditor(record)
  }
  function stage() {
    const record = selected.value
    if (!record || busy.value) return
    if (editorPendingNotice.value) { hint.value = editorPendingNotice.value; return }
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
    const previous = pending.value.find(change => key(change.kind, change.id) === key(record.kind, record.id))
    const before = baseline.value ? JSON.parse(baseline.value) as CatalogRecord : null
    const createdAt = previous?.createdAt ?? (before?.kind === record.kind && before.id === record.id
      && before.createdAt === null && typeof record.createdAt === 'string' ? record.createdAt : undefined)
    const change: CatalogChange = { kind: record.kind, id: record.id, expectedRevision: record.revision, data, sortOrder: record.sortOrder,
      ...(createdAt !== undefined ? { createdAt } : {}) }
    pending.value = [...pending.value.filter(c => key(c.kind, c.id) !== key(change.kind, change.id)), change]
    selected.value = { ...record, data: clone(data) }; baseline.value = JSON.stringify(selected.value); preview.value = null; hint.value = '这项修改已暂存，可以继续整理其他内容'
  }
  async function remove() {
    const record = selected.value
    if (!record || busy.value || !record.revision || record.kind === 'document' || editorPendingNotice.value) return
    const recordKey = key(record.kind, record.id)
    const staged = pending.value.find(change => key(change.kind, change.id) === recordKey)
    if (!await confirmAction({ title: '归档「' + recordTitle(record) + '」？', message: '保存后会从内容列表移出，历史仍会保留。正在被使用的内容不能直接归档。', confirmLabel: '归档', danger: true })) return
    if (busy.value || disposed) return
    if (selected.value !== record || key(record.kind, record.id) !== recordKey
      || pending.value.find(change => key(change.kind, change.id) === recordKey) !== staged) return
    pending.value = [...pending.value.filter(c => key(c.kind, c.id) !== key(record.kind, record.id)), { kind: record.kind, id: record.id, expectedRevision: record.revision, remove: true }]
    if (selected.value === record) resetEditor()
    preview.value = null
  }
  function withdrawPending(change: CatalogChange): boolean {
    if (busy.value || disposed || !pending.value.includes(change)) return false
    const record = selected.value
    const current = !!record && key(record.kind, record.id) === key(change.kind, change.id)
    const keepEditor = current && dirtyEditor.value
    if (current) {
      invalidateDetail()
      // Keep the mounted editor's unapplied JSON too; withdrawal no longer means this editor is saved.
      if (change.createdAt !== undefined && record.createdAt === change.createdAt) {
        const before = baseline.value ? JSON.parse(baseline.value) as CatalogRecord : record
        const sameRecord = before.kind === record.kind && before.id === record.id
        // Retain explicit date backfill as an editor/baseline difference, including exported drafts.
        baseline.value = JSON.stringify({ ...(sameRecord ? before : record), createdAt: null })
      } else if (!keepEditor) baseline.value = ''
    }
    pending.value = pending.value.filter(item => item !== change)
    preview.value = null
    hint.value = current ? '已撤回这项暂存，当前输入仍保留；再次暂存会把上方内容重新加入待保存修改。' : '已撤回这项暂存'
    return true
  }
  async function submit(previewOnly = false) {
    if (busy.value || !pending.value.length || dirtyEditor.value) return
    const submission = clone(pending.value)
    const record = selected.value
    const editor = record ? { record, kind: record.kind, id: record.id, seq: detailSeq } : null
    const ownsEditor = () => !!editor && !disposed && selected.value === editor.record && detailSeq === editor.seq
      && editor.record.kind === editor.kind && editor.record.id === editor.id
    busy.value = true; hint.value = ''; preview.value = null
    try {
      const receipt = await catalogApi.changes(submission, previewOnly)
      if (previewOnly) preview.value = receipt
      else {
        pending.value = []; resetEditor(); useSceneStore().invalidate()
        hint.value = '已保存 ' + receipt.items.length + ' 项修改'; await load()
      }
    } catch (e) {
      hint.value = (e as Error).message
      if (editor && ownsEditor() && (e instanceof ApiClientError && (e.status === 409 || e.kind === 'network' || e.kind === 'timeout'))) {
        try {
          const current = (await catalogApi.record(editor.kind, editor.id)).record
          if (ownsEditor()) currentServer.value = clone(current)
        }
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
    if (!selected.value || !currentServer.value || editorPendingNotice.value) return
    if (selected.value.kind !== currentServer.value.kind || selected.value.id !== currentServer.value.id) return
    selected.value.revision = currentServer.value.revision; preview.value = null
    hint.value = '已对齐最新版本，请确认合并后的内容再保存'
  }
  async function restore(revision: number) {
    if (!selected.value || busy.value || editorPendingNotice.value || !await canSwitch()) return
    busy.value = true
    try {
      const old = (await catalogApi.record(selected.value.kind, selected.value.id, revision)).record
      selected.value.data = clone(old.data); selected.value.sortOrder = old.sortOrder
      hint.value = '已找回这版内容，确认后保存即可'
    } catch (e) { hint.value = (e as Error).message }
    finally { busy.value = false }
  }
  function parseBulk(raw: string) {
    bulkError.value = ''
    try {
      const value: unknown = JSON.parse(raw)
      if (value && typeof value === 'object' && Array.isArray((value as CatalogSnapshot).records)) {
        const snapshot = value as CatalogSnapshot
        if (snapshot.version !== 1 || !snapshot.records.every(isCatalogRecord) || !Array.isArray(snapshot.retired)) throw new Error('快照格式无效')
        importSnapshot.value = clone(snapshot); importPreview.value = false; return true
      }
      if (!value || typeof value !== 'object' || !Array.isArray((value as { changes?: unknown }).changes)) throw new Error('需要包含 changes 数组的变更文件')
      const file = value as { changes: CatalogChange[]; format?: unknown; version?: unknown; editor?: unknown; baseline?: unknown }
      const draft = 'editor' in file
      // Import the unversioned drafts produced before this format was introduced.
      if (draft && file.format !== undefined && (file.format !== 'huiyu-content-draft' || file.version !== 1)) throw new Error('不支持这份草稿的格式或版本')
      if (draft && (file.editor !== null && !isDraftRecord(file.editor)
        || file.baseline != null && !isDraftRecord(file.baseline))) throw new Error('草稿编辑内容格式无效')
      if (draft && dirtyEditor.value) throw new Error('请先保存或备份当前编辑，再恢复其他草稿')
      const changes = file.changes
      if ((!changes.length && !draft) || changes.some(c => !c || !['character', 'outfit', 'scene', 'blueprint', 'document'].includes(c.kind) || typeof c.id !== 'string' || !Number.isSafeInteger(c.expectedRevision))) throw new Error('每条修改需要 kind、id、expectedRevision')
      const keys = changes.map(c => key(c.kind, c.id)); if (new Set(keys).size !== keys.length) throw new Error('批量文件包含重复记录')
      const replacesEditor = !!selected.value && keys.includes(key(selected.value.kind, selected.value.id))
      if (!draft && replacesEditor && dirtyEditor.value) throw new Error('这些修改包含当前正在编辑的内容，请先暂存或备份当前编辑，再读取这份文件')
      if (draft) {
        resetEditor(clone(file.editor as CatalogRecord | null))
        baseline.value = file.baseline ? JSON.stringify(file.baseline) : ''
        if (selected.value) kind.value = selected.value.kind
        hint.value = '草稿已恢复，尚未写入内容库。请继续编辑并核对版本后保存。'
      } else if (replacesEditor) {
        resetEditor()
        hint.value = '已读取这些修改，请重新打开对应内容核对；局部修改或归档须先保存或撤回。'
      }
      pending.value = [...pending.value.filter(c => !keys.includes(key(c.kind, c.id))), ...clone(changes)]; preview.value = null
      if (draft && selected.value && !dirtyEditor.value) {
        const record = selected.value
        const change = pending.value.find(item => key(item.kind, item.id) === key(record.kind, record.id))
        if (!needsBatchReview(change)) {
          selected.value = editorRecord(record, change)
          baseline.value = JSON.stringify(selected.value)
        }
      }
      importSnapshot.value = null; importPreview.value = false
      return true
    } catch (e) { bulkError.value = (e as Error).message; return false }
  }
  function loadBulk() {
    if (busy.value || disposed) return
    ++bulkReadSeq
    parseBulk(bulkInput.value)
  }
  async function readBulkFile(file: Pick<File, 'text'>) {
    if (busy.value || disposed) return
    const seq = ++bulkReadSeq
    try {
      const raw = await file.text()
      if (seq !== bulkReadSeq || busy.value || disposed) return
      if (parseBulk(raw)) bulkInput.value = raw
    } catch (e) { if (seq === bulkReadSeq && !disposed) bulkError.value = (e as Error).message }
  }
  async function importContent(previewOnly: boolean) {
    if (!importSnapshot.value || busy.value || dirty.value || (!previewOnly && !importPreview.value)) return
    busy.value = true; hint.value = ''; preview.value = null
    try {
      const receipt = await catalogApi.importSnapshot(clone(importSnapshot.value), previewOnly)
      preview.value = receipt; importPreview.value = previewOnly
      if (!previewOnly) { resetEditor(); useSceneStore().invalidate(); hint.value = '快照已导入；本地修改与冲突按记录核对'; await load() }
    } catch (e) { importPreview.value = false; hint.value = (e as Error).message }
    finally { busy.value = false }
  }
  function download(value: unknown, name: string) {
    downloadBlob(new Blob([JSON.stringify(value, null, 2) + '\n'], { type: 'application/json' }), name)
  }
  const exportDraft = () => download({ format: 'huiyu-content-draft', version: 1, changes: pending.value,
    editor: selected.value, baseline: baseline.value ? JSON.parse(baseline.value) : null }, 'content-draft.json')
  async function exportSnapshot() { try { download(await catalogApi.snapshot(), 'content-snapshot.json') } catch (e) { hint.value = (e as Error).message } }
  watch(kind, invalidateDetail, { flush: 'sync' })
  watch([kind, character, category, rating, sort], () => { page.value = 1; void load() })
  watch(search, () => { clearTimeout(timer); timer = setTimeout(() => { page.value = 1; void load() }, 180) })
  watch(page, () => { if (page.value !== result.value?.page && page.value !== requestedPage) void load() })
  watch(bulkInput, () => { ++bulkReadSeq }, { flush: 'sync' })
  watch(busy, value => { if (value) ++bulkReadSeq }, { flush: 'sync' })
  watch(pending, () => { preview.value = null }, { deep: true })
  const release = registerMaintenanceParticipant(() => { if (dirty.value) throw new Error('UNSAVED_CONTENT'); if (busy.value) throw new Error('CONTENT_BUSY') })
  const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty.value || busy.value) event.preventDefault() }
  onMounted(() => { window.addEventListener('beforeunload', beforeUnload); void load() })
  onBeforeUnmount(() => { disposed = true; ++bulkReadSeq; ++listSeq; invalidateDetail(); clearHistory(); listController?.abort(); detailController?.abort(); namesController?.abort(); clearTimeout(timer); release(); window.removeEventListener('beforeunload', beforeUnload) })
  onBeforeRouteLeave(async () => !busy.value && (!dirty.value || await confirmAction({ title: '离开内容维护？', message: '未保存修改将丢失，可先导出草稿。', confirmLabel: '离开', danger: true })))
  return { kind, search, character, category, rating, sort, page, result, listScope, listMatchesKind, counts, loading, error, hint, selected, currentServer, detailLoading, pending, busy, preview, history, historyLoading, historyError, loadHistory, dirtyEditor, dirty, editorPendingNotice, totalPages, bulkInput, bulkError, importSnapshot, importPreview, importContent, load, select, add, stage, remove, withdrawPending, submit, compareCurrent, adoptRevision, restore, loadBulk, readBulkFile, exportDraft, exportSnapshot, characterNames }
}

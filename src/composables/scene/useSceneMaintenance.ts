import { getDesktopCapabilities } from '../../platform/desktop/capabilities.ts'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch, type Ref } from 'vue'
import { ApiClientError } from '../../api/client.ts'
import { maintenanceApi } from '../../api/maintenanceApi.ts'
import type { BackupEntry } from '../../api/maintenanceApi.ts'
import type { SceneDraft, TagRecord, CurationData, SceneChangesPreview, SceneMaintenanceSnapshot } from '../../types/api.ts'
import type { SceneBlueprint } from '../../utils/popularContent.ts'
import { buildSceneChangeSet, cloneSceneSnapshot, hasSceneChanges, sceneContentKey } from '../../utils/sceneChanges.ts'
import { isSceneId } from '../../utils/sceneId.ts'
import { confirmAction } from '../useConfirm.ts'

export interface SceneMaintenanceDeps {
  scenes: Ref<SceneDraft[]>
  tags: Ref<TagRecord[]>
  curation: Ref<CurationData>
  /** 可选：热门角色蓝图，保存时随场景一起写回 scene-blueprints.json。 */
  blueprints: Ref<SceneBlueprint[]>
  /** 宿主持有的脏标记（编辑/导入/标签/策展/蓝图任一改动置位）。 */
  dirty: Ref<boolean>
  loading: Ref<boolean>
  /** 宿主持有的维护提示通道（保存进度/备份编号/桌面只读提示共用）。 */
  maintenanceHint: Ref<string>
  /** 同一响应取得的不可变完整快照和版本；缺少任一项都禁止写入。 */
  baseVersion: () => number | null
  baselineSnapshot: () => SceneMaintenanceSnapshot | null
  adoptSceneState: (version: number, snapshot: SceneMaintenanceSnapshot) => void
  /** Includes open editor forms so edits not yet applied to the list are protected too. */
  editSessionKey?: () => string
  /** 保存成功后作废共享缓存（其他页面正拿着写回前的旧副本）。 */
  invalidateSceneCache: () => void
}

const TOOLS: Array<{ id: string; iconName: 'palette' | 'success' | 'filter' | 'gear'; label: string; desc: string }> = [
  { id: 'lint-colors', iconName: 'palette', label: '检查硬编码颜色', desc: '扫描未用 token 的硬编码颜色（建议用 npm run design:lint）' },
  { id: 'validate',    iconName: 'success', label: '完整场景校验',   desc: 'ID 唯一性、字段完整性、评级一致性' },
  { id: 'classify',    iconName: 'filter',  label: '更新场景评级',   desc: '根据标签重新计算 All/R15/R18' },
  { id: 'optimize',    iconName: 'gear',    label: '规范化提示词',   desc: '统一标签命名、补全负面词' },
]

/**
 * 场景管理页「维护任务」簇（2026-08-22 自 SceneManagerView 下沉）。
 *
 * 基于不可变基线的变更集保存、只读影响预览、维护工具和备份历史。
 * 桌面打包模式探测（data 只读、保存与维护任务禁用）在此自持。
 */
export function useSceneMaintenance(deps: SceneMaintenanceDeps) {
  const { scenes, tags, curation, blueprints, dirty, maintenanceHint } = deps

  const saving = ref(false)
  const savingPhase = ref('')
  const toolRunning = ref(false)
  const toolResult = ref<{ ok: boolean; output: string } | null>(null)
  const toolResultTitle = ref('')
  const backups = ref<BackupEntry[]>([])
  const backupsLoading = ref(false)
  const backupsError = ref('')
  const backupsExpanded = ref(false)
  /** 桌面打包模式：data 在只读应用包内，场景保存与维护任务不可用 */
  const desktopPackaged = ref(!!getDesktopCapabilities())
  const importConfirming = ref(false)
  const needsReload = ref(false)
  const preview = shallowRef<SceneChangesPreview | null>(null)
  const previewing = ref(false)
  const previewError = ref('')
  const previewInvalidated = ref(false)
  const previewEmpty = ref(false)
  const previewCompanions = ref<string[]>([])
  let previewController: AbortController | null = null
  let previewRequest = 0

  const canPreview = computed(() => !deps.loading.value && !saving.value && !previewing.value
    && !toolRunning.value && !desktopPackaged.value && !importConfirming.value && !needsReload.value && deps.baselineSnapshot() !== null
    && Number.isSafeInteger(deps.baseVersion()))
  const canSave = computed(() => canPreview.value && dirty.value)
  const currentSnapshot = (): SceneMaintenanceSnapshot => ({
    scenes: scenes.value, tags: tags.value, curation: curation.value, blueprints: blueprints.value,
  })

  function invalidatePreview() {
    previewInvalidated.value ||= preview.value !== null || previewing.value
    previewRequest++
    previewController?.abort()
    previewController = null
    preview.value = null
    previewing.value = false
    previewError.value = ''
    previewEmpty.value = false
    previewCompanions.value = []
  }
  // Invalidate synchronously: an old response must never become the current draft's preview.
  watch([scenes, tags, curation, blueprints, deps.baseVersion, deps.baselineSnapshot, deps.loading, desktopPackaged, () => deps.editSessionKey?.() ?? ''],
    invalidatePreview, { deep: true, flush: 'sync' })
  watch([deps.baseVersion, deps.baselineSnapshot], () => { needsReload.value = false }, { flush: 'sync' })
  onBeforeUnmount(invalidatePreview)

  const previewGroups = computed(() => {
    const impact = preview.value
    if (!impact) return []
    const baseline = deps.baselineSnapshot()
    const collections = [
      { key: 'scenes', label: '场景', impact, records: [...(baseline?.scenes ?? []), ...scenes.value] },
      { key: 'blueprints', label: '蓝图', impact: impact.blueprints, records: [...(baseline?.blueprints ?? []), ...blueprints.value] },
    ]
    return collections.flatMap(collection => {
      const titles = new Map(collection.records.map(item => [item.id, item.title]))
      return (['added', 'updated', 'removed'] as const).map(action => ({
        key: `${collection.key}-${action}`,
        label: `${collection.label} · ${{ added: '新增', updated: '修改', removed: '退役 / 移除' }[action]}`,
        items: collection.impact[action].map(id => ({ id, title: titles.get(id) || '未提供标题' })),
      }))
    })
  })

  function prepareSubmission() {
    if (needsReload.value) throw new Error('请先导出本地草稿，再重新读取并合并后保存')
    const baseVersion = deps.baseVersion()
    const baseline = deps.baselineSnapshot()
    if (baseVersion === null || !Number.isSafeInteger(baseVersion) || !baseline) {
      throw new Error('缺少完整读取基线。请先导出本地草稿，再重新读取并合并改动')
    }
    const snapshot = cloneSceneSnapshot(currentSnapshot())
    const changeSet = buildSceneChangeSet(baseline, snapshot)
    if (!hasSceneChanges(changeSet)) {
      dirty.value = false
      maintenanceHint.value = '没有需要保存的变更'
      return null
    }
    if (!snapshot.scenes.length) throw new Error('场景库不能为空，请保留至少一个场景；当前草稿仍可导出')
    return { snapshot, baseline, editKey: deps.editSessionKey?.() ?? '', payload: { baseVersion, changeSet } }
  }

  function errorMessage(error: unknown, fallback: string) {
    if (error instanceof Error && error.message) return error.message
    const text = String(error ?? '').trim()
    return text || fallback
  }

  function maintenanceErrorMessage(error: unknown, fallback: string) {
    if (!(error instanceof ApiClientError) || !error.responseBody) return errorMessage(error, fallback)
    const output = typeof error.responseBody.output === 'string' ? error.responseBody.output.trim() : ''
    const recovery = typeof error.responseBody.recovery === 'string' ? error.responseBody.recovery.trim() : ''
    const message = output || errorMessage(error, fallback)
    return recovery && !message.includes(recovery) ? `${message}；${recovery}` : message
  }

  /** 旧快照冲突（409）转成可操作提示：先「重新读取」再决定如何合并。 */
  function conflictMessage(error: unknown): string | null {
    if (!(error instanceof ApiClientError) || !error.responseBody) return null
    const conflict = (error.responseBody as { conflict?: { serverOnlyIds?: string[]; changedIds?: string[]; clientNewIds?: string[]; baseVersion?: number; currentVersion?: number | null } }).conflict
    if (!conflict && error.status !== 409) return null
    const parts: string[] = []
    if (conflict?.serverOnlyIds?.length) parts.push('服务器多出 ' + conflict.serverOnlyIds.join(', '))
    if (conflict?.changedIds?.length) parts.push('同 ID 内容有差异 ' + conflict.changedIds.join(', '))
    if (conflict?.clientNewIds?.length) parts.push('本次新增 ' + conflict.clientNewIds.join(', '))
    const detail = parts.length ? '；差异：' + parts.join('；') : ''
    return '保存已拒绝：场景库在本次编辑期间被更新'
      + (typeof conflict?.baseVersion === 'number' && typeof conflict.currentVersion === 'number'
        ? `（读取基线 ${conflict.baseVersion}，当前 ${conflict.currentVersion}）` : '')
      + '。请先导出本地草稿，再点「重新读取」并合并改动' + detail
  }

  async function previewChanges() {
    if (deps.loading.value || saving.value || previewing.value || toolRunning.value || desktopPackaged.value || importConfirming.value) return
    invalidatePreview()
    previewInvalidated.value = false
    const request = previewRequest
    try {
      const submission = prepareSubmission()
      if (!submission) { previewEmpty.value = true; return }
      const controller = new AbortController()
      previewController = controller
      previewing.value = true
      const result = await maintenanceApi.previewSceneChanges(submission.payload, { signal: controller.signal })
      if (request !== previewRequest) return
      if (result.baseVersion !== submission.payload.baseVersion || result.version !== submission.payload.baseVersion) {
        throw new Error('预览版本与读取基线不一致，请先导出草稿，再重新读取并合并')
      }
      preview.value = result
      previewCompanions.value = [
        ...(submission.payload.changeSet.tags !== undefined ? ['标签库有修改'] : []),
        ...(submission.payload.changeSet.curation !== undefined ? ['策展有修改'] : []),
      ]
    } catch (error) {
      if (request === previewRequest) {
        previewError.value = conflictMessage(error) ?? maintenanceErrorMessage(error, '读取影响预览失败，请重试')
        if (error instanceof ApiClientError && error.status === 409) needsReload.value = true
      }
    } finally {
      if (request === previewRequest) { previewing.value = false; previewController = null }
    }
  }

  async function persistSceneDraft(mode: 'changes' | 'import') {
    if (!dirty.value || deps.loading.value || saving.value || previewing.value || toolRunning.value || desktopPackaged.value || importConfirming.value) return
    invalidatePreview()
    try {
      const submission = prepareSubmission()
      if (!submission) return
      if (mode === 'import') {
        importConfirming.value = true
        if (!(await confirmAction(`全量导入当前草稿到项目？将写入 ${submission.snapshot.scenes.length} 个场景、${submission.snapshot.blueprints.length} 个蓝图，退役 ${submission.payload.changeSet.scenes.remove.length} 个场景。此操作会创建备份。`))) return
        if (sceneContentKey(currentSnapshot()) !== sceneContentKey(submission.snapshot)
          || deps.baseVersion() !== submission.payload.baseVersion || deps.baselineSnapshot() !== submission.baseline
          || (deps.editSessionKey?.() ?? '') !== submission.editKey) throw new Error('确认期间草稿已变化，请重新查看预览并导入')
        importConfirming.value = false
      }
      saving.value = true
      savingPhase.value = '正在提交变更并校验…'
      maintenanceHint.value = '正在保存并检查…'
      const data = mode === 'import'
        ? await maintenanceApi.importScenesSnapshot({ ...submission.snapshot, baseVersion: submission.payload.baseVersion })
        : await maintenanceApi.saveSceneChanges(submission.payload)
      const editedDuringSave = sceneContentKey(currentSnapshot()) !== sceneContentKey(submission.snapshot)
        || deps.baseVersion() !== submission.payload.baseVersion || deps.baselineSnapshot() !== submission.baseline
        || (deps.editSessionKey?.() ?? '') !== submission.editKey
      if (!editedDuringSave) {
        const saved = cloneSceneSnapshot(data.snapshot)
        scenes.value = saved.scenes
        tags.value = saved.tags
        curation.value = saved.curation
        blueprints.value = saved.blueprints
        deps.adoptSceneState(data.version, data.snapshot)
      }
      dirty.value = editedDuringSave
      needsReload.value = editedDuringSave
      maintenanceHint.value = data.count + ' 个场景已同步；备份编号 ' + data.backup
        + (editedDuringSave ? '；保存期间有新修改，已保留草稿。请先导出，再重新读取并合并后保存' : '')
      // 作废共享缓存：其他页面正拿着写回前的旧副本
      deps.invalidateSceneCache()
    } catch (e) {
      if (e instanceof ApiClientError && e.status === 409) needsReload.value = true
      maintenanceHint.value = '保存未完成：' + (conflictMessage(e) ?? maintenanceErrorMessage(e, '请重试'))
    } finally {
      saving.value = false
      importConfirming.value = false
      savingPhase.value = ''
    }
  }

  async function runTool(taskId: string) {
    if (deps.loading.value || toolRunning.value || saving.value || previewing.value || desktopPackaged.value || importConfirming.value) return
    const tool = TOOLS.find(t => t.id === taskId)
    if (!tool) return
    invalidatePreview()
    toolRunning.value = true
    toolResultTitle.value = tool.iconName + ' ' + tool.label
    toolResult.value = { ok: true, output: '...' }
    try {
      const data = await maintenanceApi.run(taskId)
      toolResult.value = { ok: true, output: data.output || '(no output)' }
    } catch (e) {
      toolResult.value = { ok: false, output: maintenanceErrorMessage(e, '请重试') }
    } finally {
      toolRunning.value = false
    }
  }

  async function loadBackups() {
    if (backupsLoading.value) return
    backupsLoading.value = true; backupsError.value = ''
    try {
      const data = await maintenanceApi.listBackups()
      backups.value = (data.entries || []) as BackupEntry[]
      backupsExpanded.value = true
    } catch (e) {
      backupsError.value = maintenanceErrorMessage(e, '读取备份历史失败')
    } finally { backupsLoading.value = false }
  }

  function formatBackupTime(v: string) {
    if (!v) return '—'
    try { const d = new Date(v); if (isNaN(d.getTime())) return v; return d.toLocaleString('zh-CN', { hour12: false }) } catch { return v }
  }

  const highlightedToolOutput = computed(() => {
    const src = toolResult.value?.output || ''
    const safe = String(src || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    return safe.replace(/\bsc\d+\b/g, id => isSceneId(id) ? `<span class="hl-id">${id}</span>` : id)
  })
  // 模板兼容别名
  const highlightedOutput = highlightedToolOutput

  onMounted(() => {
    if (getDesktopCapabilities()) {
      getDesktopCapabilities()!.isPackaged().then(packaged => {
        desktopPackaged.value = packaged
        if (packaged) maintenanceHint.value = '桌面应用模式：场景内容位于只读应用包内，保存与维护任务不可用'
      }).catch(() => { maintenanceHint.value = '无法确认桌面写入状态，已保持只读，请重新读取' })
    }
  })

  return {
    TOOLS,
    saving,
    savingPhase,
    toolRunning,
    toolResult,
    toolResultTitle,
    backups,
    backupsLoading,
    backupsError,
    backupsExpanded,
    desktopPackaged,
    saveToProject: () => persistSceneDraft('changes'),
    importSnapshotToProject: () => persistSceneDraft('import'),
    importConfirming,
    canSave, canPreview, preview, previewing, previewError, previewInvalidated, previewEmpty,
    previewCompanions, previewGroups, previewChanges,
    runTool,
    loadBackups,
    formatBackupTime,
    highlightedOutput,
  }
}

import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { CompanionDesktopBridge } from '../../types/desktop'

/** Companion keeps a draft locally; the desktop bridge owns the saved directory. */
export function useWorkspaceDirectorySettings(
  bridge: Pick<CompanionDesktopBridge, 'getWorkspace' | 'setWorkspace'> | undefined,
  feedback: (message: string, kind: 'info' | 'error') => void,
) {
  const workspaceOpen = ref(false), workspaceInput = ref(''), workspaceExists = ref(false)
  const workspaceSaving = ref(false), workspaceError = ref('')
  const workspaceSavedRoot = ref(''), workspaceRestartRequired = ref(false)
  let alive = true, readRevision = 0, draftRevision = 0
  const workspaceTooltip = computed(() => workspaceRestartRequired.value
    ? `AI 工作区已保存：${workspaceSavedRoot.value}；完全退出并重启绘遇后生效`
    : workspaceExists.value ? `AI 工作区：${workspaceSavedRoot.value || '已配置'}`
      : '未配置 AI 工作区：样张预览与训练不可用，点击设置')

  watch(workspaceInput, () => { draftRevision++ }, { flush: 'sync' })
  watch(workspaceOpen, open => {
    readRevision++
    if (open) {
      // Do not offer an old directory for saving while another entry point may
      // have changed it. Manual typing remains possible and owns the new draft.
      workspaceInput.value = ''; workspaceError.value = ''
      void refresh()
    }
  }, { flush: 'sync' })
  async function refresh() {
    if (!bridge) return
    const revision = ++readRevision, draft = draftRevision
    try {
      const workspace = await bridge.getWorkspace()
      if (!alive || revision !== readRevision) return
      if (draft === draftRevision) workspaceInput.value = workspace.root
      workspaceSavedRoot.value = workspace.root
      workspaceExists.value = workspace.exists
      workspaceRestartRequired.value = workspace.restartRequired
    } catch {
      if (alive && revision === readRevision && workspaceOpen.value)
        workspaceError.value = '当前工作区状态读取失败，请重新打开设置，或手动指定目录后保存。'
    }
  }
  async function saveWorkspace() {
    if (!bridge || workspaceSaving.value || !workspaceOpen.value) return
    const value = workspaceInput.value.trim()
    if (!value) return
    readRevision++
    workspaceSaving.value = true; workspaceError.value = ''
    try {
      const result = await bridge.setWorkspace(value)
      if (!alive) return
      workspaceInput.value = workspaceSavedRoot.value = result.root
      workspaceExists.value = result.exists
      workspaceRestartRequired.value = result.restartRequired
      workspaceOpen.value = false
      feedback(result.restartRequired ? 'AI 工作区已保存，完全退出并重启绘遇后生效。' : 'AI 工作区已保存，当前目录已生效。', 'info')
    } catch (error) {
      if (!alive) return
      workspaceError.value = error instanceof Error ? error.message : '工作区设置失败'
      feedback(workspaceError.value, 'error')
    } finally { workspaceSaving.value = false }
  }
  onMounted(() => { void refresh() })
  onUnmounted(() => { alive = false; readRevision++ })
  return { workspaceOpen, workspaceInput, workspaceExists, workspaceSaving, workspaceError,
    workspaceRestartRequired, workspaceTooltip, saveWorkspace }
}

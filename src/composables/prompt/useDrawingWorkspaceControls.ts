import { computed, nextTick, ref, shallowRef, type Ref } from 'vue'
import type { useDrawingCanvas } from '@/composables/prompt/useDrawingCanvas'
import type { useDirectorLayout } from '@/composables/prompt/useDirectorLayout'
import { isMossLayoutInput } from '@/utils/mossLayout'

export const loadGeneratedSceneDialog = () => import('@/components/maintenance/GeneratedSceneDialog.vue')
export const loadInspectorRender = () => import('@/components/director/PromptInspectorRender.vue')
export const loadInspectorPrompt = () => import('@/components/director/PromptInspectorPrompt.vue')
export const loadInspectorDelivery = () => import('@/components/director/PromptInspectorDelivery.vue')
export const loadDataTools = () => import('@/components/PromptDataTools.vue')
export const loadHistoryReuseDialog = () => import('@/components/director/HistoryReuseDialog.vue')
export const loadHistoryPanel = () => import('@/components/HistoryPanel.vue')
export const loadStoryPanel = () => import('@/components/director/DirectorStoryPanel.vue')
export const loadCharacterPanel = () => import('@/components/director/DirectorCharacterPanel.vue')
export const loadMaterialScenes = () => import('@/components/director/PromptMaterialScenes.vue')
export const loadImageTools = () => import('@/components/director/DirectorImageTools.vue')
export const loadNativeControls = () => import('@/components/director/NativeDrawingControls.vue')
export const loadNativePrompt = () => import('@/components/director/NativeDrawingPrompt.vue')

const INTERROGATE_ASSIST_KEY = 'aics_interrogate_assist_v1'

export function useDrawingWorkspaceControls(params: {
  workspace: ReturnType<typeof useDrawingCanvas>
  layoutRoot: Ref<HTMLElement | null>
  stagePanel: Ref<{ playClear: () => void } | null>
  directorLayout: ReturnType<typeof useDirectorLayout>
}) {
  const { workspace, layoutRoot, stagePanel, directorLayout } = params
  const {
    pb,
    native,
    route,
    engineOnline,
    currentBlueprintData,
    selectPopularSource,
    generationBusy,
    animaState,
    drawEngine,
    inspector,
    materialDrawer,
    onClearResult,
    genBarSize,
    generateBlockReason,
  } = workspace

  const canvasSizeManuallySet = ref(false)
  function setCanvasSize(value: string) {
    canvasSizeManuallySet.value = true
    genBarSize.value = value
  }
  const customMossLayout = computed(() => Boolean(native.mossLayout.value || native.usingMossTaskPrompt.value
    || isMossLayoutInput(pb.visualDescription)))
  const animaSizeLimits = computed(() => drawEngine.value === 'anima'
    ? animaState.value.models.find(model => model.id === animaState.value.modelId)?.capabilities?.customSize
    : undefined)
  const getBlueprint = () => currentBlueprintData.value
  const resizeSides = computed(() => pb.focusMode || directorLayout.compact.value ? []
    : (['materials', 'inspector'] as const).filter(side => !directorLayout.collapsed.value[side]))
  const materialsVisible = computed(() => !pb.focusMode && (!directorLayout.desktop.value || !directorLayout.collapsed.value.materials))
  const inspectorVisible = computed(() => !pb.focusMode && (!directorLayout.desktop.value || !directorLayout.collapsed.value.inspector))
  const actionBarDocked = computed(() => directorLayout.desktop.value && inspectorVisible.value)

  const popularSourceLoading = ref(false)
  let characterSelection = 0
  async function selectCharacterSource(source: 'studio' | 'popular' | 'none') {
    const request = ++characterSelection
    const subject = pb.subject
    if (source === 'popular') {
      popularSourceLoading.value = true
      try {
        await Promise.all([
          pb.loadPopularCatalog(),
          import('@/components/popular/PopularCharacterPicker.vue').catch(() => undefined),
        ])
      }
      catch { if (request === characterSelection) pb.flash('热门角色暂时无法读取，请重试。'); return }
      finally { if (request === characterSelection) popularSourceLoading.value = false }
      if (request !== characterSelection || route.path !== '/prompt-builder' || pb.subject !== subject) return
    }
    selectPopularSource(source)
  }

  const descriptionInHeader = computed(() => pb.focusMode)
  const exampleEditButton = ref<HTMLButtonElement | null>(null)
  const drawingSetupRoute = computed(() => {
    const requested = route.query.preparedModel
    const model = typeof requested === 'string' ? requested : native.session.value?.form.modelId
    const provider = animaState.value.provider
    const hash = !native.mode.value && provider === 'comfy' ? '#control-comfy'
      : model || provider === 'native' ? '#control-setup' : '#control-inference'
    return { path: '/control', hash, query: model ? { model } : {} }
  })

  const interrogateMode = computed(() => drawEngine.value === 'krea2' || drawEngine.value === 'moss' && pb.isUnbound ? 'caption' : 'tag')
  const interrogateSubjectMode = computed<'free' | 'bound'>(() => pb.isUnbound ? 'free' : 'bound')
  const interrogateAssist = ref(false)
  try { interrogateAssist.value = localStorage.getItem(INTERROGATE_ASSIST_KEY) === '1' } catch { /* Storage can be unavailable. */ }
  const interrogateLayout = computed(() => interrogateAssist.value
    && (drawEngine.value === 'moss' || drawEngine.value === 'anima' && !pb.isUnbound))
  function setInterrogateAssist(value: boolean) {
    interrogateAssist.value = value
    try { localStorage.setItem(INTERROGATE_ASSIST_KEY, value ? '1' : '0') } catch { /* Keep the current session usable. */ }
  }

  const drawingHasContent = computed(() => !!(pb.castRequiresNoLora && (drawEngine.value === 'moss' || drawEngine.value === 'anima')
    || pb.visualDescription.trim() || pb.story.trim() || pb.sceneId
    || !pb.referenceInput?.captionInEditor && pb.referenceInput?.caption
    || drawEngine.value === 'moss' && pb.referenceInput?.layout
    || pb.subject.kind === 'popular' && pb.subject.blueprintId || pb.manualTags.size || native.mossLayout.value || native.usingMossTaskPrompt.value))
  const canFillExample = computed(() => workspace.draftReady.value && engineOnline.value && !generationBusy.value
    && !workspace.preparedModelPending.value && !drawingHasContent.value)
  const firstDrawingHint = computed(() => {
    if (!workspace.draftReady.value) return '正在恢复画室…'
    if (workspace.preparedModelPending.value) return '请先确认从控制室选用的绘图模型。'
    if (!engineOnline.value) return '绘图模型尚未就绪。可从上方状态重新检查，或返回绘图配置。'
    if (drawingHasContent.value && generateBlockReason.value && !generationBusy.value) return generateBlockReason.value
    return drawingHasContent.value ? '画面已准备好。确认描述后点击「生成图片」。' : '填入示例或写下画面描述，然后点击「生成图片」。'
  })
  async function fillExample(event: MouseEvent) {
    if (!canFillExample.value) return
    const transferFocus = document.activeElement === event.currentTarget
    pb.visualDescription = 'An anime illustration of a young woman sitting by a studio window, warming her hands around an ivory teacup. A soft afternoon beam catches the steam, with books and a small vase in the background. Medium shot, warm natural light.'
    await nextTick()
    if (transferFocus && document.activeElement === document.body) exampleEditButton.value?.focus({ preventScroll: true })
  }

  const currentSceneTitle = computed(() => {
    const subject = pb.subject
    return subject.kind === 'popular'
      ? pb.sceneBlueprints.find(scene => scene.id === subject.blueprintId && scene.characterId === subject.characterId)?.title
      : pb.activeScene?.title
  })
  const activeCharacterId = computed(() => pb.subject.kind === 'popular' ? pb.subject.characterId : pb.char)
  const currentCharacterLabel = computed(() => {
    const subject = pb.subject
    if (subject.kind === 'popular') {
      const found = pb.popularCharacters.find(item => item.id === subject.characterId)
      return found?.displayName || '热门角色'
    }
    if (pb.castLead?.source === 'custom') return pb.castLead.name || '原创角色'
    if (pb.isUnbound) return '无角色'
    return pb.char === 'natsume' ? '四季夏目' : pb.char === 'triad' ? '宁宁与夏目' : '绫地宁宁'
  })

  const dataToolsComp = shallowRef<Awaited<ReturnType<typeof loadDataTools>>['default']>()
  const dataToolsOpen = ref(false)
  const dataToolsLoading = ref(false)

  async function openDataTools() {
    if (dataToolsLoading.value) return
    if (dataToolsComp.value) {
      dataToolsOpen.value = true
      return
    }
    dataToolsLoading.value = true
    try {
      const mod = await loadDataTools()
      dataToolsComp.value = mod.default
      await nextTick()
      dataToolsOpen.value = true
    } catch {
      pb.flash('数据工具暂未加载，请刷新页面后重试。')
    } finally {
      dataToolsLoading.value = false
    }
  }
  async function openMaterials(section: string) {
    pb.focusMode = false
    directorLayout.show('materials')
    await nextTick()
    await materialDrawer.value?.selectSection(section)
  }
  async function openRecovery() {
    pb.focusMode = false
    if (directorLayout.desktop.value) directorLayout.show('inspector')
    await nextTick()
    await inspector.value?.selectSection(drawEngine.value === 'sd' ? 'delivery' : 'render', true)
  }
  async function toggleLayout(side: 'materials' | 'inspector') {
    directorLayout.toggle(side)
    await nextTick()
    if (directorLayout.compact.value && side === 'materials' && !directorLayout.collapsed.value.materials)
      layoutRoot.value?.querySelector<HTMLButtonElement>('.material-switch button[aria-selected="true"]')?.focus({ preventScroll: true })
  }
  async function closeCompactMaterials(event: Event) {
    if (!directorLayout.compact.value || directorLayout.collapsed.value.materials || event.defaultPrevented) return
    if (event instanceof KeyboardEvent && (event.isComposing || event.keyCode === 229)) return
    event.preventDefault()
    event.stopPropagation()
    directorLayout.toggle('materials')
    await nextTick()
    document.getElementById('director-materials-toggle')?.focus()
  }
  async function resetLayout() {
    directorLayout.reset()
    if (directorLayout.compact.value) {
      await nextTick()
      document.getElementById('director-materials-toggle')?.focus()
    }
  }

  let descriptionFocusPending = false
  async function editDescription() {
    descriptionFocusPending = true
    await openMaterials('story')
    focusDescription()
  }
  function focusDescription() {
    if (!descriptionFocusPending) return
    const input = layoutRoot.value?.querySelector<HTMLTextAreaElement>('#visualDescription')
    if (!input) return
    descriptionFocusPending = false
    if (!input.getClientRects().length) return
    input?.focus({ preventScroll: true })
    input?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
  }
  function clearCanvasResult() {
    stagePanel.value?.playClear()
    onClearResult()
  }

  return {
    canvasSizeManuallySet,
    setCanvasSize,
    customMossLayout,
    animaSizeLimits,
    getBlueprint,
    resizeSides,
    materialsVisible,
    inspectorVisible,
    actionBarDocked,
    popularSourceLoading,
    selectCharacterSource,
    descriptionInHeader,
    exampleEditButton,
    drawingSetupRoute,
    interrogateMode,
    interrogateSubjectMode,
    interrogateAssist,
    interrogateLayout,
    setInterrogateAssist,
    canFillExample,
    firstDrawingHint,
    fillExample,
    currentSceneTitle,
    activeCharacterId,
    currentCharacterLabel,
    dataToolsComp,
    dataToolsOpen,
    dataToolsLoading,
    openDataTools,
    openMaterials,
    openRecovery,
    toggleLayout,
    closeCompactMaterials,
    resetLayout,
    editDescription,
    focusDescription,
    clearCanvasResult,
  }
}

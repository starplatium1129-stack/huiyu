<template>
  <article
    class="pb journal-workspace atelier-workspace"
    :data-character="pb.subject.kind === 'popular' ? pb.subject.characterId : pb.char"
    :style="[currentCharacterThemeStyle, directorLayout.style.value]"
    :data-materials-collapsed="directorLayout.collapsed.value.materials || undefined"
    :data-inspector-collapsed="directorLayout.collapsed.value.inspector || undefined"
    :data-resizing="directorLayout.dragging.value || undefined"
    :data-subject="pb.subject.kind"
    :data-director-mode="pb.directorMode"
    :data-compact-workspace="directorLayout.compact.value || undefined"
    :class="{
      'focus-mode': pb.focusMode,
      'has-result': Boolean(displayResultUrl),
      'character-shifting': characterShifting,
    }"
  >

    <div class="pb-topline">
      <div class="pb-header">
        <div class="pb-heading-row">
          <h1 class="pb-title">绘图画室</h1>
          <div class="api-status">
            <StudioTooltip :content="engineOnline ? '点击重新检测' : `${engineStatusText}；点击重新检测`">
              <button class="badge" :class="engineOnline ? 'badge-online' : 'badge-offline'" type="button"
                @click="recheckEngineConnection">
                <ArchiveIcon :name="engineOnline ? 'success' : 'warning'" />
                <span>{{ drawEngineLabel }} {{ engineOnline ? '已连接' : '未连接' }}</span>
              </button>
            </StudioTooltip>
            <RouterLink v-if="!engineOnline" class="api-recovery-link" :to="{ path: '/control', query: { engine: drawEngine } }">控制面板</RouterLink>
          </div>
        </div>
        <div class="pb-header-meta"><p class="pb-sub">让想象成形，让故事相遇。</p><PromptDraftNotice :blueprint="currentBlueprintData" /></div>
      </div>
      <div class="pb-top-actions">
        <div class="pb-mode-actions">
          <button v-if="descriptionInHeader"
            class="btn btn-ghost btn-sm" type="button" @click="editDescription">
            <ArchiveIcon name="spark" />编辑画面描述
          </button>
          <DirectorModeSwitch :model-value="pb.directorMode" @update:model-value="setDirectorMode" />
          <DirectorLayoutControls v-if="!pb.focusMode" :collapsed="directorLayout.collapsed.value" @toggle="toggleLayout" />
          <button class="focus-mode-btn" type="button"
            :aria-label="pb.focusMode ? '退出专注成片模式' : '进入专注成片模式'"
            :aria-pressed="pb.focusMode"
            @click="pb.focusMode = !pb.focusMode">
            <ArchiveIcon :name="pb.focusMode ? 'compress' : 'expand'" class="focus-mode-icon" aria-hidden="true" />
            <span class="focus-mode-label">{{ pb.focusMode ? '退出专注' : '专注成片' }}</span>
          </button>
        </div>
        <div class="pb-utility-actions">
          <HistoryRestoreNotice v-if="pb.historyRestoreReport" :context="workspace.recipePreviewContext" :mode="pb.directorMode" @expert="setDirectorMode('pro')" />
          <RandomInspirationButton compact />
          <PromptDataTools
            launcher-label="数据工具"
            :blueprint-data="currentBlueprintData"
            @flash="pb.flash"
            @load-blueprint="handleLoadBlueprint"
          />
        </div>
      </div>
    </div>

    <nav v-if="pb.directorMode !== 'pro'" class="drawing-jump-links tw:w-fit tw:rounded-pill tw:p-s-1" data-fluid-glass aria-label="绘制区快捷导航">
      <a href="#drawing-materials">创作素材</a><a href="#drawing-canvas">画布预览</a><a href="#stepResult">输出设置</a>
    </nav>
    <div ref="layoutRoot" class="director-workspace">
      <!-- One action bar: inspector on wide screens, workspace-wide sticky row on narrow screens. -->
      <Teleport :to="inspectorActions" :disabled="!actionBarDocked">
        <GenerationActionBar
          :engine="drawEngine"
          :busy="generationBusy"
          :progress="generationProgress"
          :online="engineOnline"
          :size="genBarSize"
          :anima-sizes="animaBarSizes"
          :show-size="!actionBarDocked" :docked="actionBarDocked"
          :blocked-reason="generateBlockReason"
          :has-result="Boolean(displayResultUrl)"
          :completed="drawEngine !== 'sd' && animaState.phase === 'succeeded'"
          :status-text="generationStatusText"
          :error="generationError"
          :stopped="generationStopped"
          @update:size="genBarSize = $event"
          @generate="callGenerate()"
          @cancel="cancelGeneration"
        />
      </Teleport>
      <DirectorResizeHandle v-if="!pb.focusMode && !directorLayout.compact.value && !directorLayout.collapsed.value.materials" side="materials" :width="directorLayout.materialsWidth.value"
        @start="directorLayout.start('materials', $event)" @move="directorLayout.move" @finish="directorLayout.finish" @key="directorLayout.key('materials', $event)" @reset="directorLayout.reset" />
      <DirectorResizeHandle v-if="!pb.focusMode && !directorLayout.compact.value && !directorLayout.collapsed.value.inspector" side="inspector" :width="directorLayout.inspectorWidth.value"
        @start="directorLayout.start('inspector', $event)" @move="directorLayout.move" @finish="directorLayout.finish" @key="directorLayout.key('inspector', $event)" @reset="directorLayout.reset" />

      <!-- ─── 中栏：监视器 ────────────────────────────────── -->
      <div class="director-col col-center" id="drawing-canvas">

        <DirectorStagePanel
          ref="stagePanel"
          :canvas-size="genBarSize"
          :display-result-url="displayResultUrl"
          :scene-title="currentSceneTitle"
          :result-reveal-url="resultRevealUrl"
          :generation-busy="generationBusy"
          :generation-error="generationError"
          :generation-stopped="generationStopped"
          :generation-status-text="generationStatusText"
          :generation-progress="generationProgress"
          :anima-elapsed="animaState.elapsedSeconds"
          :draw-engine="drawEngine"
          :inpaint-original-url="inpaintOriginalUrl"
          :inpaint-compare-active="inpaintCompareActive"
          :has-prev-result="!!prevResult"
          :result-archived="resultArchived"
          :saving-result="savingResult"
          :capturing-scene="capturingScene"
          :result-temporary="resultTemporary"
          :has-stashed-result="hasStashedResult"
          @generate="callGenerate()"
          @openRecovery="inspector?.selectSection(drawEngine === 'sd' ? 'delivery' : 'render', true)"
          @exploreScenes="openMaterials('scenes')"
          @saveResult="saveResult"
          @clearResult="clearCanvasResult"
          @saveScene="captureScene"
          @openCompare="compareOpen = true"
          @restoreStashed="onRestoreStashed"
          @interrogateResult="handleInterrogateResult"
          @interrogateError="handleInterrogateError"
        />

      </div>
      <!-- ─── 左栏：剧本 ──────────────────────────────────── -->
      <div class="director-col col-left" id="drawing-materials" @keydown.esc="closeCompactMaterials">
        <DirectorMaterialDrawer ref="materialDrawer" :expert="pb.directorMode === 'pro'" :scene-context="String(route.query.scene || route.query.blueprint || '')">
        <template #story>

        <DirectorStoryPanel />

        </template>
        <template #character>
        <DirectorCharacterPanel :current-traits="currentTraits" @selectSource="selectPopularSource" @selectCharacter="selectPopularCharacter" @selectOutfit="selectPopularOutfit" />
        <section class="material-current-scene">
          <div><h3>这一幕</h3><button class="btn btn-quiet btn-sm" type="button" @click="openMaterials('scenes')">更换场景<ArchiveIcon name="chevron-down" /></button></div>
          <strong>{{ currentSceneTitle || '当前构想' }}</strong>
          <p>{{ pb.story || '选择场景，或写下这一幕的故事。' }}</p>
          <button class="btn btn-ghost btn-sm" type="button" @click="editDescription"><ArchiveIcon name="spark" />编辑画面描述</button>
        </section>

        </template>
        <template #scenes>
          <PromptMaterialScenes :bindings="materialBindings" />
        </template>
        <template #history="{ active }">
        <HistoryPanel class="advanced-decision"
          :history="pb.history" :active="active"
          @resume="resumeHistory"
          @duplicate="duplicateHistory"
          @delete="deleteHistory"
          @to-shots="handleHistoryToShots"
          @to-shots-batch="handleHistoryToShotsBatch"
        />
        </template>
        <template #footer><button class="btn btn-quiet btn-sm" type="button" @click="resetLayout"><ArchiveIcon name="refresh" />恢复默认布局</button></template>
        </DirectorMaterialDrawer>
      </div>

      <DirectorInspector ref="inspector" v-content-motion:fade="pb.directorMode" :queue-count="sdQueue.total.value" :busy="generationBusy">
        <template #render>
          <PromptInspectorRender :bindings="renderBindings">
            <template #size><GenerationSizePicker :engine="drawEngine" :size="genBarSize" :anima-sizes="animaBarSizes" :busy="generationBusy" @update:size="genBarSize = $event" /></template>
            <template #style><PromptInspectorStyle :bindings="styleBindings" /></template>
          </PromptInspectorRender>
          <OutfitOverrideNotice v-if="outfitOverridden" />
        </template>
        <template #image>
              <DirectorImageTools
                v-if="stagePanel"
                :generation-busy="generationBusy"
                :interrogate-busy="stagePanel.interrogateBusy"
                :interrogate-mode="drawEngine === 'krea2' ? 'caption' : 'tag'"
                :interrogate-error="stagePanel.interrogateError"
                :display-result-url="displayResultUrl"
                :draw-engine="drawEngine"
                :inpaint-original-url="inpaintOriginalUrl"
                :inpaint-compare-active="inpaintCompareActive"
                :shots-pending="shotsPending"
                @interrogateCurrent="stagePanel.interrogateCurrentImage()"
                @interrogateUpload="stagePanel.triggerInterrogatePick()"
                @interrogateClipboard="stagePanel.interrogateClipboardImage()"
                @interrogatePaste="stagePanel.onInterrogatePaste($event)"
                @interrogateCancel="stagePanel.cancelInterrogate()"
                @openInpaint="inpaintOpen = true"
                @update:inpaintCompareActive="inpaintCompareActive = $event"
                @upscale="upscaleCurrentResult"
                @goVideo="goToVideo"
                @addToShots="addToShots"
                @goShots="goToShots"
              />
        </template>
        <template #prompt>
          <PromptInspectorPrompt :bindings="healthBindings" />
        </template>
        <template #delivery>
          <PromptInspectorDelivery :bindings="deliveryBindings" />
        </template>
        <template #actions><div ref="inspectorActions" class="inspector-actions" /></template>
      </DirectorInspector>
    </div>

    <!-- Toast 已于 2026-08-29 UX 收编退役，统一走全局 useToast（AppToast）；空壳 Transition 一并清除 -->

    <HistoryReuseDialog v-if="reuseRequest" :key="String(reuseRequest.record.id)" :record="reuseRequest.record" :busy="reuseBusy" @apply="applyReuse" @cancel="cancelReuse" />
    <GeneratedSceneDialog v-if="capturedScene" :source="capturedScene" @close="closeSceneCapture" />
    <DeferredPanel :active="compareOpen || inpaintOpen">
      <PromptResultDialogs :bindings="dialogBindings" />
    </DeferredPanel>
  </article>
</template>

<script setup lang="ts">
import '@/assets/css/director.css'
import { computed, defineAsyncComponent, nextTick, ref } from 'vue'
import { useDirectorLayout } from '@/composables/prompt/useDirectorLayout'
const DirectorResizeHandle = defineAsyncComponent(() => import('@/components/director/DirectorResizeHandle.vue'))
const DirectorLayoutControls = defineAsyncComponent(() => import('@/components/director/DirectorLayoutControls.vue'))
const GeneratedSceneDialog = defineAsyncComponent(() => import('@/components/maintenance/GeneratedSceneDialog.vue'))
const DirectorModeSwitch = defineAsyncComponent(() => import('@/components/director/DirectorModeSwitch.vue'))
const OutfitOverrideNotice = defineAsyncComponent(() => import('@/components/director/OutfitOverrideNotice.vue'))
const PromptResultDialogs = defineAsyncComponent(() => import('@/components/director/PromptResultDialogs.vue'))
const PromptInspectorRender = defineAsyncComponent(() => import('@/components/director/PromptInspectorRender.vue'))
const PromptInspectorStyle = defineAsyncComponent(() => import('@/components/director/PromptInspectorStyle.vue'))
const PromptInspectorPrompt = defineAsyncComponent(() => import('@/components/director/PromptInspectorPrompt.vue'))
const PromptInspectorDelivery = defineAsyncComponent(() => import('@/components/director/PromptInspectorDelivery.vue'))
import DeferredPanel from '@/components/director/DeferredPanel.vue'
const DirectorMaterialDrawer = defineAsyncComponent(() => import('@/components/director/DirectorMaterialDrawer.vue'))
const DirectorInspector = defineAsyncComponent(() => import('@/components/director/DirectorInspector.vue'))
const PromptDataTools = defineAsyncComponent(() => import('@/components/PromptDataTools.vue'))
const PromptDraftNotice = defineAsyncComponent(() => import('@/components/director/PromptDraftNotice.vue'))
const RandomInspirationButton = defineAsyncComponent(() => import('@/components/RandomInspirationButton.vue'))
const HistoryRestoreNotice = defineAsyncComponent(() => import('@/components/director/HistoryRestoreNotice.vue'))
const HistoryReuseDialog = defineAsyncComponent(() => import('@/components/director/HistoryReuseDialog.vue'))
const HistoryPanel = defineAsyncComponent(() => import('@/components/HistoryPanel.vue'))
import DirectorStoryPanel from '@/components/director/DirectorStoryPanel.vue'
const DirectorCharacterPanel = defineAsyncComponent(() => import('@/components/director/DirectorCharacterPanel.vue'))
const PromptMaterialScenes = defineAsyncComponent(() => import('@/components/director/PromptMaterialScenes.vue'))
const DirectorStagePanel = defineAsyncComponent(() => import('@/components/director/DirectorStagePanel.vue'))
const DirectorImageTools = defineAsyncComponent(() => import('@/components/director/DirectorImageTools.vue'))
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
const StudioTooltip = defineAsyncComponent(() => import('@/components/ui/StudioTooltip.vue'))
const GenerationActionBar = defineAsyncComponent(() => import('@/components/director/GenerationActionBar.vue'))
const GenerationSizePicker = defineAsyncComponent(() => import('@/components/director/GenerationSizePicker.vue'))
import { usePromptWorkspace } from "@/composables/prompt/usePromptWorkspace"
const workspace = usePromptWorkspace()
const { reuseRequest, reuseBusy, applyReuse, cancelReuse } = workspace.historyReuse
const stagePanel = ref<InstanceType<typeof DirectorStagePanel> | null>(null)
const inspectorActions = ref<HTMLElement | null>(null)
const layoutRoot = ref<HTMLElement | null>(null)
const directorLayout = useDirectorLayout(layoutRoot)
const {
capturedScene, capturingScene, captureScene, closeSceneCapture,
pb,
displayResultUrl,
resultRevealUrl,
characterShifting,
currentCharacterThemeStyle,
setDirectorMode,
engineOnline,
engineStatusText,
recheckEngineConnection,
drawEngineLabel,
currentBlueprintData,
handleLoadBlueprint,
route,
currentTraits,
selectPopularSource,
selectPopularCharacter,
selectPopularOutfit,
resumeHistory,
duplicateHistory,
deleteHistory,
handleHistoryToShots,
handleHistoryToShotsBatch,
generationBusy,
generationError,
generationStopped,
generationStatusText,
generationProgress,
animaState,
drawEngine,
inpaintOriginalUrl,
inpaintCompareActive,
shotsPending,
prevResult,
resultArchived,
savingResult,
resultTemporary,
hasStashedResult,
callGenerate,
inpaintOpen,
inspector,
materialDrawer,
upscaleCurrentResult,
goToVideo,
addToShots,
goToShots,
saveResult,
compareOpen,
onClearResult,
onRestoreStashed,
handleInterrogateResult,
handleInterrogateError,
genBarSize,
animaBarSizes,
generateBlockReason,
cancelGeneration,
outfitOverridden,
sdQueue,
materialBindings,
renderBindings,
styleBindings,
healthBindings,
deliveryBindings,
dialogBindings
} = workspace
const actionBarDocked = computed(() => !!inspectorActions.value && directorLayout.desktop.value && !pb.focusMode && !directorLayout.collapsed.value.inspector)
const descriptionInHeader = computed(() => pb.focusMode)
const currentSceneTitle = computed(() => {
  const subject = pb.subject
  return subject.kind === 'popular'
    ? pb.sceneBlueprints.find(scene => scene.id === subject.blueprintId && scene.characterId === subject.characterId)?.title
    : pb.activeScene?.title
})
async function openMaterials(section: string) {
  pb.focusMode = false
  directorLayout.show('materials')
  await nextTick()
  await materialDrawer.value?.selectSection(section)
}
async function toggleLayout(side: 'materials' | 'inspector') {
  directorLayout.toggle(side)
  await nextTick()
  if (directorLayout.compact.value && side === 'materials' && !directorLayout.collapsed.value.materials)
    layoutRoot.value?.querySelector<HTMLButtonElement>('.material-switch button[aria-selected="true"]')?.focus({ preventScroll: true })
}
async function closeCompactMaterials(event: KeyboardEvent) {
  if (!directorLayout.compact.value || event.defaultPrevented) return
  event.preventDefault()
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
async function editDescription() {
  await openMaterials('story')
  const input = layoutRoot.value?.querySelector<HTMLTextAreaElement>('#visualDescription')
  input?.focus({ preventScroll: true })
  input?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
}
function clearCanvasResult() {
  stagePanel.value?.playClear()
  onClearResult()
}
</script>

<style scoped src="@/assets/css/director/view-shell.css"></style>

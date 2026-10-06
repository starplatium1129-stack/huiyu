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
    :class="{
      'focus-mode': pb.focusMode,
      'has-result': Boolean(displayResultUrl),
      'character-shifting': characterShifting,
    }"
  >

    <DrawingTaskObserver :sd="sd" :anima="animaSession" />
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
      </div>
      <div class="pb-top-actions">
        <div class="pb-mode-actions">
          <DirectorModeSwitch :model-value="pb.directorMode" @update:model-value="setDirectorMode" />
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
          <DirectorLayoutControls v-if="!pb.focusMode" :collapsed="directorLayout.collapsed.value" @toggle="directorLayout.toggle" @reset="directorLayout.reset" />
          <RandomInspirationButton />
          <PromptDataTools
            :blueprint-data="currentBlueprintData"
            @flash="pb.flash"
            @load-blueprint="handleLoadBlueprint"
          />
        </div>
      </div>
    </div>

    <nav v-if="pb.directorMode !== 'pro'" class="drawing-jump-links" aria-label="绘制区快捷导航">
      <a href="#drawing-materials">创作素材</a><a href="#drawing-canvas">画布预览</a><a href="#stepResult">输出设置</a>
    </nav>
    <div ref="layoutRoot" class="director-workspace">
      <DirectorResizeHandle v-if="!pb.focusMode && !directorLayout.collapsed.value.materials" side="materials" :width="directorLayout.materialsWidth.value"
        @start="directorLayout.start('materials', $event)" @move="directorLayout.move" @finish="directorLayout.finish" @key="directorLayout.key('materials', $event)" @reset="directorLayout.reset" />
      <DirectorResizeHandle v-if="!pb.focusMode && !directorLayout.collapsed.value.inspector" side="inspector" :width="directorLayout.inspectorWidth.value"
        @start="directorLayout.start('inspector', $event)" @move="directorLayout.move" @finish="directorLayout.finish" @key="directorLayout.key('inspector', $event)" @reset="directorLayout.reset" />

      <!-- ─── 中栏：监视器 ────────────────────────────────── -->
      <div class="director-col col-center" id="drawing-canvas">

        <DirectorStagePanel
          ref="stagePanel"
          :canvas-size="genBarSize"
          :display-result-url="displayResultUrl"
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
          @openRecovery="inspector?.selectSection(drawEngine === 'sd' ? 'delivery' : 'render')"
          @exploreScenes="materialDrawer?.selectSection('scenes')"
          @saveResult="saveResult"
          @saveScene="captureScene"
          @openCompare="compareOpen = true"
          @restoreStashed="onRestoreStashed"
          @interrogateResult="handleInterrogateResult"
          @interrogateError="handleInterrogateError"
        />
        <!-- 主行动常驻编辑台底部；专注或收起编辑台时回到画布下方。 -->
        <Teleport :to="inspectorActions" :disabled="!inspectorActions || !directorLayout.desktop.value || pb.focusMode || directorLayout.collapsed.value.inspector">
        <GenerationActionBar
          :engine="drawEngine"
          :busy="generationBusy"
          :progress="generationProgress"
          :online="engineOnline"
          :size="genBarSize"
          :anima-sizes="animaBarSizes"
          :preset-summary="generationPresetSummary"
          :blocked-reason="generateBlockReason"
          :has-result="Boolean(displayResultUrl)"
          @update:size="genBarSize = $event"
          @generate="callGenerate()"
          @cancel="cancelGeneration"
          @clearResult="clearCanvasResult"
        />
        </Teleport>

      </div>
      <!-- ─── 左栏：剧本 ──────────────────────────────────── -->
      <div class="director-col col-left" id="drawing-materials">
        <DirectorMaterialDrawer ref="materialDrawer" :expert="pb.directorMode === 'pro'" :scene-context="String(route.query.scene || route.query.blueprint || '')">
        <template #story>

        <DirectorStoryPanel />

        </template>
        <template #character>
        <DirectorCharacterPanel :current-traits="currentTraits" @selectSource="selectPopularSource" @selectCharacter="selectPopularCharacter" @selectOutfit="selectPopularOutfit" />

        </template>
        <template #scenes>
          <PromptMaterialScenes :bindings="materialBindings" />
        </template>
        <template #history>
        <HistoryPanel class="advanced-decision"
          :history="pb.history"
          @resume="resumeHistory"
          @duplicate="duplicateHistory"
          @delete="deleteHistory"
          @to-shots="handleHistoryToShots"
          @to-shots-batch="handleHistoryToShotsBatch"
        />
        </template>
        </DirectorMaterialDrawer>
      </div>

      <DirectorInspector ref="inspector" :queue-count="sdQueue.total.value" :busy="generationBusy">
        <template #render>
          <PromptInspectorRender :bindings="renderBindings">
            <template #style><PromptInspectorStyle :bindings="styleBindings" /></template>
            <template #reference>
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
              <OutfitOverrideNotice v-if="outfitOverridden" />
            </template>
          </PromptInspectorRender>
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
import { defineAsyncComponent, ref } from 'vue'
import { useDirectorLayout } from '@/composables/prompt/useDirectorLayout'
import DirectorResizeHandle from '@/components/director/DirectorResizeHandle.vue'
import DirectorLayoutControls from '@/components/director/DirectorLayoutControls.vue'
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
const RandomInspirationButton = defineAsyncComponent(() => import('@/components/RandomInspirationButton.vue'))
const HistoryRestoreNotice = defineAsyncComponent(() => import('@/components/director/HistoryRestoreNotice.vue'))
const HistoryReuseDialog = defineAsyncComponent(() => import('@/components/director/HistoryReuseDialog.vue'))
const DrawingTaskObserver = defineAsyncComponent(() => import('@/components/tasks/DrawingTaskObserver.vue'))
const HistoryPanel = defineAsyncComponent(() => import('@/components/HistoryPanel.vue'))
const DirectorStoryPanel = defineAsyncComponent(() => import('@/components/director/DirectorStoryPanel.vue'))
const DirectorCharacterPanel = defineAsyncComponent(() => import('@/components/director/DirectorCharacterPanel.vue'))
const PromptMaterialScenes = defineAsyncComponent(() => import('@/components/director/PromptMaterialScenes.vue'))
const DirectorStagePanel = defineAsyncComponent(() => import('@/components/director/DirectorStagePanel.vue'))
const DirectorImageTools = defineAsyncComponent(() => import('@/components/director/DirectorImageTools.vue'))
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
const StudioTooltip = defineAsyncComponent(() => import('@/components/ui/StudioTooltip.vue'))
const GenerationActionBar = defineAsyncComponent(() => import('@/components/director/GenerationActionBar.vue'))
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
sd,
animaSession,
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
generationPresetSummary,
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
function clearCanvasResult() {
  stagePanel.value?.playClear()
  onClearResult()
}
</script>

<style scoped src="@/assets/css/director/view-shell.css"></style>

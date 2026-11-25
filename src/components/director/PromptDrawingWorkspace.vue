<template>
  <article
    class="pb journal-workspace atelier-workspace"
    :data-character="pb.subject.kind === 'popular' ? pb.subject.characterId : pb.char"
    :style="[currentCharacterThemeStyle, { '--drawing-action-height': actionBarHeight + 'px' }]"
    :data-materials-collapsed="directorLayout.collapsed.value.materials || undefined"
    :data-inspector-collapsed="directorLayout.collapsed.value.inspector || undefined"
    :data-resizing="directorLayout.dragging.value || undefined"
    :data-subject="pb.subject.kind"
    :data-director-mode="pb.directorMode"
    :data-compact-workspace="directorLayout.compact.value || undefined"
    :class="{
      'focus-mode': pb.focusMode,
      'has-result': Boolean(displayResultUrl),
    }"
  >

    <div class="pb-topline">
      <div class="pb-header">
        <div class="pb-heading-row">
          <h1 class="pb-title">绘图画室</h1>
          <span class="pb-character-cue">
            <i class="pb-character-dot" aria-hidden="true" />
            <span class="pb-character-subtitle">{{ currentCharacterLabel }}<template v-if="currentSceneTitle"> · {{ currentSceneTitle }}</template></span>
          </span>
          <div class="api-status">
            <StudioTooltip :content="`${engineStatusText}；点击重新检测`">
              <button class="badge" :class="engineOnline && engineConnected ? 'badge-online' : 'badge-offline'" type="button"
                @click="recheckEngineConnection">
                <ArchiveIcon :name="engineOnline && engineConnected ? 'success' : 'warning'" />
                <span>{{ drawEngineLabel }} {{ engineOnline ? engineConnected ? '已连接' : '待启动' : '未连接' }}</span>
              </button>
            </StudioTooltip>
            <RouterLink v-if="!engineOnline || workspace.preparedModelPending.value" class="api-recovery-link" :to="drawingSetupRoute">绘图配置</RouterLink>
          </div>
        </div>
        <div class="pb-header-meta"><PromptDraftNotice :get-blueprint="getBlueprint" :link-error="deepLinkError" :link-retrying="retryingDeepLink" :generation-busy="generationBusy" @retry-link="retryDeepLink" /></div>
      </div>
      <div class="pb-top-actions">
        <div class="pb-mode-actions">
          <button v-if="descriptionInHeader"
            class="btn btn-ghost btn-sm" type="button" @click="editDescription">
            <ArchiveIcon name="spark" />编辑描述
          </button>
          <DirectorModeSwitch :model-value="pb.directorMode" @update:model-value="setDirectorMode" />
          <DirectorLayoutControls v-if="!pb.focusMode" :collapsed="directorLayout.collapsed.value" @toggle="toggleLayout" />
          <button class="focus-mode-btn" type="button" data-spring-button
            :aria-label="pb.focusMode ? '退出专注模式' : '进入专注模式'"
            :aria-pressed="pb.focusMode"
            @click="pb.focusMode = !pb.focusMode">
            <span class="focus-mode-icon" data-press-content aria-hidden="true">
              <ArchiveIcon name="expand" /><ArchiveIcon name="compress" />
            </span>
            <span class="focus-mode-label studio-control-label">{{ pb.focusMode ? '退出专注' : '专注模式' }}</span>
          </button>
        </div>
        <div class="pb-utility-actions">
          <HistoryRestoreNotice v-if="pb.historyRestoreReport" :context="workspace.recipePreviewContext" :mode="pb.directorMode" @expert="setDirectorMode('pro')" />
          <RandomInspirationButton :moss-negative="drawEngine === 'moss' ? native.session.value?.form.negative ?? '' : undefined"
            :blocked="generationBusy || !workspace.draftReady.value" />
          <StudioDropdownMenu label="画室辅助工具">
            <template #trigger>
              <button
                id="director-utility-menu-trigger"
                class="btn btn-ghost btn-sm pb-tools-trigger"
                type="button"
                data-migration-control
                data-control-motion
                aria-label="画室工具菜单"
              >
                <ArchiveIcon name="gear" />
                <span class="studio-control-label">工具</span>
              </button>
            </template>
            <template #default="{ run }">
              <DropdownMenuItem
                class="studio-dropdown-item"
                data-migration-control
                :disabled="dataToolsLoading"
                @select.prevent="run(openDataTools)"
              >
                <ArchiveIcon name="download" />
                <span>数据与备份</span>
              </DropdownMenuItem>
              <div class="studio-dropdown-separator" role="separator" />
              <div class="studio-dropdown-label">画桌维护</div>
              <DropdownMenuItem
                class="studio-dropdown-item"
                @select.prevent="run(resetLayout)"
              >
                <ArchiveIcon name="refresh" />
                <span>恢复默认布局</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                class="studio-dropdown-item"
                @select.prevent="run(recheckEngineConnection)"
              >
                <ArchiveIcon name="health" />
                <span>重新检测绘图连接</span>
              </DropdownMenuItem>
            </template>
          </StudioDropdownMenu>
          <component
            v-if="dataToolsComp"
            :is="dataToolsComp"
            v-model:open="dataToolsOpen"
            dialog-mode
            launcher-label="数据工具"
            :get-blueprint="getBlueprint"
            @flash="pb.flash"
            @load-blueprint="handleLoadBlueprint"
          />
        </div>
      </div>
    </div>

    <section v-if="route.query.firstDraw === '1' && !displayResultUrl && !pb.focusMode" class="first-drawing" aria-labelledby="first-drawing-title">
      <div>
        <h2 id="first-drawing-title">生成第一张图</h2>
        <p role="status">{{ firstDrawingHint }}</p>
      </div>
      <div class="first-drawing-actions">
        <template v-if="!generationBusy && workspace.draftReady.value">
          <button v-if="workspace.preparedModelPending.value && !native.mode.value" class="btn btn-ghost btn-sm" type="button" @click="materialBindings.retryInitialization()">重新选用模型</button>
          <button v-if="canFillExample" class="btn btn-primary btn-sm" type="button" @click="fillExample">填入示例画面</button>
          <button v-if="engineOnline && !workspace.preparedModelPending.value" ref="exampleEditButton" class="btn btn-ghost btn-sm" type="button" @click="editDescription">编辑画面描述</button>
        </template>
      </div>
    </section>

    <nav v-if="pb.directorMode !== 'pro'" class="drawing-jump-links tw:w-fit tw:rounded-pill tw:p-s-1" data-fluid-glass aria-label="绘制区快捷导航">
      <RouterLink :to="{ query: route.query, hash: '#drawing-materials' }">素材</RouterLink><RouterLink :to="{ query: route.query, hash: '#drawing-canvas' }">画布</RouterLink><RouterLink :to="{ query: route.query, hash: '#stepResult' }" @click="inspector?.selectSection('render')">参数</RouterLink>
    </nav>
    <div ref="layoutRoot" class="director-workspace">
      <!-- One action bar: inspector on wide screens, workspace-wide sticky row on narrow screens. -->
      <Teleport to="#drawing-inspector-actions" :disabled="!actionBarDocked" defer>
        <GenerationActionBar
          :engine="drawEngine"
          :busy="generationBusy"
          :presentation="generationPresentation"
          :online="engineOnline"
          :connected="engineOnline && engineConnected"
          :provider="native.mode.value ? 'native' : animaState.provider" :readiness-text="engineStatusText"
          :size="genBarSize"
          :anima-sizes="animaBarSizes"
          :custom-size="animaSizeLimits"
          :show-size="!actionBarDocked" :docked="actionBarDocked"
          :blocked-reason="generateBlockReason"
          :has-result="Boolean(displayResultUrl)"
          :error="generationError"
          :stopped="generationStopped"
          @update:size="setCanvasSize"
          @resize="actionBarHeight = $event"
          @generate="callGenerate(interrogateAssist)"
          @cancel="cancelGeneration"
        />
      </Teleport>
      <DirectorResizeHandle v-for="side in resizeSides" :key="side" :side="side" :width="side === 'materials' ? directorLayout.materialsWidth.value : directorLayout.inspectorWidth.value"
        @start="directorLayout.start(side, $event)" @move="directorLayout.move" @finish="directorLayout.finish" @click="directorLayout.click" @key="directorLayout.key(side, $event)" @reset="directorLayout.reset" />

      <!-- ─── 中栏：监视器 ────────────────────────────────── -->
      <div class="director-col col-center" id="drawing-canvas">

        <Suspense><DirectorStagePanel
          ref="stagePanel"
          :canvas-size="genBarSize"
          :display-result-url="displayResultUrl"
          :scene-title="currentSceneTitle"
          :result-reveal-url="resultRevealUrl"
          :generation-busy="generationBusy"
          :generation-error="generationError"
          :generation-stopped="generationStopped"
          :generation="generationPresentation"
          :draw-engine="drawEngine"
          :inpaint-original-url="inpaintOriginalUrl"
          :inpaint-compare-active="inpaintCompareActive"
          :has-prev-result="!!prevResult"
          :result-archived="resultArchived"
          :saving-result="savingResult"
          :capturing-scene="capturingScene"
          :can-save-scene="!native.mode.value"
          :result-temporary="resultTemporary"
          :has-stashed-result="hasStashedResult"
          @generate="callGenerate(interrogateAssist)"
          @openRecovery="openRecovery"
          @exploreScenes="openMaterials('scenes')"
          @editDescription="editDescription"
          @saveResult="saveResult"
          @clearResult="clearCanvasResult"
          @saveScene="captureScene"
          @openCompare="compareOpen = true"
          @restoreStashed="onRestoreStashed"
          :apply-interrogate-result="handleInterrogateResult"
          :interrogate-mode="interrogateMode"
          :interrogate-assist="interrogateAssist"
          :interrogate-subject-mode="interrogateSubjectMode"
          :interrogate-layout="interrogateLayout"
          @interrogateError="handleInterrogateError"
        /><template #fallback>
          <section class="stage-slot" aria-label="绘制画布" aria-busy="true">
            <div class="canvas-heading"><div><ArchiveIcon name="image" /><strong>{{ displayResultUrl ? '当前成片' : currentSceneTitle || '画布' }}</strong><span v-if="currentSceneTitle && !displayResultUrl">场景参考 · 非本次生成</span></div><button v-if="currentSceneTitle || displayResultUrl" class="btn btn-quiet btn-sm" type="button" disabled><ArchiveIcon name="scene" />更换场景</button></div>
            <div class="stage-viewport director-canvas-loading"><AtelierEmptyArt :character="activeCharacterId" /><p role="status">正在准备画布…</p></div>
          </section>
        </template></Suspense>

      </div>
      <!-- ─── 左栏：剧本 ──────────────────────────────────── -->
      <div class="director-col col-left" id="drawing-materials" @keydown.esc="closeCompactMaterials">
        <DirectorMaterialDrawer ref="materialDrawer" :expert="pb.directorMode === 'pro'" :visible="materialsVisible" :compact="directorLayout.compact.value" :scene-context="String(route.query.scene || route.query.blueprint || '')" @back="closeCompactMaterials">
        <template #story>

        <AsyncPanel :loader="loadStoryPanel" label="故事与画面描述" v-slot="{ component }"><component :is="component" @ready="focusDescription" /></AsyncPanel>

        </template>
        <template #character>
        <AsyncPanel :loader="loadCharacterPanel" label="角色素材" v-slot="{ component }">
          <component :is="component" :current-traits="currentTraits" :engine="drawEngine" :canvas-size="genBarSize"
            :size-manually-set="canvasSizeManuallySet" :custom-moss-layout="customMossLayout"
            @selectSource="selectCharacterSource" @selectCharacter="selectPopularCharacter" @selectOutfit="selectPopularOutfit" />
        </AsyncPanel>
        <section class="material-current-scene">
          <div><h3>这一幕</h3><button class="btn btn-quiet btn-sm" type="button" @click="openMaterials('scenes')">更换场景<ArchiveIcon name="chevron-down" /></button></div>
          <strong>{{ currentSceneTitle || '当前构想' }}</strong>
          <p>{{ pb.story || '选择场景，或写下这一幕的故事。' }}</p>
          <button class="btn btn-ghost btn-sm" type="button" @click="editDescription"><ArchiveIcon name="spark" />编辑画面描述</button>
        </section>

        </template>
        <template #scenes>
          <AsyncPanel :loader="loadMaterialScenes" label="场景素材" v-slot="{ component }"><component :is="component" :bindings="materialBindings" /></AsyncPanel>
        </template>
        <template #history="{ active }">
        <AsyncPanel :loader="loadHistoryPanel" label="作品历史" v-slot="{ component }"><component :is="component" class="advanced-decision"
          :history="pb.history" :active="active" :transfer-busy="transferBusy" :loading="pb.historyLoading" :error="pb.historyError" @retry="pb.loadHistory()"
          @resume="resumeHistory"
          @duplicate="duplicateHistory"
          @delete="deleteHistory"
          @to-shots="handleHistoryToShots"
          @to-shots-batch="handleHistoryToShotsBatch"
        /></AsyncPanel>
        </template>
        <template #footer><button class="btn btn-quiet btn-sm" type="button" @click="resetLayout"><ArchiveIcon name="refresh" />恢复默认布局</button></template>
        </DirectorMaterialDrawer>
      </div>

      <DirectorInspector ref="inspector" v-content-motion:fade="pb.directorMode" :visible="inspectorVisible" :queue-count="sdQueue.total.value" :busy="generationBusy">
        <template #render>
          <div id="stepResult">
          <DrawingEngineSelect :model-value="drawEngine" :disabled="generationBusy || !!native.session.value?.saving.value"
            :anima-disabled="!pb.isPopular && pb.char === 'triad' && !renderBindings.supportsDualCharacter('anima')"
            :krea-disabled="!pb.isPopular && pb.char === 'triad' && !renderBindings.supportsDualCharacter('krea2')"
            :before-switch="native.mode.value ? native.saveBeforeSwitch : undefined" @select-native="renderBindings.setDrawEngine" />
          <AsyncPanel v-if="native.mode.value" :loader="loadNativeControls" label="绘制参数" v-slot="{ component }"><component :is="component" :drawing="native" :busy="generationBusy" @size-touched="canvasSizeManuallySet = true">
            <template #style><PromptInspectorStyle :bindings="styleBindings" engine="moss" /></template>
          </component></AsyncPanel>
          <AsyncPanel v-else :loader="loadInspectorRender" label="绘制参数" v-slot="{ component }"><component :is="component" :bindings="renderBindings">
            <template #size><GenerationSizePicker :engine="drawEngine" :size="genBarSize" :anima-sizes="animaBarSizes" :custom-size="animaSizeLimits" :busy="generationBusy" @update:size="setCanvasSize" /></template>
            <template #style><PromptInspectorStyle :bindings="styleBindings" /></template>
          </component></AsyncPanel>
          <OutfitOverrideNotice v-if="outfitOverridden && !native.mode.value" />
          </div>
        </template>
        <template #image>
              <AsyncPanel v-if="stagePanel" :loader="loadImageTools" label="图像工具" v-slot="{ component }"><component :is="component"
                :composition="workspace.compositionBindings"
                :generation-busy="generationBusy"
                :interrogate-busy="stagePanel.interrogateBusy"
                :interrogate-mode="interrogateMode"
                :interrogate-assist="interrogateAssist"
                :interrogate-error="stagePanel.interrogateError"
                :display-result-url="displayResultUrl"
                :draw-engine="drawEngine"
                :inpaint-original-url="inpaintOriginalUrl"
                :inpaint-compare-active="inpaintCompareActive"
                :shots-pending="shotsPending"
                :transfer-busy="transferBusy"
                @interrogateCurrent="stagePanel.interrogateCurrentImage()"
                @interrogateUpload="stagePanel.triggerInterrogatePick()"
                @interrogateClipboard="stagePanel.interrogateClipboardImage()"
                @interrogatePaste="stagePanel.onInterrogatePaste($event)"
                @interrogateCancel="stagePanel.cancelInterrogate()"
                @update:interrogateAssist="setInterrogateAssist"
                @openInpaint="inpaintOpen = true"
                @update:inpaintCompareActive="inpaintCompareActive = $event"
                @upscale="upscaleCurrentResult"
                @goVideo="goToVideo"
                @addToShots="addToShots"
                @goShots="goToShots"
              /></AsyncPanel>
              <p v-else role="status">画布准备完成后，可继续使用图像工具。</p>
        </template>
        <template #prompt>
          <AsyncPanel v-if="native.mode.value" :loader="loadNativePrompt" label="提示词预览" v-slot="{ component }"><component :is="component" :drawing="native" /></AsyncPanel>
          <AsyncPanel v-else :loader="loadInspectorPrompt" label="提示词工具" v-slot="{ component }"><component :is="component" :bindings="healthBindings" /></AsyncPanel>
        </template>
        <template #delivery>
          <AsyncPanel :loader="loadInspectorDelivery" label="任务与配音工具" v-slot="{ component }"><component :is="component" :bindings="deliveryBindings" /></AsyncPanel>
        </template>
        <template #actions><div id="drawing-inspector-actions" class="inspector-actions" /></template>
      </DirectorInspector>
    </div>

    <!-- Toast 已于 2026-08-29 UX 收编退役，统一走全局 useToast（AppToast）；空壳 Transition 一并清除 -->

    <DeferredDialogHost v-if="reuseRequest" :key="String(reuseRequest.record.id)" :loader="loadHistoryReuseDialog" title="沿用作品配方" icon="gallery" @close="cancelReuse" v-slot="{ component }">
      <component v-if="reuseRequest" :is="component" :record="reuseRequest.record" :busy="reuseBusy" :loading="reuseLoading" :error="reuseError" @apply="applyReuse" @cancel="cancelReuse" @retry="retryReuse" />
    </DeferredDialogHost>
    <DeferredDialogHost v-if="capturedScene" :loader="loadGeneratedSceneDialog" title="保存为场景" icon="image" @close="closeSceneCapture" v-slot="{ component }">
      <component :is="component" :source="capturedScene" @close="closeSceneCapture" />
    </DeferredDialogHost>
    <DeferredPanel :active="compareOpen || inpaintOpen">
      <PromptResultDialogs :bindings="dialogBindings" />
    </DeferredPanel>
  </article>
</template>

<script setup lang="ts">
import '@/assets/css/director.css'
import '@/assets/css/director/components/DirectorStagePanel.css'
import { defineAsyncComponent, ref } from 'vue'
import { DropdownMenuItem } from 'reka-ui'
import AsyncPanel from '@/components/ui/AsyncPanel.vue'
import StudioDropdownMenu from '@/components/ui/StudioDropdownMenu.vue'
import { useDirectorLayout } from '@/composables/prompt/useDirectorLayout'
import DirectorResizeHandle from '@/components/director/DirectorResizeHandle.vue'
import DirectorLayoutControls from '@/components/director/DirectorLayoutControls.vue'
import DeferredDialogHost from '@/components/director/DeferredDialogHost.vue'
import DirectorModeSwitch from '@/components/director/DirectorModeSwitch.vue'
import DeferredPanel from '@/components/director/DeferredPanel.vue'
import DirectorMaterialDrawer from '@/components/director/DirectorMaterialDrawer.vue'
import DirectorInspector from '@/components/director/DirectorInspector.vue'
import DrawingEngineSelect from '@/components/director/DrawingEngineSelect.vue'
import RandomInspirationButton from '@/components/RandomInspirationButton.vue'
import AtelierEmptyArt from '@/components/visual/AtelierEmptyArt.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import GenerationActionBar from '@/components/director/GenerationActionBar.vue'
import GenerationSizePicker from '@/components/director/GenerationSizePicker.vue'
import { usePromptWorkspace } from '@/composables/prompt/usePromptWorkspace'
import { useDrawingCanvas } from '@/composables/prompt/useDrawingCanvas'
import {
  loadCharacterPanel,
  loadGeneratedSceneDialog,
  loadHistoryPanel,
  loadHistoryReuseDialog,
  loadImageTools,
  loadInspectorDelivery,
  loadInspectorPrompt,
  loadInspectorRender,
  loadMaterialScenes,
  loadNativeControls,
  loadNativePrompt,
  loadStoryPanel,
  useDrawingWorkspaceControls,
} from '@/composables/prompt/useDrawingWorkspaceControls'

const OutfitOverrideNotice = defineAsyncComponent(() => import('@/components/director/OutfitOverrideNotice.vue'))
const PromptResultDialogs = defineAsyncComponent(() => import('@/components/director/PromptResultDialogs.vue'))
const PromptInspectorStyle = defineAsyncComponent(() => import('@/components/director/PromptInspectorStyle.vue'))
const PromptDraftNotice = defineAsyncComponent(() => import('@/components/director/PromptDraftNotice.vue'))
const HistoryRestoreNotice = defineAsyncComponent(() => import('@/components/director/HistoryRestoreNotice.vue'))
const DirectorStagePanel = defineAsyncComponent(() => import('@/components/director/DirectorStagePanel.vue'))

const workspace = useDrawingCanvas(usePromptWorkspace())
const { native, engineConnected } = workspace
const { reuseRequest, reuseBusy, reuseLoading, reuseError, retryReuse, applyReuse, cancelReuse } = workspace.historyReuse
const stagePanel = ref<InstanceType<typeof DirectorStagePanel> | null>(null)
const actionBarHeight = ref(0)
const layoutRoot = ref<HTMLElement | null>(null)
const directorLayout = useDirectorLayout(layoutRoot)
const {
  capturedScene, capturingScene, captureScene, closeSceneCapture,
  deepLinkError, retryingDeepLink, retryDeepLink, pb,
  displayResultUrl, resultRevealUrl, currentCharacterThemeStyle,
  setDirectorMode, engineOnline, engineStatusText, recheckEngineConnection,
  drawEngineLabel, handleLoadBlueprint, route, currentTraits,
  selectPopularCharacter, selectPopularOutfit,
  resumeHistory, duplicateHistory, deleteHistory,
  handleHistoryToShots, handleHistoryToShotsBatch,
  generationBusy, generationError, generationStopped, generationPresentation,
  animaState, drawEngine, inpaintOriginalUrl, inpaintCompareActive,
  shotsPending, prevResult, resultArchived, savingResult,
  resultTemporary, hasStashedResult, callGenerate, inpaintOpen,
  inspector, materialDrawer, upscaleCurrentResult, goToVideo, transferBusy,
  addToShots, goToShots, saveResult, compareOpen, onRestoreStashed,
  handleInterrogateResult, handleInterrogateError, genBarSize, animaBarSizes,
  generateBlockReason, cancelGeneration, outfitOverridden, sdQueue,
  materialBindings, renderBindings, styleBindings, healthBindings,
  deliveryBindings, dialogBindings,
} = workspace

const {
  canvasSizeManuallySet, setCanvasSize, customMossLayout, animaSizeLimits,
  getBlueprint, resizeSides, materialsVisible, inspectorVisible, actionBarDocked,
  selectCharacterSource, descriptionInHeader, exampleEditButton, drawingSetupRoute,
  interrogateMode, interrogateSubjectMode, interrogateAssist, interrogateLayout,
  setInterrogateAssist, canFillExample, firstDrawingHint, fillExample,
  currentSceneTitle, activeCharacterId, currentCharacterLabel,
  dataToolsComp, dataToolsOpen, dataToolsLoading, openDataTools,
  openMaterials, openRecovery, toggleLayout, closeCompactMaterials,
  resetLayout, editDescription, focusDescription, clearCanvasResult,
} = useDrawingWorkspaceControls({ workspace, layoutRoot, stagePanel, directorLayout })
</script>

<style scoped src="@/assets/css/director/view-shell.css"></style>

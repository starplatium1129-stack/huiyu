<template>
  <article
    class="pb journal-workspace"
    :data-character="pb.subject.kind === 'popular' ? pb.subject.characterId : pb.char"
    :data-onboarding-theme="hasOnboardingTheme(popularCharacter?.id)"
    :data-subject="pb.subject.kind"
    :data-director-mode="pb.directorMode"
    :class="{
      'focus-mode': pb.focusMode,
      'has-result': Boolean(displayResultUrl),
      'character-shifting': characterShifting,
    }"
  >

    <DrawingTaskObserver :sd="sd" :anima="animaSession" />
    <WorkspaceArchiveBar v-if="pb.directorMode !== 'pro' && (pb.isPopular || pb.activeScene)"
      chapter="01"
      title="绘遇工作台"
      :subtitle="pb.isPopular ? popularCharacter?.displayName || '热门角色' : (pb.activeScene?.title || (pb.directorMode === 'basic' ? '场景模式' : '专家模式'))"
      :status="pb.isPopular ? '角色创作' : (pb.directorMode === 'basic' ? '场景模式' : '专家模式')"
      :state="pb.isPopular ? 'active' : (pb.directorMode === 'basic' ? 'success' : 'active')"
      :shape="archiveBarShape"
    />

    <div class="pb-topline">
      <div class="pb-header">
        <div class="pb-heading-row">
          <h1 class="pb-title">开始绘制</h1>
          <div class="api-status">
            <button class="badge" :class="engineOnline ? 'badge-online' : 'badge-offline'" type="button"
              :title="engineOnline ? '点击重新检测' : `${engineStatusText}；点击重新检测`"
              @click="recheckEngineConnection">
              <ArchiveIcon :name="engineOnline ? 'success' : 'warning'" />
              <span>{{ drawEngineLabel }} {{ engineOnline ? '已连接' : '未连接' }}</span>
            </button>
            <RouterLink v-if="!engineOnline" class="api-recovery-link" to="/control">控制面板</RouterLink>
          </div>
        </div>
        <p class="pb-sub">{{ modeDescription }}</p>
      </div>
      <div class="pb-top-actions">
        <div class="pb-mode-actions">
          <div class="director-mode-switch" role="group" aria-label="切换绘图工作模式">
            <button class="director-mode-option" type="button"
              :class="{ active: pb.directorMode === 'basic' }"
              :aria-pressed="pb.directorMode === 'basic'"
              @click="setDirectorMode('basic')">场景模式</button>
            <button class="director-mode-option" type="button"
              :class="{ active: pb.directorMode === 'pro' }"
              :aria-pressed="pb.directorMode === 'pro'"
              @click="setDirectorMode('pro')">专家模式</button>
          </div>
          <button class="focus-mode-btn" type="button"
            :aria-label="pb.focusMode ? '退出专注成片模式' : '进入专注成片模式'"
            :aria-pressed="pb.focusMode"
            @click="pb.focusMode = !pb.focusMode">
            <ArchiveIcon :name="pb.focusMode ? 'compress' : 'expand'" class="focus-mode-icon" aria-hidden="true" />
            <span class="focus-mode-label">{{ pb.focusMode ? '退出专注' : '专注成片' }}</span>
          </button>
        </div>
        <div class="pb-utility-actions">
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
    <div class="director-workspace">

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

      <!-- ─── 中栏：监视器 ────────────────────────────────── -->
      <div class="director-col col-center" id="drawing-canvas">

        <DirectorStagePanel
          :display-result-url="displayResultUrl"
          :generation-busy="generationBusy"
          :generation-error="generationError"
          :generation-stopped="generationStopped"
          :generation-status-text="generationStatusText"
          :generation-progress="generationProgress"
          :generation-progress-style="generationProgressStyle"
          :anima-elapsed="animaState.elapsedSeconds"
          :anima-current-node="animaState.currentNode || ''"
          :draw-engine="drawEngine"
          :inpaint-original-url="inpaintOriginalUrl"
          :inpaint-compare-active="inpaintCompareActive"
          :shots-pending="shotsPending"
          :has-prev-result="!!prevResult"
          :result-archived="resultArchived"
          :saving-result="savingResult"
          :result-temporary="resultTemporary"
          :has-stashed-result="hasStashedResult"
          @generate="callGenerate()"
          @openInpaint="inpaintOpen = true"
          @openRecovery="inspector?.selectSection(drawEngine === 'sd' ? 'delivery' : 'render')"
          @exploreScenes="materialDrawer?.selectSection('scenes')"
          @update:inpaintCompareActive="inpaintCompareActive = $event"
          @upscale="upscaleCurrentResult"
          @goVideo="goToVideo"
          @addToShots="addToShots"
          @goShots="goToShots"
          @saveResult="saveResult"
          @openCompare="compareOpen = true"
          @clearResult="onClearResult"
          @restoreStashed="onRestoreStashed"
          @interrogateResult="handleInterrogateResult"
          @interrogateError="handleInterrogateError"
        />
        <!-- 吸附出图条：尺寸 + 生成紧跟画布，滚动时钉在导航下沿（同步加载保首屏） -->
        <GenerationActionBar
          :engine="drawEngine"
          :busy="generationBusy"
          :online="engineOnline"
          :size="genBarSize"
          :anima-sizes="animaBarSizes"
          :preset-summary="generationPresetSummary"
          :blocked-reason="generateBlockReason"
          @update:size="genBarSize = $event"
          @generate="callGenerate()"
          @cancel="cancelGeneration"
        />
        <!-- 特典服装换装提示：当服装被通用特典或反推顶替时出现，附一键恢复 -->
        <div v-if="outfitOverridden" class="outfit-override-note" role="status">
          <ArchiveIcon name="wardrobe" class="outfit-override-icon" />
          <span class="outfit-override-text">
            已换装为「{{ outfitReplacedLabel || outfitOverrideTokens.slice(0, 3).join('、') }}」
          </span>
          <button type="button" class="outfit-override-restore" @click="pb.clearOutfitOverride()">
            恢复默认服装
          </button>
        </div>

      </div>
      <DirectorInspector ref="inspector" :expert="pb.directorMode === 'pro'" :queue-count="sdQueue.total.value" :busy="generationBusy">
        <template #render>
          <PromptInspectorRender :bindings="renderBindings" />
        </template>
        <template #style>
          <PromptInspectorStyle :bindings="styleBindings" />
        </template>
        <template #prompt>
          <PromptInspectorPrompt :bindings="healthBindings" />
        </template>
        <template #delivery>
          <PromptInspectorDelivery :bindings="deliveryBindings" />
        </template>
      </DirectorInspector>
    </div>

    <!-- Toast 已于 2026-08-29 UX 收编退役，统一走全局 useToast（AppToast）；空壳 Transition 一并清除 -->

    <DeferredPanel :active="compareOpen || inpaintOpen">
      <PromptResultDialogs :bindings="dialogBindings" />
    </DeferredPanel>
  </article>
</template>

<script setup lang="ts">
import '@/assets/css/director.css'
import { defineAsyncComponent } from 'vue'
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
const DrawingTaskObserver = defineAsyncComponent(() => import('@/components/tasks/DrawingTaskObserver.vue'))
const HistoryPanel = defineAsyncComponent(() => import('@/components/HistoryPanel.vue'))
const DirectorStoryPanel = defineAsyncComponent(() => import('@/components/director/DirectorStoryPanel.vue'))
const DirectorCharacterPanel = defineAsyncComponent(() => import('@/components/director/DirectorCharacterPanel.vue'))
const PromptMaterialScenes = defineAsyncComponent(() => import('@/components/director/PromptMaterialScenes.vue'))
const DirectorStagePanel = defineAsyncComponent(() => import('@/components/director/DirectorStagePanel.vue'))
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import WorkspaceArchiveBar from '@/components/visual/WorkspaceArchiveBar.vue'
import GenerationActionBar from '@/components/director/GenerationActionBar.vue'
import { usePromptWorkspace } from "@/composables/prompt/usePromptWorkspace"
const workspace = usePromptWorkspace()
const {
pb,
displayResultUrl,
characterShifting,
hasOnboardingTheme,
popularCharacter,
sd,
animaSession,
archiveBarShape,
modeDescription,
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
generationProgressStyle,
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
outfitReplacedLabel,
outfitOverrideTokens,
sdQueue,
materialBindings,
renderBindings,
styleBindings,
healthBindings,
deliveryBindings,
dialogBindings
} = workspace
</script>

<style scoped src="@/assets/css/director/view-shell.css"></style>

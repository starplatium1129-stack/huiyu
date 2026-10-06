<template>
  <div class="result-frame step-panel" id="stepResult">
    <div class="engine-switch studio-segments studio-segments--compact" role="group" aria-label="出图引擎">
      <AnimatedSelection />
      <StudioTooltip anchor :content="engineTitle('anima')">
        <button type="button" class="engine-btn" :aria-pressed="drawEngine === 'anima'"
          :disabled="generationBusy || (!pb.isPopular && pb.char === 'triad' && !supportsDualCharacter('anima'))"
          @click="setDrawEngine('anima')">Anima</button>
      </StudioTooltip>
      <StudioTooltip anchor :content="engineTitle('krea2')">
        <button type="button" class="engine-btn" :aria-pressed="drawEngine === 'krea2'"
          :disabled="generationBusy || (!pb.isPopular && pb.char === 'triad' && !supportsDualCharacter('krea2'))"
          @click="setDrawEngine('krea2')">Krea 2</button>
      </StudioTooltip>
    </div>
    <label class="inspector-visual-description" for="inspectorVisualDescription">
      <span>画面描述</span>
      <textarea id="inspectorVisualDescription" v-model="pb.visualDescription" rows="3"
        placeholder="角色的动作、服装与周围的画面…" />
    </label>
    <div class="base-model-picker">
      <label for="baseModel">基础模型</label>
      <StudioSelect id="baseModel" size="sm" label="基础模型" :model-value="animaState.modelId"
        :disabled="generationBusy" :hint="generationBusy ? BUSY_HINT : undefined"
        :options="animaModelOptions" @update:model-value="onAnimaModelSelected" />
    </div>
    <slot name="style" />
    <slot name="reference" />
    <CasualCreativeSliders
      v-if="pb.directorMode !== 'pro'"
      :draw-engine="drawEngine"
      :disabled="generationBusy"
      :sd-params="pb.sdParams"
      :anima-state="animaState"
      @touch-sd="pb.markParamTouched"
      @patch-anima="patchAnimaState"
    />
    <details class="inspector-route inspector-advanced">
      <summary><span><ArchiveIcon name="gear" />高级设置</span><small>采样、Seed 与输出</small><ArchiveIcon name="chevron-down" /></summary>
      <div class="inspector-advanced-body">
        <AnimaQuickPanel :open="true" v-if="pb.directorMode === 'pro'"
          :state="animaState" :no-lora="animaNoLoraMode" @update:state="patchAnimaState" @retry="retryAnima" />
        <GenerationOutputControls :engine="drawEngine" :expert="pb.directorMode === 'pro'"
          :preset-summary="generationPresetSummary" v-model:params="pb.sdParams" :vram-hint="vramHint"
          :vram-level="vramLevel" :base-resolution-risk="baseResolutionRisk" :base-resolution-hint="baseResolutionHint"
          :can-use-face-detailer="canUseFaceDetailer" :queue-available="pb.isPopular ? false : sdQueue.canEnqueue.value"
          @touch="pb.markParamTouched" @enqueue="enqueueCurrent" @enqueue-variants="enqueue3Variants" />
      </div>
    </details>
    <details v-if="managedRoute" class="inspector-route">
      <summary><span>推荐配方与复用</span><ArchiveIcon name="chevron-down" /></summary>
      <ManagedDrawingRouteCard class="pb-managed-route-banner" :route="managedRoute" :history="pb.history" :subject="pb.subject"
        :expert="pb.directorMode === 'pro'" :busy="generationBusy" @apply="applyManagedRoute" @reuse="reuseSuccessfulRecipe" />
    </details>
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import type { StudioSelectOption } from '@/components/ui/StudioSelect.vue'
import type { PromptRenderBindings } from '@/composables/prompt/promptPanelBindings'
const CasualCreativeSliders = defineAsyncComponent(() => import('@/components/director/CasualCreativeSliders.vue'))
const ManagedDrawingRouteCard = defineAsyncComponent(() => import('@/components/ManagedDrawingRouteCard.vue'))
const AnimaQuickPanel = defineAsyncComponent(() => import('@/components/AnimaQuickPanel.vue'))
const GenerationOutputControls = defineAsyncComponent(() => import('@/components/GenerationOutputControls.vue'))
const props = defineProps<{ bindings: PromptRenderBindings }>()
const { pb, sd, generationBusy, animaState, drawEngine, generationPresetSummary, sdQueue, managedRoute, applyManagedRoute,
  reuseSuccessfulRecipe, engineTitle, setDrawEngine, supportsDualCharacter, BUSY_HINT, selectAnimaModel, displayResultSeed,
  reuseLastSeed, resetSdParams, animaNoLoraMode, patchAnimaState, retryAnima, vramHint, vramLevel, baseResolutionRisk,
  baseResolutionHint, canUseFaceDetailer, enqueueCurrent, enqueue3Variants } = props.bindings
const animaModelOptions = computed<StudioSelectOption[]>(() => animaState.value.models.map(model => ({
  value: model.id, label: (model.label || model.id) + (model.available === false ? ' · 模型未安装' : ''),
  disabled: model.available === false,
})))
function onAnimaModelSelected(value: string | number) { selectAnimaModel(String(value)) }
</script>

<style src="@/assets/css/director/components/PromptInspectorRender.css"></style>

<template>
  <div class="result-frame step-panel" id="stepResult">
    <section v-if="drawEngine !== 'sd' && (animaState.errorReport || animaState.errorMsg)" class="inspector-generation-error" role="alert" aria-label="绘制恢复">
      <strong>{{ animaState.errorReport?.title || '绘制未完成' }}</strong>
      <p>{{ animaState.errorReport?.message || animaState.errorMsg }}</p>
      <button class="btn btn-ghost btn-sm anima-retry" type="button" :disabled="generationBusy" @click="retryAnima">按当前设置重试</button>
      <details v-if="animaState.errorReport?.details"><StudioDisclosureSummary>技术细节</StudioDisclosureSummary><code>{{ animaState.errorReport.details }}</code></details>
    </section>
    <details v-if="drawEngine !== 'sd' && generationBusy" class="inspector-route inspector-runtime">
      <summary><span>绘制详情</span><ArchiveIcon name="chevron-down" /></summary>
      <div data-disclosure-content>
        <p role="status">{{ animaState.progressText || animaState.statusText || '正在处理画面…' }}</p>
        <p v-if="animaState.currentNode">当前节点：{{ animaState.currentNode }}</p>
      </div>
    </details>
    <label class="inspector-visual-description" for="inspectorVisualDescription">
      <span>画面描述</span>
      <textarea id="inspectorVisualDescription" v-model="pb.visualDescription" rows="3"
        placeholder="角色的动作、服装与周围的画面…" />
    </label>
    <div class="inspector-engine-settings" role="group" aria-label="模型与引擎">
    <div class="engine-switch studio-segments studio-segments--compact" data-fluid-glass role="group" aria-label="出图引擎">
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
    <div v-content-motion:fade="drawEngine" class="base-model-picker">
      <label for="baseModel">基础模型</label>
      <StudioSelect id="baseModel" size="sm" label="基础模型" :model-value="animaState.modelId"
        :disabled="generationBusy" :hint="generationBusy ? BUSY_HINT : undefined"
        :options="animaModelOptions" @update:model-value="onAnimaModelSelected" />
    </div>
    </div>
    <slot name="style" />
    <CasualCreativeSliders
      v-if="pb.directorMode !== 'pro'"
      :draw-engine="drawEngine"
      :disabled="generationBusy"
      v-model:sd-params="pb.sdParams"
      :anima-state="animaState"
      @touch-sd="pb.markParamTouched"
      @patch-anima="patchAnimaState"
    />
    <details class="inspector-route inspector-advanced">
      <summary><span><ArchiveIcon name="gear" />{{ pb.directorMode === 'pro' ? '采样与细节' : '参数摘要' }}</span><ArchiveIcon name="chevron-down" /></summary>
      <div data-disclosure-content class="inspector-advanced-body">
        <AnimaQuickPanel v-if="pb.directorMode === 'pro'"
          :state="animaState" :no-lora="animaNoLoraMode" @update:state="patchAnimaState" />
        <div v-if="generationPresetSummary" class="generation-auto-summary tw:flex tw:items-baseline tw:justify-between tw:gap-[12px] tw:mb-[10px] tw:rounded-md tw:text-muted tw:text-body tw:leading-body tw:flex-wrap">
          <span>自动参数</span><strong>{{ generationPresetSummary }}</strong>
        </div>
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
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import type { StudioSelectOption } from '@/components/ui/StudioSelect.vue'
import type { PromptRenderBindings } from '@/composables/prompt/promptPanelBindings'
const CasualCreativeSliders = defineAsyncComponent(() => import('@/components/director/CasualCreativeSliders.vue'))
const ManagedDrawingRouteCard = defineAsyncComponent(() => import('@/components/ManagedDrawingRouteCard.vue'))
const AnimaQuickPanel = defineAsyncComponent(() => import('@/components/AnimaQuickPanel.vue'))
const props = defineProps<{ bindings: PromptRenderBindings }>()
const { pb, generationBusy, animaState, drawEngine, generationPresetSummary, managedRoute, applyManagedRoute,
  reuseSuccessfulRecipe, engineTitle, setDrawEngine, supportsDualCharacter, BUSY_HINT, selectAnimaModel,
  animaNoLoraMode, patchAnimaState, retryAnima } = props.bindings
const animaModelOptions = computed<StudioSelectOption[]>(() => animaState.value.models.map(model => ({
  value: model.id, label: (model.label || model.id) + (model.available === false ? ' · 模型未安装' : ''),
  disabled: model.available === false,
})))
function onAnimaModelSelected(value: string | number) { selectAnimaModel(String(value)) }
</script>

<style src="@/assets/css/director/components/PromptInspectorRender.css"></style>

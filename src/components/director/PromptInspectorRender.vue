<template>
  <div class="result-frame step-panel">
    <section v-if="drawEngine !== 'sd' && (animaState.errorReport || animaState.errorMsg)" class="inspector-generation-error" role="alert" aria-label="绘制恢复">
      <strong>{{ generationPresentation.needsReview ? '任务与结果待核对' : generationPresentation.phase === 'cancelling' ? '取消尚未确认' : animaState.errorReport?.title || '绘制未完成' }}</strong>
      <p>{{ generationPresentation.needsReview || generationPresentation.phase === 'cancelling' ? generationPresentation.message : animaState.errorReport?.message || animaState.errorMsg }}</p>
      <button v-if="generationPresentation.needsReview" class="btn btn-ghost btn-sm" type="button" @click="generationPresentation.review">重新查询原请求</button>
      <button v-else-if="generationPresentation.phase !== 'cancelling'" class="btn btn-ghost btn-sm anima-retry" type="button" :disabled="generationBusy" @click="retryAnima">按当前设置重试</button>
      <details v-if="animaState.errorReport?.details"><StudioDisclosureSummary>技术细节</StudioDisclosureSummary><code>{{ animaState.errorReport.details }}</code></details>
    </section>
    <details v-if="drawEngine !== 'sd' && generationBusy" class="inspector-route inspector-runtime">
      <StudioDisclosureSummary data-spring-button><span data-press-content>绘制详情</span></StudioDisclosureSummary>
      <div data-disclosure-content>
        <p role="status">{{ generationPresentation.message }}</p>
      </div>
    </details>
    <div class="inspector-engine-settings" role="group" aria-label="模型与引擎">
    <div v-content-motion:fade="drawEngine" class="base-model-picker">
      <label for="baseModel">基础模型</label>
      <StudioSelect id="baseModel" size="sm" label="基础模型" :model-value="animaState.modelId"
        :disabled="generationBusy" :hint="generationBusy ? BUSY_HINT : undefined"
        :options="animaModelOptions" @update:model-value="onAnimaModelSelected" />
    </div>
    <div v-if="drawEngine === 'anima' && !pb.isPopular && (pb.char === 'nene' || pb.char === 'natsume')" class="character-lora-setting">
      <ToggleSwitch :model-value="animaState.characterLoraEnabled !== false"
        :disabled="generationBusy || (!supportsNoLora && animaState.characterLoraEnabled !== false)"
        label="使用角色 LoRA" @update:model-value="setCharacterLoraEnabled">
        <span>使用角色 LoRA</span>
      </ToggleSwitch>
      <small v-if="!supportsNoLora">当前底模尚未确认支持无角色 LoRA</small>
    </div>
    </div>
    <section class="inspector-size-section"><slot name="size" /></section>
    <section class="inspector-style-section"><slot name="style" /></section>
    <details class="inspector-route inspector-advanced" @toggle="onAdvancedToggle">
      <StudioDisclosureSummary data-spring-button><span data-press-content class="inspector-detail-label"><span><ArchiveIcon name="gear" />{{ pb.directorMode === 'pro' ? '采样与细节' : '高级调整' }}</span><small>{{ generationPresetSummary || `${animaState.steps} 步 · CFG ${animaState.cfg}` }}</small></span></StudioDisclosureSummary>
      <div data-disclosure-content class="inspector-advanced-body">
        <template v-if="advancedLoaded">
          <AsyncPanel v-if="pb.directorMode !== 'pro'" :loader="loadCreativeSliders" label="画面采样微调" v-slot="{ component }">
            <component :is="component" :draw-engine="drawEngine" :disabled="generationBusy"
              v-model:sd-params="pb.sdParams" :anima-state="animaState" @touch-sd="pb.markParamTouched" @patch-anima="patchAnimaState" />
          </AsyncPanel>
          <AsyncPanel v-else :loader="loadAnimaQuickPanel" label="引擎采样参数" v-slot="{ component }">
            <component :is="component" :state="animaState" :no-lora="animaNoLoraMode" :studio-lora-disabled="!pb.isPopular && animaState.characterLoraEnabled === false" @update:state="patchAnimaState" />
          </AsyncPanel>
        </template>
      </div>
    </details>
    <ManagedDrawingRouteCard v-if="managedRoute" :route="managedRoute" :history="pb.history" :subject="pb.subject"
      :expert="pb.directorMode === 'pro'" :busy="generationBusy" @apply="applyManagedRoute" @reuse="reuseSuccessfulRecipe" />
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, ref } from 'vue'
import AsyncPanel from '@/components/ui/AsyncPanel.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
import { ANIMA_LORA_BY_CHARACTER } from '@/composables/generation/animaSessionContract'
const loadCreativeSliders = () => import('@/components/director/CasualCreativeSliders.vue')
const loadAnimaQuickPanel = () => import('@/components/AnimaQuickPanel.vue')
import type { StudioSelectOption } from '@/components/ui/StudioSelect.vue'
import type { PromptRenderBindings } from '@/composables/prompt/promptPanelBindings'
const ManagedDrawingRouteCard = defineAsyncComponent(() => import('@/components/ManagedDrawingRouteCard.vue'))
const props = defineProps<{ bindings: PromptRenderBindings }>()
const advancedLoaded = ref(false)
function onAdvancedToggle(event: Event) {
  if ((event.currentTarget as HTMLDetailsElement).open) advancedLoaded.value = true
}
const { pb, generationBusy, generationPresentation, animaState, drawEngine, generationPresetSummary, managedRoute, applyManagedRoute,
  reuseSuccessfulRecipe, BUSY_HINT, selectAnimaModel,
  animaNoLoraMode, currentCapabilities, patchAnimaState, refreshAnimaBackend, retryAnima } = props.bindings
const animaModelOptions = computed<StudioSelectOption[]>(() => animaState.value.models.map(model => ({
  value: model.id, label: (model.label || model.id) + (model.available === false ? animaState.value.provider === 'native' ? ' · 原生未就绪' : ' · 暂不可用' : ''),
  disabled: model.available === false,
})))
const supportsNoLora = computed(() => currentCapabilities.value.noLora)
function setCharacterLoraEnabled(enabled: boolean) {
  const character = pb.char
  if (character !== 'nene' && character !== 'natsume') return
  const id = ANIMA_LORA_BY_CHARACTER[character]
  patchAnimaState({ characterLoraEnabled: enabled, loraId: enabled && animaState.value.loras.some(item => item.id === id && item.available !== false) ? id : '' })
  if (enabled) void refreshAnimaBackend()
}
function onAnimaModelSelected(value: string | number) { selectAnimaModel(String(value)) }
</script>

<style src="@/assets/css/director/components/PromptInspectorRender.css"></style>

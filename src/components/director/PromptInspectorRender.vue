<template>
<details class="inspector-route"><summary>推荐配方与复用</summary>
<ManagedDrawingRouteCard v-if="managedRoute"
      class="pb-managed-route-banner"
      :route="managedRoute"
      :history="pb.history"
      :subject="pb.subject"
      :expert="pb.directorMode === 'pro'"
      :busy="generationBusy"
      @apply="applyManagedRoute"
      @reuse="reuseSuccessfulRecipe"
    />
          </details>
        <!-- Result panel -->
        <div class="result-frame step-panel" id="stepResult">
          <div class="panel-title">引擎与输出</div>

          <div v-if="pb.directorMode === 'pro'" class="engine-switch" role="group" aria-label="出图引擎">
            <StudioTooltip anchor :content="engineTitle('sd')">
              <button type="button" class="engine-btn" :class="{ active: drawEngine === 'sd' }"
                :disabled="generationBusy || pb.isPopular"
                @click="setDrawEngine('sd')">
                <ArchiveIcon name="scene" class="engine-mark" aria-hidden="true" />
                <span class="engine-copy">SD 引擎 <span class="engine-sub">{{ pb.isPopular ? '仅工作室角色' : 'WebUI · v18 LoRA' }}</span></span>
              </button>
            </StudioTooltip>
            <StudioTooltip anchor :content="engineTitle('anima')">
              <button type="button" class="engine-btn" :class="{ active: drawEngine === 'anima' }"
                :disabled="generationBusy || (!pb.isPopular && pb.char === 'triad' && !supportsDualCharacter('anima'))"
                @click="setDrawEngine('anima')">
                <ArchiveIcon name="spark" class="engine-mark" aria-hidden="true" />
                <span class="engine-copy">Anima 引擎 <span class="engine-sub">{{ pb.isPopular ? 'Aesthetic · 无需 LoRA' : 'v21 LoRA' }}</span></span>
              </button>
            </StudioTooltip>
            <StudioTooltip anchor :content="engineTitle('krea2')">
              <button type="button" class="engine-btn" :class="{ active: drawEngine === 'krea2' }"
                :disabled="generationBusy || (!pb.isPopular && pb.char === 'triad' && !supportsDualCharacter('krea2'))"
                @click="setDrawEngine('krea2')">
                <ArchiveIcon name="palette" class="engine-mark" aria-hidden="true" />
                <span class="engine-copy">Krea 2 <span class="engine-sub">{{ pb.isPopular ? '自然语言 · 身份优先' : 'ComfyUI · 自然语言实验' }}</span></span>
              </button>
            </StudioTooltip>
          </div>

          <div v-if="pb.directorMode === 'pro'" class="base-model-picker">
            <label for="baseModel">基础模型 (Checkpoint)</label>
            <StudioSelect
              v-if="drawEngine === 'sd'"
              id="baseModel"
              size="sm"
              label="基础模型 (Checkpoint)"
              v-model="pb.sdModelName"
              :disabled="generationBusy"
              :hint="generationBusy ? BUSY_HINT : undefined"
              :options="sdModelOptions"
            />
            <StudioSelect
              v-else
              id="baseModel"
              size="sm"
              label="基础模型 (Checkpoint)"
              :model-value="animaState.modelId"
              :disabled="generationBusy"
              :hint="generationBusy ? BUSY_HINT : undefined"
              :options="animaModelOptions"
              @update:model-value="onAnimaModelSelected"
            />
          </div>




        </div>
        <!-- SD params -->
        <GenerationParamsPanel :open="true" v-if="drawEngine === 'sd' && pb.directorMode === 'pro'"
          v-model:params="pb.sdParams"
          :samplers="sd.samplers.value"
          :schedulers="sd.schedulers.value"
          :result-seed="displayResultSeed"
          @touch="pb.markParamTouched"
          @reuse-seed="reuseLastSeed"
          @reset="resetSdParams"
        />

        <AnimaQuickPanel :open="true" v-if="drawEngine !== 'sd' && pb.directorMode === 'pro'"
          :state="animaState"
          :no-lora="animaNoLoraMode"
          @update:state="patchAnimaState"
          @retry="retryAnima"
        />

          <GenerationOutputControls
            :engine="drawEngine"
            :expert="pb.directorMode === 'pro'"
            :preset-summary="generationPresetSummary"
            v-model:params="pb.sdParams"
            :vram-hint="vramHint"
            :vram-level="vramLevel"
            :base-resolution-risk="baseResolutionRisk"
            :base-resolution-hint="baseResolutionHint"
            :can-use-face-detailer="canUseFaceDetailer"
            :generating="generationBusy"
            :result-seed="displayResultSeed"
            :has-result="Boolean(displayResultUrl)"
            :anima-hires-fix="Boolean(animaState.hiresFix)"
            :queue-available="pb.isPopular ? false : sdQueue.canEnqueue.value"
            @update:anima-hires-fix="patchAnimaState({ hiresFix: $event })"
            @upscale-current="upscaleCurrentResult"
            @touch="pb.markParamTouched"
            @enqueue="enqueueCurrent"
            @enqueue-variants="enqueue3Variants"
            @reuse-seed="reuseLastSeed"
            @reset="resetAll"
          />
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import type { StudioSelectOption } from '@/components/ui/StudioSelect.vue'
import type { PromptRenderBindings } from '@/composables/prompt/promptPanelBindings'
const ManagedDrawingRouteCard = defineAsyncComponent(() => import('@/components/ManagedDrawingRouteCard.vue'))
const GenerationParamsPanel = defineAsyncComponent(() => import('@/components/GenerationParamsPanel.vue'))
const AnimaQuickPanel = defineAsyncComponent(() => import('@/components/AnimaQuickPanel.vue'))
const GenerationOutputControls = defineAsyncComponent(() => import('@/components/GenerationOutputControls.vue'))

const props = defineProps<{ bindings: PromptRenderBindings }>()
const { pb, displayResultUrl, sd, generationBusy, animaState, drawEngine, upscaleCurrentResult, generationPresetSummary, sdQueue, managedRoute, applyManagedRoute, reuseSuccessfulRecipe, engineTitle, setDrawEngine, supportsDualCharacter, BUSY_HINT, selectAnimaModel, displayResultSeed, reuseLastSeed, resetSdParams, animaNoLoraMode, patchAnimaState, retryAnima, vramHint, vramLevel, baseResolutionRisk, baseResolutionHint, canUseFaceDetailer, enqueueCurrent, enqueue3Variants, resetAll } = props.bindings

// —— 原生 <select> → StudioSelect 选项构造（2026-09-22 去原生化）——
const sdModelOptions = computed<StudioSelectOption[]>(() => [
  { value: '', label: '使用 WebUI 当前模型' },
  ...sd.models.value.map(model => ({ value: model, label: model })),
])
const animaModelOptions = computed<StudioSelectOption[]>(() =>
  animaState.value.models.map(model => ({
    value: model.id,
    label: `${model.label || model.id}${model.available === false ? ' · 模型未安装' : ''}`,
    disabled: model.available === false,
  })),
)
// selectAnimaModel 已按新签名收 string（见 useDirectorEngine），
// 不再需要把值伪装成 Event 对象。
function onAnimaModelSelected(value: string | number) {
  selectAnimaModel(String(value))
}
</script>

<style src="@/assets/css/director/components/PromptInspectorRender.css"></style>

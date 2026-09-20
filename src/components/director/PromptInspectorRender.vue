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
            <button type="button" class="engine-btn" :class="{ active: drawEngine === 'sd' }"
              :disabled="generationBusy || pb.isPopular"
              :title="engineTitle('sd')"
              @click="setDrawEngine('sd')">
              <ArchiveIcon name="scene" class="engine-mark" aria-hidden="true" />
              <span class="engine-copy">SD 引擎 <span class="engine-sub">{{ pb.isPopular ? '仅工作室角色' : 'WebUI · v18 LoRA' }}</span></span>
            </button>
            <button type="button" class="engine-btn" :class="{ active: drawEngine === 'anima' }"
              :disabled="generationBusy || (!pb.isPopular && pb.char === 'triad' && !supportsDualCharacter('anima'))" :title="engineTitle('anima')"
              @click="setDrawEngine('anima')">
              <ArchiveIcon name="spark" class="engine-mark" aria-hidden="true" />
              <span class="engine-copy">Anima 引擎 <span class="engine-sub">{{ pb.isPopular ? 'Aesthetic · 无需 LoRA' : 'v21 LoRA' }}</span></span>
            </button>
            <button type="button" class="engine-btn" :class="{ active: drawEngine === 'krea2' }"
              :disabled="generationBusy || (!pb.isPopular && pb.char === 'triad' && !supportsDualCharacter('krea2'))" :title="engineTitle('krea2')" @click="setDrawEngine('krea2')">
              <ArchiveIcon name="palette" class="engine-mark" aria-hidden="true" />
              <span class="engine-copy">Krea 2 <span class="engine-sub">{{ pb.isPopular ? '自然语言 · 身份优先' : 'ComfyUI · 自然语言实验' }}</span></span>
            </button>
          </div>

          <div v-if="pb.directorMode === 'pro'" class="base-model-picker">
            <label for="baseModel">基础模型 (Checkpoint)</label>
            <select v-if="drawEngine === 'sd'" id="baseModel" v-model="pb.sdModelName" :disabled="generationBusy"
              :title="generationBusy ? BUSY_HINT : undefined">
              <option value="">使用 WebUI 当前模型</option>
              <option v-for="model in sd.models.value" :key="model" :value="model">{{ model }}</option>
            </select>
            <select v-else id="baseModel" :value="animaState.modelId" :disabled="generationBusy"
              :title="generationBusy ? BUSY_HINT : undefined" @change="selectAnimaModel">
              <option v-for="model in animaState.models" :key="model.id" :value="model.id" :disabled="model.available === false">
                {{ model.label || model.id }}{{ model.available === false ? ' · 模型未安装' : '' }}
              </option>
            </select>
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
import { defineAsyncComponent } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import type { PromptRenderBindings } from '@/composables/prompt/promptPanelBindings'
const ManagedDrawingRouteCard = defineAsyncComponent(() => import('@/components/ManagedDrawingRouteCard.vue'))
const GenerationParamsPanel = defineAsyncComponent(() => import('@/components/GenerationParamsPanel.vue'))
const AnimaQuickPanel = defineAsyncComponent(() => import('@/components/AnimaQuickPanel.vue'))
const GenerationOutputControls = defineAsyncComponent(() => import('@/components/GenerationOutputControls.vue'))

const props = defineProps<{ bindings: PromptRenderBindings }>()
const { pb, displayResultUrl, sd, generationBusy, animaState, drawEngine, upscaleCurrentResult, generationPresetSummary, sdQueue, managedRoute, applyManagedRoute, reuseSuccessfulRecipe, engineTitle, setDrawEngine, supportsDualCharacter, BUSY_HINT, selectAnimaModel, displayResultSeed, reuseLastSeed, resetSdParams, animaNoLoraMode, patchAnimaState, retryAnima, vramHint, vramLevel, baseResolutionRisk, baseResolutionHint, canUseFaceDetailer, enqueueCurrent, enqueue3Variants, resetAll } = props.bindings
</script>

<style src="@/assets/css/director/components/PromptInspectorRender.css"></style>

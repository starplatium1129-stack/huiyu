<template>
  <div class="generation-output-controls">
    <!-- 尺寸选择与生成/停止已上移至画布下的吸附出图条 GenerationActionBar（2026-08-28） -->
    <div v-if="engine === 'sd' && expert" class="sd-inline-options">
      <span class="sd-vram-hint advanced-decision" :class="vramLevel">{{ vramHint }}</span>
      <span v-if="baseResolutionRisk" class="sd-base-resolution-hint advanced-decision" :class="baseResolutionRisk">{{ baseResolutionHint }}</span>
      <label class="hires-label advanced-decision">
        <ToggleSwitch v-model="params.hiresFix" label="hires.fix">
          <ArchiveIcon name="spark" class="control-icon-inline" />
          <span>hires.fix</span>
        </ToggleSwitch>
      </label>
      <label v-if="canUseFaceDetailer" class="hires-label advanced-decision">
        <ToggleSwitch v-model="params.faceDetailer" label="面部与手部修复" @change="touch('faceDetailer')">
          <span>面部与手部修复</span>
        </ToggleSwitch>
      </label>
      <details v-if="params.hiresFix" class="sd-advanced-options advanced-decision">
        <summary>高级设置</summary>
        <div class="sd-advanced-grid">
          <label>放大<StudioSelect v-model.number="params.hiresScale" size="sm" label="放大倍率" :options="[{ value: 1.5, label: '1.5×' }, { value: 2, label: '2×' }]" @update:model-value="touch('hiresScale')" /></label>
          <label>二阶段步数<input type="number" v-model.number="params.hiresSteps" min="0" max="60" step="1" @change="touch('hiresSteps')"></label>
          <label>重绘幅度<input type="number" v-model.number="params.hiresDenoise" min="0.1" max="0.9" step="0.05" @change="touch('hiresDenoise')"></label>
          <label>放大器<StudioSelect v-model="params.hiresUpscaler" size="sm" label="放大器" :options="upscalerOptions" @update:model-value="touch('hiresUpscaler')" /></label>
        </div>
      </details>
    </div>

    <div v-if="presetSummary" class="generation-auto-summary tw:flex tw:items-baseline tw:justify-between tw:gap-[12px] tw:mb-[10px] tw:rounded-md tw:text-muted tw:text-body tw:leading-body tw:flex-wrap">
      <span>自动参数</span>
      <strong>{{ presetSummary }}</strong>
    </div>

    <div v-if="engine === 'sd'" class="preview-actions">
      <button class="btn btn-ghost" type="button" :disabled="!queueAvailable" @click="$emit('enqueue')">加入队列</button>
      <StudioTooltip anchor content="一键将 3 组不同 Seed 候选变体加入队列">
        <button class="btn btn-ghost" type="button" :disabled="!queueAvailable" @click="$emit('enqueue-variants')">3 组候选</button>
      </StudioTooltip>
    </div>
    <details class="inspector-route output-reset">
      <summary><span>重新开始</span><ArchiveIcon name="chevron-down" /></summary>
      <button class="btn btn-ghost" type="button" @click="$emit('reset')">清空并重来</button>
    </details>
  </div>
</template>

<script setup lang="ts">
import type { DrawEngine } from '@/storage/settingsRepository'
import type { SDParams } from '@/utils/promptBuilderPersistence'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import type { StudioSelectOption } from '@/components/ui/StudioSelect.vue'
import '@/assets/css/director/components/GenerationOutputControls.css'

defineProps<{
  engine: DrawEngine
  expert: boolean
  presetSummary: string
  vramHint: string
  vramLevel: string
  baseResolutionRisk: string
  baseResolutionHint: string
  canUseFaceDetailer: boolean
  queueAvailable: boolean
}>()

// params 由 Pinia store 的 reactive 对象承载，子组件按契约直接改字段；
// 用 defineModel 承载该双向约定（替代裸 prop 深层变更）。
const params = defineModel<SDParams>('params', { required: true })

const emit = defineEmits<{
  touch: [key: keyof SDParams]
  enqueue: []
  'enqueue-variants': []
  reset: []
}>()

function touch(key: keyof SDParams) { emit('touch', key) }

// —— 原生 <select> → StudioSelect 选项构造（2026-09-22 去原生化）——
const upscalerOptions: StudioSelectOption[] = [
  { value: 'Auto', label: 'Auto' },
  { value: 'Remacri', label: 'Remacri' },
  { value: 'Latent', label: 'Latent' },
  { value: 'Latent (nearest-exact)', label: 'Latent (nearest-exact)' },
  { value: 'R-ESRGAN 4x+ Anime6B', label: 'R-ESRGAN 4x+ Anime6B' },
  { value: 'R-ESRGAN 4x+', label: 'R-ESRGAN 4x+' },
]
</script>

<style scoped>
@reference "../assets/css/tailwind.css";
.generation-auto-summary {
  padding: 9px 11px;
  border: 1px solid var(--border-soft);
  background: var(--bg-deep);
}
.control-icon-inline {
  @apply tw:w-[14px] tw:h-[14px] tw:inline-block;
  vertical-align: -2px;
  @apply tw:text-accent;
}
.output-reset { margin-top:var(--s-3); }
.output-reset > .btn { margin-top:var(--s-2); }
</style>

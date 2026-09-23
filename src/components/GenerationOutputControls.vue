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

    <div v-if="presetSummary" class="generation-auto-summary">
      <span>自动参数</span>
      <strong>{{ presetSummary }}</strong>
    </div>

    <div class="preview-actions">
      <StudioTooltip v-if="hasResult && (engine === 'anima' || engine === 'sd')" anchor content="使用当前 Seed 生成放大版本，最终尺寸取决于原画布">
        <button
          class="btn btn-ghost btn-hires-action-quick"
          type="button"
          :disabled="generating"
          @click="$emit('upscale-current')"
        >
          <ArchiveIcon name="spark" class="control-icon-inline" />
          <span>高清放大 2×</span>
        </button>
      </StudioTooltip>
      <button v-if="engine === 'sd'" class="btn btn-ghost" type="button" :disabled="!queueAvailable" @click="$emit('enqueue')">加入队列</button>
      <StudioTooltip v-if="engine === 'sd'" anchor content="一键将 3 组不同 Seed 候选变体加入队列">
        <button class="btn btn-ghost" type="button" :disabled="!queueAvailable" @click="$emit('enqueue-variants')">3 组候选</button>
      </StudioTooltip>
      <button v-if="engine === 'sd' && expert" class="btn btn-ghost" type="button" :disabled="resultSeed == null" @click="$emit('reuse-seed')">
        锁定这个 seed 微调
      </button>
      <button class="btn btn-ghost" type="button" @click="$emit('reset')">清空并重来</button>
    </div>
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
  generating: boolean
  resultSeed: number | null
  queueAvailable: boolean
  hasResult?: boolean
  animaHiresFix?: boolean
}>()

// params 由 Pinia store 的 reactive 对象承载，子组件按契约直接改字段；
// 用 defineModel 承载该双向约定（替代裸 prop 深层变更）。
const params = defineModel<SDParams>('params', { required: true })

const emit = defineEmits<{
  'update:animaHiresFix': [value: boolean]
  touch: [key: keyof SDParams]
  'upscale-current': []
  enqueue: []
  'enqueue-variants': []
  'reuse-seed': []
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
.generation-auto-summary {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
  padding: 9px 11px;
  border: 1px solid var(--border-soft);
  border-radius: var(--r-md);
  background: var(--bg-deep);
  color: var(--text-muted);
  font-size: var(--fs-body);
  line-height:var(--lh-body);
  flex-wrap:wrap;
}
.control-icon-inline {
  width: 14px;
  height: 14px;
  display: inline-block;
  vertical-align: -2px;
  color: var(--accent);
}
.btn-hires-action-quick {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 30%, var(--border-soft));
  background: color-mix(in srgb, var(--accent-soft) 30%, transparent);
}
.btn-hires-action-quick:hover {
  background: var(--accent-soft);
  border-color: var(--accent);
}
</style>

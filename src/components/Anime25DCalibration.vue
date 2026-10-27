<script setup lang="ts">
import { onBeforeUnmount, ref, useId, watch } from 'vue'
import { CALIBRATION_FIELDS, type CalibrationKey } from '@/anime25d/calibration'
import type { useAnime25DStage } from '@/composables/useAnime25DStage'

const props = defineProps<{ runtime: ReturnType<typeof useAnime25DStage> }>()
const uid = useId()
const expanded = ref(false), preview = ref<HTMLCanvasElement | null>(null)
watch([expanded, preview], () => props.runtime.calibration.setPreview(expanded.value ? preview.value : null), { flush: 'post' })
onBeforeUnmount(() => props.runtime.calibration.setPreview(null))
function update(key: CalibrationKey, event: Event) {
  props.runtime.calibration.update(key, Number((event.target as HTMLInputElement).value))
}
</script>

<template>
  <details class="anime25d-calibration" @toggle="expanded = ($event.target as HTMLDetailsElement).open">
    <summary>模型校准{{ runtime.calibration.dirty.value ? ' · 有未保存修改' : '' }}</summary>
    <div class="anime25d-calibration-body">
      <p>已自动识别五官、支点与图层深度。下面的微调即时预览，保存后随这份 PSD 复用；更换角色不会共用另一份模型的设置。</p>
      <p>换图或切回原立绘前请保存。重新导出的 PSD 会作为新模型识别。</p>
      <div class="anime25d-calibration-preview">
        <canvas ref="preview" width="320" height="320" role="img" aria-label="当前模型脸部实时预览" />
        <div class="anime25d-calibration-actions">
          <button class="btn btn-ghost" type="button" :disabled="runtime.busy.value" @click="runtime.playMotion('look-around')">预览转头</button>
          <button class="btn btn-ghost" type="button" :disabled="runtime.busy.value" @click="runtime.playMotion('headpat')">预览闭眼</button>
          <button class="btn btn-ghost" type="button" :disabled="runtime.busy.value" @click="runtime.previewMouth">预览口型</button>
        </div>
      </div>
      <fieldset :disabled="runtime.busy.value || runtime.calibration.saving.value">
        <legend>运动与差分对齐</legend>
        <div v-for="field in CALIBRATION_FIELDS" :key="field.key" class="anime25d-calibration-field">
          <div><label :for="`${uid}-${field.key}`">{{ field.label }}</label><output :for="`${uid}-${field.key}`">{{ runtime.calibration.value.value[field.key] }}{{ field.unit }}</output></div>
          <input :id="`${uid}-${field.key}`" type="range" :min="field.min" :max="field.max" step="1" :value="runtime.calibration.value.value[field.key]" :aria-valuetext="`${runtime.calibration.value.value[field.key]}${field.unit}`" @input="update(field.key, $event)" />
        </div>
      </fieldset>
      <div class="anime25d-calibration-actions">
        <button class="btn btn-ghost" type="button" :disabled="runtime.busy.value" @click="runtime.calibration.reset">恢复自动绑定</button>
        <button class="btn btn-ghost" type="button" :disabled="!runtime.calibration.dirty.value || runtime.calibration.saving.value || runtime.busy.value" @click="runtime.calibration.revert">撤销微调</button>
        <button class="btn btn-primary" type="button" :disabled="!runtime.calibration.dirty.value || runtime.calibration.saving.value || runtime.busy.value" @click="runtime.calibration.save">{{ runtime.calibration.saving.value ? '正在保存…' : '保存此模型校准' }}</button>
      </div>
      <span v-if="runtime.calibration.message.value" role="status">{{ runtime.calibration.message.value }}</span>
      <p v-if="runtime.calibration.error.value" role="alert">{{ runtime.calibration.error.value }}</p>
    </div>
  </details>
</template>

<style scoped>
.anime25d-calibration-body { display: grid; gap: var(--s-3); padding-block: var(--s-3); }
.anime25d-calibration-body p { margin: 0; color: var(--text-secondary); line-height: var(--lh-body); }
.anime25d-calibration-preview { position: sticky; top: 0; z-index: 1; display: grid; justify-items: center; gap: var(--s-2); padding-block: var(--s-2); background: var(--bg-elevated); }
.anime25d-calibration-preview canvas { display: block; inline-size: min(100%, 240px, 24dvh); block-size: auto; border-radius: var(--r-md); background: var(--bg-surface); }
.anime25d-calibration-body fieldset { display: grid; gap: var(--s-3); min-inline-size: 0; padding: 0; border: 0; }
.anime25d-calibration-body legend { padding: 0 0 var(--s-2); font-weight: 600; }
.anime25d-calibration-field { display: grid; gap: var(--s-1); }
.anime25d-calibration-field > div { display: flex; flex-wrap: wrap; justify-content: space-between; gap: var(--s-2); }
.anime25d-calibration-field output { font-variant-numeric: tabular-nums; color: var(--text-secondary); }
.anime25d-calibration-field input { inline-size: 100%; }
.anime25d-calibration-actions { display: flex; flex-wrap: wrap; gap: var(--s-2); }
.anime25d-calibration-body [role="alert"] { color: var(--danger); }
.anime25d-calibration-body button:disabled, .anime25d-calibration-body fieldset:disabled :is(label, output) { color: var(--text-disabled); }
</style>

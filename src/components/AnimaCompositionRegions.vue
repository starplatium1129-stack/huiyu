<script setup lang="ts">
import { nextTick, ref } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { contentMotion as vContentMotion } from '@/directives/contentMotion'
import { ANIMA_REGION_PROMPT_LIMIT, MAX_ANIMA_REGIONS, type AnimaRegionPreset } from '@/types/animaComposition'
import type { AnimaCompositionSession } from '@/composables/generation/useAnimaComposition'

const props = defineProps<{ session: AnimaCompositionSession }>()
const { regions, selectedId, selectedRegion, locked, regionIssue } = props.session
const promptInput = ref<HTMLTextAreaElement | null>(null)
const addButton = ref<HTMLButtonElement | null>(null)
const presets: { id: AnimaRegionPreset; label: string }[] = [
  { id: 'left', label: '左半' }, { id: 'right', label: '右半' }, { id: 'top', label: '上半' },
  { id: 'bottom', label: '下半' }, { id: 'center', label: '居中' },
]
const bounds = [{ key: 'x', label: '左侧位置', min: 0 }, { key: 'y', label: '顶部位置', min: 0 },
  { key: 'width', label: '宽度', min: .1 }, { key: 'height', label: '高度', min: .1 }] as const
async function add() {
  props.session.addRegion()
  await nextTick()
  promptInput.value?.focus({ preventScroll: true })
}
async function remove() {
  if (!selectedRegion.value) return
  props.session.removeRegion(selectedRegion.value.id)
  await nextTick()
  ;(promptInput.value ?? addButton.value)?.focus({ preventScroll: true })
}
</script>

<template>
  <section class="composition-regions" aria-labelledby="composition-regions-title">
    <div class="composition-section-heading"><h3 id="composition-regions-title">区域提示词</h3><span>{{ regions.length }} / {{ MAX_ANIMA_REGIONS }}</span></div>
    <p class="composition-help">全局描述继续生效；每个矩形补充自己的正向提示词。区域可以重叠。</p>
    <p v-if="regionIssue" class="composition-help" role="status">{{ regionIssue }}</p>
    <div class="composition-region-tabs" role="group" aria-label="选择编辑区域">
      <button v-for="(region, index) in regions" :key="region.id" class="btn btn-ghost btn-sm" type="button"
        :aria-pressed="selectedId === region.id" :disabled="locked" @click="selectedId = region.id">区域 {{ index + 1 }}</button>
      <button ref="addButton" class="btn btn-ghost btn-sm" type="button" :disabled="locked || !!regionIssue || regions.length >= MAX_ANIMA_REGIONS" @click="add"><ArchiveIcon name="plus" />添加区域</button>
    </div>
    <div v-if="selectedRegion" v-content-motion:fade="selectedId" class="composition-region-form">
      <label class="composition-field"><span>区域 {{ regions.indexOf(selectedRegion) + 1 }} 的正向提示词</span>
        <textarea ref="promptInput" v-model="selectedRegion.prompt" :disabled="locked" rows="4" :maxlength="ANIMA_REGION_PROMPT_LIMIT"
          placeholder="描述这个区域里的人物、物体或背景…" spellcheck="false" autocorrect="off" autocapitalize="off" />
      </label>
      <div class="composition-presets" role="group" aria-label="快速设置区域位置">
        <button v-for="preset in presets" :key="preset.id" class="btn btn-quiet btn-sm" type="button" :disabled="locked"
          @click="session.applyPreset(preset.id)">{{ preset.label }}</button>
      </div>
      <div class="composition-bounds">
        <label v-for="bound in bounds" :key="bound.key" class="composition-field"><span>{{ bound.label }} %</span>
          <input type="number" :value="Math.round(selectedRegion[bound.key] * 10000) / 100" :min="bound.min" max="100" step="1" :disabled="locked"
            @input="session.updateBounds(bound.key, ($event.target as HTMLInputElement).valueAsNumber)" />
        </label>
      </div>
      <button class="btn btn-quiet btn-sm composition-remove-region" type="button" :disabled="locked" @click="remove"><ArchiveIcon name="close" />移除这个区域</button>
    </div>
    <p v-else class="composition-help">添加区域后，在预览中选择它，用数值或位置预设调整范围。</p>
  </section>
</template>

<style scoped>
.composition-regions,.composition-region-form { display:flex; flex-direction:column; gap:var(--s-3); min-width:0; }
.composition-section-heading { display:flex; align-items:center; justify-content:space-between; gap:var(--s-2); }
.composition-section-heading h3 { margin:0; color:var(--text-primary); font:600 var(--fs-body)/var(--lh-label) var(--font-sans); }
.composition-section-heading > span,.composition-help { color:var(--text-secondary); font:400 var(--fs-label-sm)/var(--lh-body) var(--font-sans); }
.composition-help { margin:0; }
.composition-region-tabs,.composition-presets { display:flex; flex-wrap:wrap; gap:var(--s-1); }
.composition-region-tabs [aria-pressed='true'] { border-color:var(--accent); background:var(--accent-soft); color:var(--text-primary); }
.composition-field { display:flex; flex-direction:column; gap:var(--s-2); min-width:0; color:var(--text-primary); font-size:var(--fs-label-sm); }
.composition-field textarea { width:100%; }
.composition-bounds { display:grid; grid-template-columns:1fr 1fr; gap:var(--s-3); }
.composition-bounds input { width:100%; }
.composition-remove-region { align-self:flex-start; }
</style>

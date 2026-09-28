<script setup lang="ts">
import type { VideoDefaults } from '@/api/videoApi'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioSelect, { type StudioSelectOption } from '@/components/ui/StudioSelect.vue'

defineProps<{
  aspectOptions: readonly StudioSelectOption[]
  durationOptions: readonly StudioSelectOption[]
  qualityOptions: readonly StudioSelectOption[]
  canGenerate: boolean
  submitting: boolean
  submitTitle: string
  submitDescription: string
}>()
const aspectRatio = defineModel<VideoDefaults['aspectRatio']>('aspectRatio', { required: true })
const duration = defineModel<VideoDefaults['duration']>('duration', { required: true })
const quality = defineModel<VideoDefaults['quality']>('quality', { required: true })
defineEmits<{ generate: [] }>()
</script>

<template>
  <section class="video-generation-bar" aria-label="视频生成设置" :data-ready="canGenerate || undefined">
    <div class="video-generation-fields">
      <label class="video-generation-field video-generation-aspect"><span>画幅</span>
        <StudioSelect :model-value="aspectRatio" :options="aspectOptions" label="选择视频画幅" :disabled="submitting"
          @update:model-value="aspectRatio = $event as VideoDefaults['aspectRatio']" />
      </label>
      <label class="video-generation-field"><span>时长</span>
        <StudioSelect :model-value="duration" :options="durationOptions" label="选择视频时长" :disabled="submitting"
          @update:model-value="duration = $event as VideoDefaults['duration']" />
      </label>
      <label class="video-generation-field"><span>画质</span>
        <StudioSelect :model-value="quality" :options="qualityOptions" label="选择视频画质档位" :disabled="submitting || !qualityOptions.length" placeholder="等待环境检测"
          @update:model-value="quality = $event as VideoDefaults['quality']" />
      </label>
    </div>
    <div class="video-generation-summary"><strong>{{ submitTitle }}</strong><p>{{ submitDescription }}</p></div>
    <button class="btn btn-primary btn-lg" type="button" :disabled="!canGenerate" @click="$emit('generate')">
      <ArchiveIcon name="play" />{{ submitting ? '正在提交…' : '生成视频' }}
    </button>
  </section>
</template>

<style scoped>
@reference "../../assets/css/tailwind.css";
.video-generation-bar {
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(12rem, 22rem) auto;
  align-items: center; gap: var(--s-4); margin-bottom: var(--s-4); padding: var(--s-3) var(--s-4);
  border: 1px solid var(--border-soft); border-radius: var(--r-xl); background: var(--bg-surface);
  box-shadow: var(--shadow-glass-sm);
}
.video-generation-bar[data-ready="true"] { border-color: color-mix(in srgb, var(--accent) 40%, var(--border-soft)); }
.video-generation-fields { display: grid; grid-template-columns: minmax(0, 1.7fr) repeat(2, minmax(0, 1fr)); gap: var(--s-3); min-width: 0; }
.video-generation-field { display: grid; gap: var(--s-1); min-width: 0; }
.video-generation-field > span { color: var(--text-secondary); font-size: var(--fs-label-sm); font-weight: 600; }
.video-generation-summary { min-width: 0; }
.video-generation-summary strong { color: var(--text-primary); font-size: var(--fs-body-sm); }
.video-generation-summary p { margin: var(--s-1) 0 0; color: var(--text-muted); font-size: var(--fs-label-sm); line-height: var(--lh-body); }
.video-generation-bar > .btn { white-space: nowrap; }
@media (min-width: 1001px) {
  .video-generation-bar { position: sticky; top: calc(var(--app-navigation-height, 80px) + var(--s-2)); z-index: var(--z-sticky); }
}
</style>

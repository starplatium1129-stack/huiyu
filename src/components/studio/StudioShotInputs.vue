<template>
  <details ref="section" class="studio-video-source">
    <StudioDisclosureSummary
      >角色画面与配音{{ shot.audioVersionId ? ' · 已绑定配音' : '' }}</StudioDisclosureSummary
    >
    <div data-disclosure-content class="studio-video-form">
      <div class="studio-video-fields">
        <div>
          <label for="studio-dialogue-portrait">角色画面 · 首帧</label>
          <StudioSelect
            id="studio-dialogue-portrait"
            :model-value="shot.firstVersionId || ''"
            :options="portraits"
            searchable
            :disabled="busy"
            placeholder="选择角色立绘或差分版本"
            @update:model-value="bind('firstVersionId', $event)"
          />
        </div>
        <div>
          <label for="studio-dialogue-audio">镜头配音</label>
          <StudioSelect
            id="studio-dialogue-audio"
            :model-value="shot.audioVersionId || ''"
            :options="voices"
            searchable
            :disabled="busy"
            placeholder="选择 WAV 素材版本"
            @update:model-value="bind('audioVersionId', $event)"
          />
        </div>
      </div>
      <p class="studio-caption">
        对白镜头按配音长度出片，每秒 25 帧。请选择 15 秒、20 MiB 以内的单声道或双声道 PCM WAV，采样率为 8 至 192
        kHz。
      </p>
      <p v-if="voices.length === 1" class="studio-caption">先在素材库选择“配音”，导入 WAV 后就可以绑定到这里。</p>
      <StudioVersionMedia
        v-if="shot.audioVersionId"
        :key="shot.audioVersionId"
        :data="data"
        :repo="repo"
        :version-id="shot.audioVersionId"
        kind="audio"
        :label="shot.title + '的配音'"
      />
    </div>
  </details>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import type { StudioProjectSnapshot, StudioShot, StudioProjectRepository } from '@/storage/studioProjectRepository'
import StudioVersionMedia from './StudioVersionMedia.vue'
const props = defineProps<{
  data: StudioProjectSnapshot
  shot: StudioShot
  repo: StudioProjectRepository
  busy: boolean
}>()
type Slot = 'firstVersionId' | 'audioVersionId'
const emit = defineEmits<{ bind: [slot: Slot, versionId: string | null] }>()
const section = ref<HTMLDetailsElement>()
const assets = computed(() => new Map(props.data.assets.map((a) => [a.id, a])))
const portraits = computed(() => {
  const result = props.data.versions
    .filter(
      (v) =>
        v.id === props.shot.firstVersionId ||
        (['character', 'outfit', 'expression', 'pose', 'keyframe'].includes(assets.value.get(v.assetId)?.kind || '') &&
          ['image/png', 'image/jpeg', 'image/webp'].includes(v.mime) &&
          v.bytes <= 20 * 1024 * 1024)
    )
    .map((v) => ({ value: v.id, label: (assets.value.get(v.assetId)?.title || '素材') + ' · v' + v.number }))
  return [{ value: '', label: '无首帧' }, ...result]
})
const voices = computed(() => [
  { value: '', label: '无绑定配音' },
  ...props.data.versions
    .filter((v) => v.mime === 'audio/wav')
    .map((v) => ({ value: v.id, label: (assets.value.get(v.assetId)?.title || '配音') + ' · v' + v.number })),
])
function bind(slot: Slot, value: string | number | undefined) {
  const id = typeof value === 'string' && value ? value : null
  if (!props.busy && id !== (props.shot[slot] || null)) emit('bind', slot, id)
}
function reveal() {
  if (!section.value) return
  section.value.open = true
  section.value.querySelector('summary')?.focus()
}
defineExpose({ reveal })
</script>

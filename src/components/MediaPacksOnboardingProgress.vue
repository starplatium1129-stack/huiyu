<script setup lang="ts">
import { ref } from 'vue'
import type { MediaPacksTask } from '@/api/mediaPacksApi'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { formatPackBytes, formatPackSpeed } from '@/composables/useMediaPacks'

defineProps<{
  task: MediaPacksTask | null
  activePackLabel: string
  progressValue: number | undefined
  progressId: string
}>()

defineEmits<{
  background: []
  cancel: []
}>()

const backgroundButton = ref<HTMLButtonElement | null>(null)

defineExpose({
  focusBackgroundButton() {
    backgroundButton.value?.focus({ preventScroll: true })
  },
})
</script>

<template>
  <div class="media-onboarding-progress">
    <div class="media-progress-head">
      <div role="status" aria-live="polite" aria-atomic="true">
        <strong>{{ `${activePackLabel} · ${task?.message || '处理中…'}` }}</strong>
        <span v-if="task?.mirrorLabel">{{ task.mirrorLabel }}</span>
      </div>
      <span v-if="progressValue !== undefined" class="media-progress-pct">{{ progressValue }}%</span>
    </div>

    <progress
      :id="progressId"
      class="media-native-progress"
      max="100"
      :value="progressValue"
      :aria-label="`${activePackLabel}下载与安装进度`"
    />

    <div v-if="task" class="media-progress-meta">
      <span v-if="task.phase === 'extracting' && task.filesTotal > 0">
        正在解压：{{ task.filesDone }} / {{ task.filesTotal }} 个文件
      </span>
      <span v-else-if="task.total > 0">
        {{ formatPackBytes(task.bytes) }} / {{ formatPackBytes(task.total) }}
      </span>
      <span v-else>正在准备资源信息…</span>
      <span v-if="task.speedBps > 0" class="media-progress-speed">{{ formatPackSpeed(task.speedBps) }}</span>
    </div>

    <div class="media-progress-actions">
      <button ref="backgroundButton" class="btn btn-primary" type="button" @click="$emit('background')">后台下载，先进入绘遇</button>
      <button class="btn btn-ghost" type="button" :disabled="task?.state === 'cancelling'" @click="$emit('cancel')">
        <ArchiveIcon name="stop" />{{ task?.state === 'cancelling' ? '正在暂停…' : '暂停下载（保留进度）' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.media-onboarding-progress {
  display: grid;
  gap: var(--s-3);
  padding: var(--s-4);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-lg);
  background: var(--bg-deep);
}
.media-progress-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-3);
}
.media-progress-head > div {
  display: grid;
  gap: 2px;
  min-inline-size: 0;
}
.media-progress-head strong {
  font-size: var(--fs-body);
}
.media-progress-head span {
  font-size: var(--fs-label-xs);
  color: var(--text-secondary);
}
.media-progress-pct {
  font-size: var(--fs-title);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--accent);
}
.media-native-progress {
  inline-size: 100%;
  block-size: 10px;
  appearance: none;
  border: 0 solid;
  border-radius: var(--r-pill);
  overflow: clip;
  background: var(--border-soft);
  container-type: inline-size;
  --progress-bar-indeterminate-size: 30%;
  --progress-bar-indeterminate-duration: 1.5s;
}
.media-native-progress::-webkit-progress-bar {
  background: transparent;
}
.media-native-progress::-webkit-progress-value {
  background: var(--accent);
  border-radius: var(--r-pill);
  transition: inline-size 0.25s ease;
}
.media-native-progress::-moz-progress-bar {
  background: var(--accent);
  border-radius: var(--r-pill);
  transition: inline-size 0.25s ease;
}
.media-native-progress:indeterminate::-webkit-progress-value {
  margin-right: auto;
  animation: media-pack-indeterminate var(--progress-bar-indeterminate-duration) infinite linear;
}
.media-native-progress:indeterminate::-moz-progress-bar {
  margin-right: auto;
  animation: media-pack-indeterminate var(--progress-bar-indeterminate-duration) infinite linear;
}
@keyframes media-pack-indeterminate {
  from, to {
    inline-size: var(--progress-bar-indeterminate-size);
  }
  from { translate: -100%; }
  to { translate: 100cqi; }
}
@media (prefers-reduced-motion: reduce) {
  .media-native-progress {
    --progress-bar-indeterminate-duration: 10s;
  }
}
.media-progress-meta {
  display: flex;
  justify-content: space-between;
  gap: var(--s-2);
  font-size: var(--fs-label-sm);
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}
.media-progress-speed {
  color: var(--text-primary);
}
.media-progress-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s-3);
  margin-top: var(--s-2);
}
.media-progress-actions button:disabled {
  color: var(--text-disabled);
  opacity: 1;
}
</style>

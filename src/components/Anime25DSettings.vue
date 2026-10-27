<script setup lang="ts">
import { ref } from 'vue'
import type { useAnime25DStage } from '@/composables/useAnime25DStage'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import Anime25DCalibration from './Anime25DCalibration.vue'

defineProps<{ runtime: ReturnType<typeof useAnime25DStage> }>()
const input = ref<HTMLInputElement>()
function pick(event: Event, runtime: ReturnType<typeof useAnime25DStage>) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  target.value = ''
  if (file) void runtime.importFile(file)
}
</script>

<template>
  <section class="anime25d-settings" aria-label="2.5D 桌宠">
    <strong>2.5D 桌宠</strong>
    <p>导入 See-through 或手工分层的 PSD，自动绑定眼睛、口型与头发。文件只保存在本机，按角色记忆。</p>
    <p>需 RGB、8 位 PSD，128 MB 以内，包含 face 图层。分层、闭眼和闭口差分会影响效果。</p>
    <input ref="input" type="file" accept=".psd" hidden aria-label="导入分层 PSD" @change="pick($event, runtime)" />
    <div class="anime25d-actions">
      <button type="button" class="btn btn-ghost" :disabled="runtime.busy.value" @click="input?.click()"><ArchiveIcon name="image" />{{ runtime.modelName.value ? '更换 PSD' : '导入 PSD' }}</button>
      <button v-if="runtime.busy.value" type="button" class="btn btn-ghost" @click="runtime.cancel">取消加载</button>
      <button v-if="runtime.modelName.value && !runtime.busy.value && !runtime.active.value" type="button" class="btn btn-ghost" @click="runtime.retry">加载 2.5D</button>
      <button v-if="runtime.selected.value" type="button" class="btn btn-ghost" @click="runtime.useOriginal">切回原立绘</button>
      <button v-if="runtime.modelName.value && !runtime.busy.value" type="button" class="btn btn-ghost" @click="runtime.remove">移除本机 PSD</button>
    </div>
    <span v-if="runtime.modelName.value" class="anime25d-filename">{{ runtime.modelName.value }}</span>
    <span v-if="runtime.status.value" role="status">{{ runtime.status.value }}</span>
    <p v-if="runtime.error.value" role="alert">{{ runtime.error.value }}</p>
    <details v-if="runtime.warnings.value.length"><summary>图层提示（{{ runtime.warnings.value.length }}）</summary><ul><li v-for="(warning, i) in runtime.warnings.value" :key="i">{{ warning }}</li></ul></details>
    <Anime25DCalibration v-if="runtime.active.value" :runtime="runtime" />
    <a href="https://852wa.github.io/Anime2.5DRig/" target="_blank" rel="noopener noreferrer">打开 Anime2.5DRig 在线工具</a>
  </section>
</template>

<style scoped>
.anime25d-settings { display: grid; gap: var(--s-2); padding-block: var(--s-3); color: var(--text-primary); font-size: var(--fs-label-sm); }
.anime25d-settings p { margin: 0; color: var(--text-secondary); line-height: var(--lh-body); }
.anime25d-actions { display: flex; flex-wrap: wrap; gap: var(--s-2); }
.anime25d-filename { overflow-wrap: anywhere; }
.anime25d-settings [role="alert"] { color: var(--danger); }
.anime25d-settings button:disabled { color: var(--text-disabled); }
.anime25d-settings a { color: var(--text-primary); text-decoration: underline; }
</style>

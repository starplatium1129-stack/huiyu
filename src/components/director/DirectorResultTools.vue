<template>
  <div class="result-image-actions">
    <span v-if="resultArchived !== null" class="stage-archive-badge" :data-archived="resultArchived">
      <ArchiveIcon :name="resultArchived ? 'success' : 'gallery'" />
      <span>{{ resultArchived ? '已入册' : resultTemporary ? '未入册 · 已暂存' : '未入册 · 请保存画面' }}</span>
    </span>
    <RouterLink v-if="resultArchived" class="btn btn-primary" to="/gallery">查看作品册</RouterLink>
    <button v-else class="btn btn-primary" type="button" :disabled="savingResult" @click="$emit('saveResult')">{{ savingResult ? '正在入册…' : '存入作品册' }}</button>
    <button class="btn btn-ghost" type="button" :disabled="generationBusy || capturingScene" @click="$emit('saveScene')">
      <ArchiveIcon name="gallery" />{{ capturingScene ? '正在读取成片…' : '保存为场景' }}
    </button>
    <button class="btn btn-ghost" type="button" :disabled="!hasPrevResult" @click="$emit('openCompare')">与上一张对比</button>
  </div>
</template>

<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { RouterLink } from 'vue-router'

defineProps<{
  generationBusy: boolean
  hasPrevResult: boolean
  resultArchived?: boolean | null
  capturingScene?: boolean
  savingResult?: boolean
  resultTemporary?: boolean
}>()
defineEmits<{
  saveScene: []
  saveResult: []
  openCompare: []
}>()
</script>

<template>
      <div class="result-image-actions">
        <!-- F2：入册状态如实标注——未入册的成片在临时缓冲里，离页/失败也能找回 -->
        <span v-if="resultArchived !== null" class="stage-archive-badge" :data-archived="resultArchived">
          {{ resultArchived ? '已入册' : resultTemporary ? '未入册 · 已暂存' : '未入册 · 请保存画面' }}
        </span>
        <RouterLink v-if="resultArchived" class="btn btn-primary" to="/gallery">查看作品册</RouterLink>
        <button v-else class="btn btn-primary" type="button" :disabled="savingResult" @click="$emit('saveResult')">{{ savingResult ? '正在入册…' : '存入作品册' }}</button>
        <button class="btn btn-ghost" type="button" :disabled="!hasPrevResult" @click="$emit('openCompare')">
          与上一张对比
        </button>
        <details class="result-tools-disclosure">
          <summary>修图与短片<span v-if="shotsPending"> · {{ shotsPending }} 个分镜</span></summary>
          <div class="result-tools-grid">
        <button
          class="btn btn-ghost"
          type="button"
          :disabled="interrogateBusy"
          :title="interrogateMode === 'caption' ? '提取当前画面的自然语言描述（适合 Krea）' : '提取当前画面的特征标签（适合 Anima/SD）'"
          @click="$emit('interrogateCurrent')">
          <ArchiveIcon name="search" />
          <span>{{ interrogateBusy ? '反推中…' : '反推当前图' }}</span>
        </button>
        <button
          class="btn btn-ghost"
          type="button"
          :disabled="interrogateBusy"
          title="上传任意图片本地反推"
          @click="$emit('interrogateUpload')">
          <ArchiveIcon name="search" />
          <span>上传反推</span>
        </button>
        <button
          v-if="inpaintOriginalUrl && displayResultUrl"
          class="btn btn-ghost btn-compare-inpaint"
          :class="{ active: inpaintCompareActive }"
          type="button"
          :title="inpaintCompareActive ? '退出前后对比模式' : '左右滑动对比换装前后效果'"
          @click="$emit('update:inpaintCompareActive', !inpaintCompareActive)"
        >
          <ArchiveIcon name="compare" />
          <span>{{ inpaintCompareActive ? '退出对比' : '换装前后对比' }}</span>
        </button>
        <button
          v-if="displayResultUrl && drawEngine === 'anima'"
          class="btn btn-ghost btn-inpaint-action"
          type="button"
          :disabled="generationBusy"
          :title="generationBusy ? BUSY_HINT : '锁定角色与背景，使用 AI 视觉语义识别一键更换服装'"
          @click="$emit('openInpaint')"
        >
          <ArchiveIcon name="wardrobe" />
          <span>局部换装</span>
        </button>
        <button
          v-if="displayResultUrl && (drawEngine === 'anima' || drawEngine === 'sd')"
          class="btn btn-ghost btn-hires-action"
          type="button"
          :disabled="generationBusy"
          :title="generationBusy ? BUSY_HINT : '使用 2x 高清超分放大'"
          @click="$emit('upscale')"
        >
          <ArchiveIcon name="spark" />
          <span>高清放大 2x</span>
        </button>
        <button
          v-if="displayResultUrl && (drawEngine === 'anima' || drawEngine === 'sd')"
          class="btn btn-ghost btn-video-action"
          type="button"
          :disabled="generationBusy"
          :title="generationBusy ? BUSY_HINT : '将当前成片作为首帧，前往故事短片生成动画（场景预设自动转视频提示词）'"
          @click="$emit('goVideo')"
        >
          <ArchiveIcon name="play" />
          <span>生成短片</span>
        </button>
        <button
          v-if="displayResultUrl && (drawEngine === 'anima' || drawEngine === 'sd')"
          class="btn btn-ghost btn-video-action"
          type="button"
          :disabled="generationBusy"
          :title="generationBusy ? BUSY_HINT : '把当前成片作为分镜首帧，攒齐后到「分镜短片」整批生成'"
          @click="$emit('addToShots')"
        >
          <ArchiveIcon name="gallery" />
          <span>加入分镜</span>
        </button>
        <button
          v-if="shotsPending > 0"
          class="btn btn-ghost btn-video-action"
          type="button"
          title="到视频页「分镜短片」，生成已加入的镜头"
          @click="$emit('goShots')"
        >
          <ArchiveIcon name="play" />
          <span>去分镜短片（{{ shotsPending }}）</span>
        </button>
        <button class="btn btn-ghost" type="button" title="从画布中移除当前成片（已保存的作品不受影响）" @click="$emit('clearResult')">清除画布画面</button>
          </div>
        </details>
      </div>
</template>
<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { RouterLink } from 'vue-router'
defineProps<{
  generationBusy: boolean
  interrogateBusy: boolean
  interrogateMode: 'caption' | 'tag'
  displayResultUrl: string
  drawEngine: string
  inpaintOriginalUrl: string | null
  inpaintCompareActive: boolean
  shotsPending: number
  hasPrevResult: boolean
  resultArchived?: boolean | null
  savingResult?: boolean
  resultTemporary?: boolean
}>()
const BUSY_HINT = '生成中，等这一张出完就能用'
defineEmits<{
  interrogateCurrent: []
  interrogateUpload: []
  openInpaint: []
  'update:inpaintCompareActive': [value: boolean]
  upscale: []
  goVideo: []
  addToShots: []
  goShots: []
  saveResult: []
  openCompare: []
  clearResult: []
}>()
</script>

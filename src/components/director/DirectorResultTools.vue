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
        <!-- 原生 title 换成 StudioTooltip：hover 与键盘聚焦都出提示，且跟随双主题令牌。
             可禁用（busy）的按钮加 anchor —— 禁用控件不派发指针事件，没有外壳托住 hover
             时提示根本不会出现。v-if 挂在 Tooltip 上（不能留在内层按钮上，否则条件为假
             时会留下空外壳，在 flex + gap 的网格里多吃一次间距）。 -->
        <StudioTooltip anchor :content="interrogateMode === 'caption' ? '提取当前画面的自然语言描述（适合 Krea）' : '提取当前画面的特征标签（适合 Anima/SD）'">
          <button
            class="btn btn-ghost"
            type="button"
            :disabled="interrogateBusy"
            @click="$emit('interrogateCurrent')">
            <ArchiveIcon name="search" />
            <span>{{ interrogateBusy ? '反推中…' : '反推当前图' }}</span>
          </button>
        </StudioTooltip>
        <StudioTooltip anchor content="上传任意图片本地反推">
          <button
            class="btn btn-ghost"
            type="button"
            :disabled="interrogateBusy"
            @click="$emit('interrogateUpload')">
            <ArchiveIcon name="search" />
            <span>上传反推</span>
          </button>
        </StudioTooltip>
        <StudioTooltip
          v-if="inpaintOriginalUrl && displayResultUrl"
          :content="inpaintCompareActive ? '退出前后对比模式' : '左右滑动对比换装前后效果'"
        >
          <button
            class="btn btn-ghost btn-compare-inpaint"
            :class="{ active: inpaintCompareActive }"
            type="button"
            @click="$emit('update:inpaintCompareActive', !inpaintCompareActive)"
          >
            <ArchiveIcon name="compare" />
            <span>{{ inpaintCompareActive ? '退出对比' : '换装前后对比' }}</span>
          </button>
        </StudioTooltip>
        <StudioTooltip
          v-if="displayResultUrl && drawEngine === 'anima'"
          anchor
          :content="generationBusy ? BUSY_HINT : '锁定角色与背景，使用 AI 视觉语义识别一键更换服装'"
        >
          <button
            class="btn btn-ghost btn-inpaint-action"
            type="button"
            :disabled="generationBusy"
            @click="$emit('openInpaint')"
          >
            <ArchiveIcon name="wardrobe" />
            <span>局部换装</span>
          </button>
        </StudioTooltip>
        <StudioTooltip
          v-if="displayResultUrl && (drawEngine === 'anima' || drawEngine === 'sd')"
          anchor
          :content="generationBusy ? BUSY_HINT : '使用 2x 高清超分放大'"
        >
          <button
            class="btn btn-ghost btn-hires-action"
            type="button"
            :disabled="generationBusy"
            @click="$emit('upscale')"
          >
            <ArchiveIcon name="spark" />
            <span>高清放大 2x</span>
          </button>
        </StudioTooltip>
        <StudioTooltip
          v-if="displayResultUrl && (drawEngine === 'anima' || drawEngine === 'sd')"
          anchor
          :content="generationBusy ? BUSY_HINT : '将当前成片作为首帧，前往故事短片生成动画（场景预设自动转视频提示词）'"
        >
          <button
            class="btn btn-ghost btn-video-action"
            type="button"
            :disabled="generationBusy"
            @click="$emit('goVideo')"
          >
            <ArchiveIcon name="play" />
            <span>生成短片</span>
          </button>
        </StudioTooltip>
        <StudioTooltip
          v-if="displayResultUrl && (drawEngine === 'anima' || drawEngine === 'sd')"
          anchor
          :content="generationBusy ? BUSY_HINT : '把当前成片作为分镜首帧，攒齐后到「分镜短片」整批生成'"
        >
          <button
            class="btn btn-ghost btn-video-action"
            type="button"
            :disabled="generationBusy"
            @click="$emit('addToShots')"
          >
            <ArchiveIcon name="gallery" />
            <span>加入分镜</span>
          </button>
        </StudioTooltip>
        <StudioTooltip v-if="shotsPending > 0" content="到视频页「分镜短片」，生成已加入的镜头">
          <button
            class="btn btn-ghost btn-video-action"
            type="button"
            @click="$emit('goShots')"
          >
            <ArchiveIcon name="play" />
            <span>去分镜短片（{{ shotsPending }}）</span>
          </button>
        </StudioTooltip>
        <StudioTooltip content="从画布中移除当前成片（已保存的作品不受影响）">
          <button class="btn btn-ghost" type="button" @click="$emit('clearResult')">清除画布画面</button>
        </StudioTooltip>
          </div>
        </details>
      </div>
</template>
<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
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

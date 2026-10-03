<template>
  <div class="image-tools" aria-label="修图与短片">
    <section class="image-tools-group" aria-label="修图">
      <h4>处理画面</h4>
      <div class="image-tool-buttons">
        <StudioTooltip v-if="displayResultUrl" anchor :content="(interrogateMode === 'caption' ? '用 PixAI 整理当前画面的标签（适合 Krea）' : '用 PixAI 提取当前画面的标签（适合 Anima/SD）') + '；首次需加载模型，后续复用 GPU 常驻模型'">
          <button class="btn btn-ghost" type="button" :disabled="interrogateBusy" @click="$emit('interrogateCurrent')">
            <ArchiveIcon name="search" /><span>{{ interrogateBusy ? '正在反推…' : '反推当前图' }}</span>
          </button>
        </StudioTooltip>
        <StudioTooltip anchor content="上传图片用 PixAI 本地反推；也可聚焦后直接粘贴图片，首次需加载模型">
          <button class="btn btn-ghost" type="button" :disabled="interrogateBusy" @click="$emit('interrogateUpload')" @paste="$emit('interrogatePaste', $event)">
            <ArchiveIcon name="search" /><span>上传反推</span>
          </button>
        </StudioTooltip>
        <StudioTooltip v-if="inpaintOriginalUrl && displayResultUrl" :content="inpaintCompareActive ? '退出前后对比模式' : '左右滑动对比换装前后效果'">
          <button class="btn btn-ghost btn-compare-inpaint" :class="{ active: inpaintCompareActive }" type="button" @click="$emit('update:inpaintCompareActive', !inpaintCompareActive)">
            <ArchiveIcon name="compare" /><span>{{ inpaintCompareActive ? '退出对比' : '换装前后对比' }}</span>
          </button>
        </StudioTooltip>
        <StudioTooltip v-if="drawEngine === 'anima'" anchor :content="generationBusy ? BUSY_HINT : displayResultUrl ? '锁定角色与背景，使用 AI 视觉语义识别一键更换服装' : '导入本地图片，进行智能语义识别与局部换装'">
          <button class="btn btn-ghost btn-inpaint-action" type="button" :disabled="generationBusy" @click="$emit('openInpaint')">
            <ArchiveIcon name="wardrobe" /><span>{{ displayResultUrl ? '局部换装' : '导入图片换装' }}</span>
          </button>
        </StudioTooltip>
        <StudioTooltip v-if="displayResultUrl && (drawEngine === 'anima' || drawEngine === 'sd')" anchor :content="generationBusy ? BUSY_HINT : '使用 2x 高清超分放大'">
          <button class="btn btn-ghost btn-hires-action" type="button" :disabled="generationBusy" @click="$emit('upscale')">
            <ArchiveIcon name="spark" /><span>高清放大 2x</span>
          </button>
        </StudioTooltip>
      </div>
      <p v-if="interrogateError" class="image-tools-error" role="alert">{{ interrogateError }}</p>
    </section>
    <section v-if="(displayResultUrl && (drawEngine === 'anima' || drawEngine === 'sd')) || shotsPending > 0" class="image-tools-group" aria-label="短片">
      <h4>延续创作<span v-if="shotsPending" class="image-tools-count">{{ shotsPending }} 个分镜</span></h4>
      <div class="image-tool-buttons">
        <StudioTooltip v-if="displayResultUrl && (drawEngine === 'anima' || drawEngine === 'sd')" anchor :content="generationBusy ? BUSY_HINT : '将当前成片作为首帧，前往故事短片生成动画'">
          <button class="btn btn-ghost btn-video-action" type="button" :disabled="generationBusy" @click="$emit('goVideo')">
            <ArchiveIcon name="play" /><span>生成短片</span>
          </button>
        </StudioTooltip>
        <StudioTooltip v-if="displayResultUrl && (drawEngine === 'anima' || drawEngine === 'sd')" anchor :content="generationBusy ? BUSY_HINT : '把当前成片作为分镜首帧，攒齐后整批生成短片'">
          <button class="btn btn-ghost btn-video-action" type="button" :disabled="generationBusy" @click="$emit('addToShots')">
            <ArchiveIcon name="gallery" /><span>加入分镜</span>
          </button>
        </StudioTooltip>
        <StudioTooltip v-if="shotsPending > 0" content="到视频页「分镜短片」，生成已加入的镜头">
          <button class="btn btn-ghost btn-video-action" type="button" @click="$emit('goShots')">
            <ArchiveIcon name="play" /><span>去分镜短片（{{ shotsPending }}）</span>
          </button>
        </StudioTooltip>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import '@/assets/css/director/components/DirectorImageTools.css'

defineProps<{
  generationBusy: boolean
  interrogateBusy: boolean
  interrogateMode: 'caption' | 'tag'
  interrogateError: string | null
  displayResultUrl: string
  drawEngine: string
  inpaintOriginalUrl: string | null
  inpaintCompareActive: boolean
  shotsPending: number
}>()
const BUSY_HINT = '生成中，等这一张出完就能用'
defineEmits<{
  interrogateCurrent: []
  interrogateUpload: []
  interrogatePaste: [event: ClipboardEvent]
  openInpaint: []
  'update:inpaintCompareActive': [value: boolean]
  upscale: []
  goVideo: []
  addToShots: []
  goShots: []
}>()
</script>

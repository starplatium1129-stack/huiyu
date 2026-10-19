<template>
  <div class="image-tools" aria-label="参考图与延续创作">
    <section class="image-tools-group" aria-label="参考图">
      <h4><ArchiveIcon name="image" />参考图</h4>
      <details class="reference-interrogate inspector-route" @toggle="onReferenceToggle">
        <StudioDisclosureSummary data-spring-button><span data-press-content><ArchiveIcon name="search" />图片反推</span><small>{{ interrogateMode === 'caption' ? '画面描述' : '图片词条' }}</small></StudioDisclosureSummary>
        <div data-disclosure-content class="reference-interrogate-body">
          <p v-if="interrogateBusy || !readiness.available.value" class="reference-interrogate-status" role="status">{{ interrogateBusy ? '正在反推…' : readiness.status.value.message }}</p>
          <div class="image-tool-buttons">
            <StudioTooltip anchor content="上传图片并提取词条">
              <button class="btn btn-ghost" type="button" :disabled="interrogateBusy || !readiness.available.value" @click="$emit('interrogateUpload')">
                <ArchiveIcon name="upload" /><span>上传反推</span>
              </button>
            </StudioTooltip>
            <StudioTooltip v-if="displayResultUrl" anchor content="提取当前画布的参考词条，保留手写画面描述">
              <button class="btn btn-ghost" type="button" :disabled="interrogateBusy || !readiness.available.value" @click="$emit('interrogateCurrent')">
                <ArchiveIcon name="image" /><span>反推当前图</span>
              </button>
            </StudioTooltip>
            <StudioTooltip anchor content="点击读取剪贴板图片并反推，也可按 Ctrl+V 粘贴">
              <button class="btn btn-ghost" type="button" :disabled="interrogateBusy || !readiness.available.value" @click="$emit('interrogateClipboard')" @paste="readiness.available.value && $emit('interrogatePaste', $event)">
                <ArchiveIcon name="copy" /><span>粘贴反推</span>
              </button>
            </StudioTooltip>
            <button v-if="interrogateBusy" class="btn btn-ghost" type="button" @click="$emit('interrogateCancel')"><ArchiveIcon name="close" />取消反推</button>
          </div>
          <button class="btn btn-quiet btn-sm reference-interrogate-refresh" type="button" :disabled="interrogateBusy"
            :aria-disabled="readiness.checking.value || undefined" :aria-busy="readiness.checking.value"
            @click="!readiness.checking.value && readiness.refresh()">重新检查</button>
        </div>
      </details>
      <div class="image-tool-buttons reference-outfit-actions">
        <StudioTooltip v-if="drawEngine === 'anima'" anchor :content="generationBusy ? BUSY_HINT : displayResultUrl ? '锁定角色与背景，也可导入图片进行智能局部换装' : '导入本地图片，进行智能语义识别与局部换装'">
          <button class="btn btn-ghost" type="button" :disabled="generationBusy" @click="$emit('openInpaint')">
            <ArchiveIcon name="wardrobe" /><span>{{ displayResultUrl ? '局部换装' : '导入图片换装' }}</span>
          </button>
        </StudioTooltip>
        <StudioTooltip v-if="inpaintOriginalUrl && displayResultUrl" :content="inpaintCompareActive ? '退出前后对比模式' : '左右滑动对比换装前后效果'">
          <button class="btn btn-ghost btn-compare-inpaint" :aria-pressed="inpaintCompareActive" type="button" @click="$emit('update:inpaintCompareActive', !inpaintCompareActive)">
            <ArchiveIcon name="compare" /><span>{{ inpaintCompareActive ? '退出对比' : '换装前后对比' }}</span>
          </button>
        </StudioTooltip>
      </div>
      <p v-if="interrogateError" class="image-tools-error" role="alert">{{ interrogateError }}</p>
    </section>
    <section v-if="drawEngine === 'anima'" class="image-tools-group" aria-label="构图控制">
      <DeferredToolLauncher label="构图控制" icon="rule3" :loader="loadComposition" :disabled="generationBusy">
        <template #default="{ component, open, update }"><component :is="component" :bindings="composition" :open="open" @update:open="update" /></template>
      </DeferredToolLauncher>
    </section>
    <details v-if="displayResultUrl || shotsPending > 0" class="inspector-route image-continuation">
      <StudioDisclosureSummary data-spring-button><span data-press-content>成片再创作</span><small v-if="shotsPending">{{ shotsPending }} 个分镜</small></StudioDisclosureSummary>
      <div data-disclosure-content class="image-tool-buttons image-continuation-body">
        <MangaScreenLauncher v-if="displayResultUrl" :source-url="displayResultUrl" :disabled="generationBusy" />
        <StudioTooltip v-if="displayResultUrl && (drawEngine === 'anima' || drawEngine === 'sd')" anchor :content="generationBusy ? BUSY_HINT : '使用 2x 高清超分放大'">
          <button class="btn btn-ghost" type="button" :disabled="generationBusy" @click="$emit('upscale')"><ArchiveIcon name="spark" /><span>高清放大 2x</span></button>
        </StudioTooltip>
        <StudioTooltip v-if="displayResultUrl && (drawEngine === 'anima' || drawEngine === 'sd')" anchor :content="generationBusy ? BUSY_HINT : '将当前成片作为首帧，前往故事短片生成动画'">
          <button class="btn btn-ghost" type="button" :disabled="generationBusy || transferBusy" :aria-busy="transferBusy" @click="$emit('goVideo')"><ArchiveIcon name="play" /><span>生成短片</span></button>
        </StudioTooltip>
        <StudioTooltip v-if="displayResultUrl && (drawEngine === 'anima' || drawEngine === 'sd')" anchor :content="generationBusy ? BUSY_HINT : '把当前成片作为分镜首帧，攒齐后整批生成短片'">
          <button class="btn btn-ghost" type="button" :disabled="generationBusy || transferBusy" :aria-busy="transferBusy" @click="$emit('addToShots')"><ArchiveIcon name="gallery" /><span>加入分镜</span></button>
        </StudioTooltip>
        <StudioTooltip v-if="shotsPending > 0" content="到视频页「分镜短片」，生成已加入的镜头">
          <button class="btn btn-ghost" type="button" :disabled="transferBusy" @click="$emit('goShots')"><ArchiveIcon name="play" /><span>去分镜短片（{{ shotsPending }}）</span></button>
        </StudioTooltip>
      </div>
    </details>
  </div>
</template>

<script setup lang="ts">
import { useInterrogateReadiness } from '@/composables/useInterrogateReadiness'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import MangaScreenLauncher from '@/components/manga/MangaScreenLauncher.vue'
import DeferredToolLauncher from '@/components/director/DeferredToolLauncher.vue'
import type { AnimaCompositionBindings } from '@/composables/generation/useAnimaComposition'
import '@/assets/css/director/components/DirectorImageTools.css'

defineProps<{
  composition: AnimaCompositionBindings
  generationBusy: boolean
  interrogateBusy: boolean
  interrogateMode: 'caption' | 'tag'
  interrogateError: string | null
  displayResultUrl: string
  drawEngine: string
  inpaintOriginalUrl: string | null
  inpaintCompareActive: boolean
  shotsPending: number
  transferBusy: boolean
}>()
const readiness = useInterrogateReadiness()
const loadComposition = () => import('@/components/AnimaCompositionLauncher.vue')
function onReferenceToggle(event: Event) {
  if ((event.currentTarget as HTMLDetailsElement).open) void readiness.refresh()
}
const BUSY_HINT = '生成中，等这一张出完就能用'
defineEmits<{
  interrogateCurrent: []
  interrogateUpload: []
  interrogateClipboard: []
  interrogatePaste: [event: ClipboardEvent]
  interrogateCancel: []
  openInpaint: []
  'update:inpaintCompareActive': [value: boolean]
  upscale: []
  goVideo: []
  addToShots: []
  goShots: []
}>()
</script>

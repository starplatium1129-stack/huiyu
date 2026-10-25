<template>
  <div class="image-tools" aria-label="参考图与图像编辑">
    <section class="image-tools-section" aria-labelledby="image-reference-heading">
      <h4 id="image-reference-heading">参考与构图</h4>
      <div class="image-tool-list">
        <details class="reference-interrogate" @toggle="onReferenceToggle">
          <StudioDisclosureSummary class="image-tool-action"><ArchiveIcon name="search" /><span>图片反推</span><small>{{ interrogateMode === 'caption' ? '描述' : '词条' }}</small></StudioDisclosureSummary>
          <div data-disclosure-content class="reference-interrogate-body">
            <div class="image-tool-subactions">
              <StudioTooltip anchor content="上传图片，提取画面词条或描述"><button class="btn btn-ghost btn-sm" type="button" :disabled="interrogateBusy || !readiness.available.value" @click="$emit('interrogateUpload')"><ArchiveIcon name="upload" />上传图片</button></StudioTooltip>
              <StudioTooltip anchor content="读取剪贴板图片，也可按 Ctrl+V 粘贴"><button class="btn btn-ghost btn-sm" type="button" :disabled="interrogateBusy || !readiness.available.value" @click="$emit('interrogateClipboard')" @paste="readiness.available.value && $emit('interrogatePaste', $event)"><ArchiveIcon name="copy" />粘贴图片</button></StudioTooltip>
              <StudioTooltip v-if="displayResultUrl" anchor content="提取当前画布的参考词条，保留手写画面描述"><button class="btn btn-ghost btn-sm" type="button" :disabled="interrogateBusy || !readiness.available.value" @click="$emit('interrogateCurrent')"><ArchiveIcon name="image" />使用当前图</button></StudioTooltip>
              <button v-if="interrogateBusy" class="btn btn-ghost btn-sm" type="button" @click="$emit('interrogateCancel')"><ArchiveIcon name="close" />停止反推</button>
            </div>
            <p v-if="interrogateBusy || !readiness.available.value" class="image-tool-status" role="status">{{ interrogateBusy ? '正在反推…' : readiness.status.value.message }}</p>
            <button class="btn btn-quiet btn-sm" type="button" :disabled="interrogateBusy" :aria-disabled="readiness.checking.value || undefined" :aria-busy="readiness.checking.value" @click="!readiness.checking.value && readiness.refresh()">重新检查</button>
          </div>
        </details>
        <DeferredToolLauncher v-if="drawEngine === 'anima'" class="image-tool-entry" row label="构图控制" icon="rule3" :loader="loadComposition" :disabled="generationBusy">
          <template #default="{ component, open, update }"><component :is="component" :bindings="composition" :open="open" @update:open="update" /></template>
        </DeferredToolLauncher>
      </div>
      <p v-if="interrogateError" class="image-tools-error" role="alert">{{ interrogateError }}</p>
    </section>

    <section class="image-tools-section" aria-labelledby="image-edit-heading">
      <h4 id="image-edit-heading">编辑与处理</h4>
      <div class="image-tool-list">
        <StudioTooltip anchor :content="displayResultUrl ? '在独立窗口中按指令编辑当前画布' : '导入图片，在独立窗口中按指令编辑'">
          <button class="btn btn-quiet image-tool-action" type="button" :disabled="generationBusy || drawing.importing.value || drawing.openingEditor.value" :aria-busy="drawing.importing.value || drawing.openingEditor.value" @click="drawing.editImage(displayResultUrl)"><ArchiveIcon name="inpaint" /><span>{{ drawing.openingEditor.value ? '打开中…' : drawing.importing.value ? '读取画布中…' : 'Qwen 编辑' }}</span><ArchiveIcon name="chevron-down" class="image-tool-chevron" /></button>
        </StudioTooltip>
        <StudioTooltip v-if="drawEngine === 'anima'" anchor :content="generationBusy ? BUSY_HINT : displayResultUrl ? '锁定角色与背景，对当前画布局部换装' : '导入图片，进行智能局部换装'">
          <button class="btn btn-quiet image-tool-action" type="button" :disabled="generationBusy" @click="$emit('openInpaint')"><ArchiveIcon name="wardrobe" /><span>局部换装</span><small v-if="!displayResultUrl">导入图片</small><ArchiveIcon name="chevron-down" class="image-tool-chevron" /></button>
        </StudioTooltip>
        <StudioTooltip v-if="inpaintOriginalUrl && displayResultUrl" anchor content="左右滑动，对比换装前后的画面">
          <button class="btn btn-quiet image-tool-action" type="button" :aria-pressed="inpaintCompareActive" @click="$emit('update:inpaintCompareActive', !inpaintCompareActive)"><ArchiveIcon name="compare" /><span>换装前后对比</span><small v-if="inpaintCompareActive">对比中</small><ArchiveIcon name="chevron-down" class="image-tool-chevron" /></button>
        </StudioTooltip>
        <MangaScreenLauncher class="image-tool-entry" variant="row" :source-url="displayResultUrl" :disabled="generationBusy || drawing.importing.value" />
        <StudioTooltip v-if="displayResultUrl && supportsContinuation" anchor :content="generationBusy ? BUSY_HINT : '将当前画布进行 2x 高清超分放大'">
          <button class="btn btn-quiet image-tool-action" type="button" :disabled="generationBusy" @click="$emit('upscale')"><ArchiveIcon name="spark" /><span>高清放大</span><small>2×</small><ArchiveIcon name="chevron-down" class="image-tool-chevron" /></button>
        </StudioTooltip>
      </div>
      <p v-if="drawing.error.value" class="image-tools-error" role="alert">{{ drawing.error.value }}</p>
    </section>

    <section v-if="displayResultUrl && supportsContinuation || shotsPending > 0" class="image-tools-section" aria-labelledby="image-continuation-heading">
      <h4 id="image-continuation-heading">延续创作</h4>
      <div class="image-tool-list">
        <button v-if="displayResultUrl && supportsContinuation" class="btn btn-quiet image-tool-action" type="button" :disabled="generationBusy || transferBusy" :aria-busy="transferBusy" @click="$emit('goVideo')"><ArchiveIcon name="play" /><span>生成短片</span><ArchiveIcon name="chevron-down" class="image-tool-chevron" /></button>
        <button v-if="displayResultUrl && supportsContinuation" class="btn btn-quiet image-tool-action" type="button" :disabled="generationBusy || transferBusy" :aria-busy="transferBusy" @click="$emit('addToShots')"><ArchiveIcon name="gallery" /><span>加入分镜</span><ArchiveIcon name="chevron-down" class="image-tool-chevron" /></button>
        <button v-if="shotsPending > 0" class="btn btn-quiet image-tool-action" type="button" :disabled="transferBusy" @click="$emit('goShots')"><ArchiveIcon name="play" /><span>查看分镜短片</span><small>{{ shotsPending }} 个分镜</small><ArchiveIcon name="chevron-down" class="image-tool-chevron" /></button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useInterrogateReadiness } from '@/composables/useInterrogateReadiness'
import { useDrawingNavigation } from '@/composables/prompt/useDrawingNavigation'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import MangaScreenLauncher from '@/components/manga/MangaScreenLauncher.vue'
import DeferredToolLauncher from '@/components/director/DeferredToolLauncher.vue'
import type { AnimaCompositionBindings } from '@/composables/generation/useAnimaComposition'
import '@/assets/css/director/components/DirectorImageTools.css'

const props = defineProps<{
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
const drawing = useDrawingNavigation()
const supportsContinuation = computed(() => props.drawEngine === 'anima' || props.drawEngine === 'sd')
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

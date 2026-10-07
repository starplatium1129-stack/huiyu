<template>
  <!-- stage-slot：col-center 的画布槽位锚点（layout.css 以它固定中栏排序首位） -->
  <div class="stage-slot">
    <Transition name="stage-beam">
      <BorderBeam v-if="generationBusy || waitingForResult" class="canvas-generation-beam"
        :duration="8.8" :border-width="1.1" color-variant="dual" :glow="true" border-radius="var(--r-xl)" />
    </Transition>
    <div ref="canvasViewport" class="stage-viewport" data-route-arrive>
    <!-- 图片显现只由新生成结果驱动，画布与工具保持静止。 -->
    <Transition name="stage-swap">
      <section
        v-if="!displayResultUrl || generationBusy || waitingForResult || failedResultUrl === displayResultUrl"
        class="stage-placeholder"
      :class="{
        'is-generating': generationBusy || waitingForResult,
        'is-awaiting-result': waitingForResult,
        'is-error': !!generationError || Boolean(displayResultUrl && failedResultUrl === displayResultUrl),
        'is-paused': generationStopped,
      }"
      aria-label="成片监看区"
    >
      <div class="stage-message">
        <div class="stage-content" :class="{ 'is-covered': coveringResult }">
        <DirectorSceneReference v-if="!generationBusy && !waitingForResult" :size="canvasSize" />
          <div v-if="generationBusy || waitingForResult" class="stage-generating-copy">
            <div class="stage-generation-orbit">
              <GenerationParticles v-if="!coveringResult && !textureMotionActive" :progress="generationProgress" :palette="generationPalette" />
            </div>
          </div>
        <div v-else-if="generationError || (displayResultUrl && failedResultUrl === displayResultUrl)" class="stage-idle" role="alert">
          <div class="stage-placeholder-title">这次画面未能生成</div>
          <button class="btn btn-ghost" type="button" @click="$emit('openRecovery')">查看恢复选项</button>
          <div class="stage-placeholder-copy">
            查看错误原因，调整后再试一次。
            <span v-if="generationError" class="stage-error-detail">（{{ generationError }}）</span>
          </div>
          <div class="stage-quick-actions">
            <button class="btn btn-primary" type="button" @click="$emit('generate')">重新生成</button>
            <!-- F2：本次失败不毁掉上一张未入册成片——它还在暂存里，一键找回 -->
            <button v-if="hasStashedResult" class="btn btn-ghost" type="button" @click="$emit('restoreStashed')">
              找回上一张未入册成片
            </button>
          </div>
        </div>
        <div v-else-if="generationStopped" class="stage-idle">
          <div class="stage-placeholder-title">这一幕已暂停</div>
          <div class="stage-placeholder-copy">
            停歇片刻。随时准备好，随时继续。
          </div>
          <div class="stage-quick-actions">
            <button class="btn btn-primary" type="button" @click="$emit('generate')">重新开始生成</button>
            <button v-if="hasStashedResult" class="btn btn-ghost" type="button" @click="$emit('restoreStashed')">
              找回上一张未入册成片
            </button>
          </div>
        </div>
        <div v-else class="stage-idle stage-idle-guide">
          <AtelierEmptyArt class="atelier-canvas-illustration" />
          <div class="stage-placeholder-title">想把哪一刻，留在画里？</div>
          <div class="stage-placeholder-copy">
            挑一幕心动场景，或写下你的构想。静待画面绽放，留存这一帧温柔。
          </div>
          <div class="stage-quick-actions">
            <button class="btn btn-primary" type="button" @click="$emit('exploreScenes')"><ArchiveIcon name="scene" /> 挑选场景</button>
          </div>
        </div>
        </div>
      </div>
    </section>
    </Transition>

    <!-- Keep readable task feedback above the texture canvas's own stacking layer. -->
    <div v-if="generationBusy || waitingForResult" class="stage-generation-feedback">
      <div class="stage-progress-ring" :class="{ 'is-indeterminate': generationProgress === null }" role="progressbar" aria-label="生图进度" :aria-valuenow="generationProgress === null ? undefined : Math.round(generationProgress * 100)" :aria-valuetext="generationStatusText || undefined" :aria-valuemin="0" :aria-valuemax="100">
        <svg viewBox="0 0 56 56" aria-hidden="true">
          <circle class="stage-progress-track" cx="28" cy="28" r="24" />
          <circle class="stage-progress-value" cx="28" cy="28" r="24" pathLength="100" :stroke-dasharray="`${generationProgress === null ? 24 : generationProgress * 100} 100`" />
        </svg>
        <strong v-if="generationProgress !== null">{{ Math.round(generationProgress * 100) }}%</strong>
        <ArchiveIcon v-else name="spark" />
      </div>
      <div class="stage-generating-sub">
        <span class="stage-generating-title" role="status">{{ waitingForResult ? '显现中' : '绘制中' }}</span>
        <span v-if="drawEngine !== 'sd' && animaElapsed > 0" class="stage-generating-elapsed">已用时 {{ animaElapsed }} 秒</span>
      </div>
    </div>

    <!-- Result image -->
    <div v-if="displayResultUrl" class="result-image-wrap archive-canvas">
      <div class="result-artwork" :style="{ '--result-aspect': resultAspect }">
        <ImageSplitCompare
          v-if="inpaintCompareActive && inpaintOriginalUrl"
          :before-src="inpaintOriginalUrl"
          :after-src="displayResultUrl"
          before-label="换装前原图"
          after-label="换装后成片"
        />
        <CgImageReveal
          v-else
          class="result-image-reveal"
          img-class="result-image"
          :src="resolveRuntimeUrl(displayResultUrl)"
          :auto-reveal="loadedResultUrl === displayResultUrl && displayResultUrl === resultRevealUrl && !revealedResults.has(displayResultUrl)"
          :reveal-effect="revealTextureResult"
          alt="当前生成的画面成片"
          @load="fitResult"
          @reveal-start="rememberResultReveal"
          @reveal-complete="onResultReveal"
          @error="onResultImageError"
        />
      </div>
    </div>
    </div>
    <DirectorResultTools
      v-bind="{ generationBusy, hasPrevResult, resultArchived, savingResult, resultTemporary, capturingScene }"
      :has-result="Boolean(displayResultUrl)"
      @saveScene="$emit('saveScene')" @saveResult="$emit('saveResult')" @openCompare="$emit('openCompare')"
    />
    <!-- 供两态共用的上传入口 -->
    <input ref="interrogateInputRef" class="sr-only" type="file" accept="image/*" @change="onInterrogateFile" />
  </div>
</template>

<script setup lang="ts">
import { resolveRuntimeUrl } from '@/platform/runtimeUrl'

import { computed, nextTick, ref, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import AtelierEmptyArt from '@/components/visual/AtelierEmptyArt.vue'
import ImageSplitCompare from '@/components/visual/ImageSplitCompare.vue'
import CgImageReveal from '@/components/visual/CgImageReveal.vue'
import GenerationParticles from '@/components/visual/GenerationParticles.vue'
import BorderBeam from '@/components/visual/BorderBeam.vue'
import DirectorSceneReference from './DirectorSceneReference.vue'
import DirectorResultTools from './DirectorResultTools.vue'
import { useCanvasGenerationMotion } from '@/composables/useCanvasGenerationMotion'
import { useCanvasClearMotion } from '@/composables/useCanvasClearMotion'
import { sampleGenerationPalette } from '@/utils/generationPalette'
import { useInterrogate } from '@/composables/useInterrogate'
import type { InterrogateResult } from '@/composables/useInterrogate'
import '@/assets/css/director/components/DirectorStagePanel.css'

const props = defineProps<{
  displayResultUrl: string
  resultRevealUrl?: string
  canvasSize?: string
  generationBusy: boolean
  generationError: string | null
  generationStopped: boolean
  generationStatusText: string | null
  generationProgress: number | null
  animaElapsed: number
  drawEngine: string
  inpaintOriginalUrl: string | null
  inpaintCompareActive: boolean
  hasPrevResult: boolean
  /** 当前结果是否已入册（null = 画布无结果，不显示徽章）。 */
  resultArchived?: boolean | null
  capturingScene?: boolean
  savingResult?: boolean
  resultTemporary?: boolean
  /** Anima/Krea 暂存里还有上一张未入册成片（失败/取消后可找回）。 */
  hasStashedResult?: boolean
}>()

const canvasViewport = ref<HTMLElement | null>(null)
const resultPalette = ref<string[]>([])
const generationPalette = ref<string[]>([])
// Capture before publication/clearing; the new image's load must not recolor an ongoing wait.
watch(() => props.generationBusy, busy => { if (busy) generationPalette.value = [...resultPalette.value] }, { flush: 'sync' })
const { active: textureMotionActive, reveal: revealTextureResult, stop: stopTextureMotion } = useCanvasGenerationMotion(canvasViewport, () => props.displayResultUrl, () => props.generationBusy, () => props.inpaintCompareActive, () => props.generationProgress, () => generationPalette.value)
const { playClear, coveringResult, stop: stopClearMotion } = useCanvasClearMotion(canvasViewport, () => props.displayResultUrl, () => props.generationBusy, () => props.inpaintCompareActive)

// A deliberate clear followed by Generate must not leave two GPU effects alive.
watch(() => props.generationBusy, busy => { if (busy) stopClearMotion() }, { flush: 'sync' })

const resultAspect = ref(1)
const loadedResultUrl = ref('')
const failedResultUrl = ref('')
watch(() => props.displayResultUrl, () => {
  const [width, height] = (props.canvasSize || '').split('x').map(Number)
  resultAspect.value = width > 0 && height > 0 ? width / height : 1
  loadedResultUrl.value = ''
  failedResultUrl.value = ''
}, { immediate: true })
async function fitResult(event: Event) {
  const image = event.target as HTMLImageElement
  const source = props.displayResultUrl
  resultAspect.value = image.naturalWidth / image.naturalHeight
  resultPalette.value = sampleGenerationPalette(image)
  // Settle the canvas ratio before the decoded work receives its reveal.
  await nextTick()
  if (source === props.displayResultUrl) loadedResultUrl.value = source
}

// Keep reveal history local and bounded. Returning from compare/history must not replay it.
const revealedResults = ref(new Set<string>())
const waitingForResult = computed(() => Boolean(props.displayResultUrl && props.displayResultUrl === props.resultRevealUrl
  && !props.inpaintCompareActive && !revealedResults.value.has(props.displayResultUrl) && failedResultUrl.value !== props.displayResultUrl))
function onResultImageError() { failedResultUrl.value = props.displayResultUrl; stopTextureMotion() }
function onResultReveal() { stopTextureMotion(); rememberResultReveal() }
function rememberResultReveal() {
  const source = props.displayResultUrl
  if (!source || revealedResults.value.has(source)) return
  revealedResults.value.add(source)
  if (revealedResults.value.size > 32) {
    const oldest = revealedResults.value.values().next().value
    if (oldest !== undefined) revealedResults.value.delete(oldest)
  }
}

// Do not postpone a completion animation until the user leaves history/comparison.
watch(() => [props.displayResultUrl, props.resultRevealUrl, props.inpaintCompareActive, props.generationBusy], () => {
  if (!props.generationBusy && props.displayResultUrl && props.displayResultUrl !== props.resultRevealUrl) stopTextureMotion()
  if (props.inpaintCompareActive && props.displayResultUrl === props.resultRevealUrl) rememberResultReveal()
}, { immediate: true })

const emit = defineEmits<{
  generate: []
  openRecovery: []
  exploreScenes: []
  saveScene: []
  saveResult: []
  openCompare: []
  restoreStashed: []
  interrogateResult: [result: InterrogateResult]
  interrogateError: [message: string]
}>()

const interrogateInputRef = ref<HTMLInputElement | null>(null)
const { busy: interrogateBusy, error: interrogateErrorRaw, interrogate, cancel } = useInterrogate()
const interrogateError = computed(() => interrogateErrorRaw.value)
const interrogateMode = computed(() => props.drawEngine === 'krea2' ? 'caption' as const : 'tag' as const)
let readingCurrentResult: symbol | null = null
watch(interrogateMode, () => cancel(), { flush: 'sync' })
watch(() => props.displayResultUrl, () => { if (readingCurrentResult) cancel() }, { flush: 'sync' })

function triggerInterrogatePick() {
  interrogateInputRef.value?.click()
}

async function onInterrogateFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files && input.files[0]
  // 清空以便同文件可二次触发
  input.value = ''
  if (file) await runInterrogateFile(file)
}

/** 保留按钮上的 Ctrl+V 入口，与点击读取共用反推路径。 */
function onInterrogatePaste(e: ClipboardEvent) {
  const image = Array.from(e.clipboardData?.files ?? []).find(f => f.type.startsWith('image/'))
  if (!image) return
  e.preventDefault()
  void runInterrogateFile(image)
}

async function interrogateClipboardImage() {
  await runInterrogateFile(async () => {
    if (!navigator.clipboard?.read) throw new Error('当前环境无法点击读取剪贴板，请上传图片或在此按钮按 Ctrl+V 粘贴')
    try {
      const items = await navigator.clipboard.read()
      for (const item of items) {
        const type = item.types.find(type => type.startsWith('image/'))
        if (!type) continue
        const blob = await item.getType(type)
        return new File([blob], 'clipboard-image', { type: blob.type || type })
      }
      throw new Error('剪贴板中没有图片，请先复制图片再点击粘贴反推')
    } catch (error) {
      if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) {
        throw new Error('未获准读取剪贴板，请允许剪贴板访问后重试，或上传图片')
      }
      throw error
    }
  })
}

/** 文件选择、粘贴事件与点击剪贴板共用同一请求及取消机制。 */
async function runInterrogateFile(file: File | (() => Promise<File>)) {
  try {
    const result = await interrogate(file, interrogateMode.value)
    if (result) emit('interrogateResult', result)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    emit('interrogateError', msg)
    console.warn('[interrogate]', msg)
  }
}

async function interrogateCurrentImage() {
  if (!props.displayResultUrl) {
    triggerInterrogatePick()
    return
  }
  if (interrogateBusy.value) return
  const request = Symbol()
  readingCurrentResult = request
  try {
    const result = await interrogate(props.displayResultUrl, interrogateMode.value)
    if (result) emit('interrogateResult', result)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    emit('interrogateError', msg)
    console.warn('[interrogate]', msg)
  } finally {
    if (readingCurrentResult === request) readingCurrentResult = null
  }
}
defineExpose({ playClear, resultAspect, interrogateBusy, interrogateError, cancelInterrogate: cancel, interrogateCurrentImage, interrogateClipboardImage, triggerInterrogatePick, onInterrogatePaste })
</script>

<style scoped>
@reference "../../assets/css/tailwind.css";
/* F2：入册状态徽章（设计令牌，深色模式对比度由令牌保证） */
.stage-archive-badge {
  @apply tw:self-center;
  padding: 3px var(--s-2);
  @apply tw:rounded-pill;
  font: 700 var(--fs-mono-xs) var(--font-mono);
}
.stage-archive-badge[data-archived="true"] {
  background: color-mix(in srgb, var(--success) 14%, transparent);
  @apply tw:text-success-text;
}
.stage-archive-badge[data-archived="false"] {
  background: color-mix(in srgb, var(--warning) 12%, transparent);
  @apply tw:text-warning-text;
}
</style>

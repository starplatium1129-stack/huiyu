<template>
  <!-- stage-slot：col-center 的画布槽位锚点（layout.css 以它固定中栏排序首位） -->
  <div ref="stageRoot" class="stage-slot">
    <!-- 图片显现只由新生成结果驱动，画布与工具保持静止。 -->
    <Transition name="stage-swap">
      <section
        v-if="!displayResultUrl"
        class="stage-placeholder"
      :class="{
        'is-generating': generationBusy,
        'is-error': !!generationError,
        'is-paused': generationStopped,
      }"
      aria-label="成片监看区"
    >
      <div class="stage-message">
        <div class="stage-content">
        <DirectorSceneReference :size="canvasSize" />
          <div v-if="generationBusy" class="stage-generating-copy">
            <ThinkingOrb state="working" size="lg" color-variant="dual" aria-hidden="true" />
            <div class="stage-generation-feedback">
              <div class="stage-generating-title" role="status">正在绘制这一幕</div>
              <div class="stage-generating-sub">
                <span>{{ generationStatusText || '正在准备画面…' }}</span>
                <strong v-if="generationProgress !== null">{{ Math.round(generationProgress * 100) }}%</strong>
              </div>
              <div class="stage-progress-ring" :class="{ 'is-indeterminate': generationProgress === null }" role="progressbar" aria-label="生图进度" :aria-valuenow="generationProgress === null ? undefined : Math.round(generationProgress * 100)" :aria-valuemin="0" :aria-valuemax="100">
                <i :style="{ '--progress': (generationProgress ?? 0) * 100 + '%' }"></i>
              </div>
              <span v-if="drawEngine !== 'sd'" class="stage-generating-elapsed">已等待 {{ animaElapsed }} 秒</span>
              <details v-if="drawEngine !== 'sd' && animaCurrentNode" class="stage-progress-details"><summary>生成详情</summary>当前步骤：{{ animaCurrentNode }}</details>
            </div>
          </div>
        <div v-else-if="generationError" class="stage-idle" role="alert">
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
          <div class="atelier-canvas-mark" aria-hidden="true"><ArchiveIcon name="image" /></div>
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

    <!-- Result image -->
    <div v-if="displayResultUrl" class="result-image-wrap archive-canvas" :style="{ '--canvas-ambient-1': ambientColors[0] || '0 0 0', '--canvas-ambient-2': ambientColors[1] || '0 0 0', '--canvas-ambient-3': ambientColors[2] || '0 0 0' }">
      <div class="canvas-ambient" :class="{ 'is-enabled': ambientEnabled && ambientColors.length > 0 }" aria-hidden="true" />
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
        alt="当前生成的画面成片"
        @load="fitResult"
        @reveal-start="rememberResultReveal"
        @reveal-complete="rememberResultReveal"
      />
    </div>
    <DirectorResultTools
      v-bind="{ generationBusy, hasPrevResult, resultArchived, savingResult, resultTemporary, capturingScene }"
      :has-result="Boolean(displayResultUrl)" :ambient-enabled="ambientEnabled"
      @update:ambientEnabled="ambientEnabled = $event"
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
import ImageSplitCompare from '@/components/visual/ImageSplitCompare.vue'
import CgImageReveal from '@/components/visual/CgImageReveal.vue'
import ThinkingOrb from '@/components/visual/ThinkingOrb.vue'
import DirectorSceneReference from './DirectorSceneReference.vue'
import DirectorResultTools from './DirectorResultTools.vue'
import { useCanvasClearMotion } from '@/composables/useCanvasClearMotion'
import { sampleCanvasAmbient } from '@/utils/canvasAmbient'
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
  animaCurrentNode: string
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

const stageRoot = ref<HTMLElement | null>(null)
const { playClear } = useCanvasClearMotion(stageRoot, () => props.displayResultUrl, () => props.generationBusy, () => props.inpaintCompareActive)

const resultAspect = ref(1)
const loadedResultUrl = ref('')
const ambientEnabled = ref(true)
const ambientColors = ref<string[]>([])
watch(() => props.displayResultUrl, () => {
  const [width, height] = (props.canvasSize || '').split('x').map(Number)
  resultAspect.value = width > 0 && height > 0 ? width / height : 1
  loadedResultUrl.value = ''
  ambientColors.value = []
}, { immediate: true })
async function fitResult(event: Event) {
  const image = event.target as HTMLImageElement
  const source = props.displayResultUrl
  resultAspect.value = image.naturalWidth / image.naturalHeight
  ambientColors.value = sampleCanvasAmbient(image)
  // Settle the canvas ratio before the decoded work receives its reveal.
  await nextTick()
  if (source === props.displayResultUrl) loadedResultUrl.value = source
}

// Keep reveal history local and bounded. Returning from compare/history must not replay it.
const revealedResults = ref(new Set<string>())
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
watch(() => [props.displayResultUrl, props.resultRevealUrl, props.inpaintCompareActive], () => {
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

/**
 * 剪贴板里的图片直接反推（2026-08-30 UX 审计 P2）。
 *
 * 本地反推此前只能走文件选择器，而真要用的那一刻，图往往已经在剪贴板里了
 * （刚截的图、从参考站复制的），多一趟「打开对话框找文件」纯属多余。
 * 监听挂在按钮上是因为浏览器只把 paste 派发给焦点元素，按钮天然可聚焦。
 */
function onInterrogatePaste(e: ClipboardEvent) {
  const image = Array.from(e.clipboardData?.files ?? []).find(f => f.type.startsWith('image/'))
  if (!image) return
  e.preventDefault()
  void runInterrogateFile(image)
}

/** 反推一张图片：文件选择与剪贴板粘贴共用这一条路径 */
async function runInterrogateFile(file: File) {
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
defineExpose({ playClear, resultAspect, interrogateBusy, interrogateError, cancelInterrogate: cancel, interrogateCurrentImage, triggerInterrogatePick, onInterrogatePaste })
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

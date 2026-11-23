<template>
  <!-- stage-slot：col-center 的画布槽位锚点（layout.css 以它固定中栏排序首位） -->
  <div class="stage-slot">
    <div class="canvas-heading"><div><ArchiveIcon name="image" /><strong>{{ displayResultUrl ? '当前成片' : sceneTitle || '画布' }}</strong><span v-if="sceneTitle && !displayResultUrl">场景参考</span></div><button v-if="sceneTitle || displayResultUrl" class="btn btn-quiet btn-sm" type="button" @click="$emit('exploreScenes')"><ArchiveIcon name="scene" />更换场景</button></div>
    <Transition name="stage-beam">
      <BorderBeam v-if="generationBusy || waitingForResult" class="canvas-generation-beam"
        :duration="8.8" :border-width="1.1" color-variant="dual" :glow="true" border-radius="var(--r-xl)" />
    </Transition>
    <div ref="canvasViewport" class="stage-viewport" data-route-arrive tabindex="-1" role="group" aria-label="绘制画布">
    <!-- 图片显现只由新生成结果驱动，画布与工具保持静止。 -->
    <Transition name="stage-swap">
      <section
        v-if="!displayResultUrl || generationBusy || waitingForResult || failedResultUrl === displayResultUrl"
        class="stage-placeholder"
      :class="{
        'is-generating': generationBusy || waitingForResult,
        'is-awaiting-result': waitingForResult,
        'is-error': !generationBusy && !generation.needsReview && (!!generationError || Boolean(displayResultUrl && failedResultUrl === displayResultUrl)),
        'is-paused': generationStopped,
      }"
      aria-label="成片监看区"
    >
      <CornerFrame v-if="!generationBusy && !waitingForResult" variant="editorial" />
      <div class="stage-message">
        <div class="stage-content" :class="{ 'is-covered': coveringResult }">
        <template v-if="!generationBusy && !waitingForResult">
        <DirectorSceneReference :size="canvasSize" />
        <div v-if="displayResultUrl && failedResultUrl === displayResultUrl" class="stage-idle" role="alert">
          <div class="stage-placeholder-title">成片加载失败</div>
          <div class="stage-placeholder-copy">生成结果已保留，可重新读取。</div>
          <div class="stage-quick-actions"><button class="btn btn-primary" type="button" @click="retryResultImage">重新读取</button></div>
        </div>
        <div v-else-if="generation.needsReview" class="stage-idle" role="status">
          <div class="stage-placeholder-title">任务与结果待核对</div>
          <div class="stage-placeholder-copy">{{ generation.message }}</div>
          <div class="stage-quick-actions">
            <button class="btn btn-primary" type="button" @click="generation.review">重新查询原请求</button>
            <button v-if="hasStashedResult" class="btn btn-ghost" type="button" @click="$emit('restoreStashed')">找回上一张成片</button>
          </div>
        </div>
        <div v-else-if="generationError" class="stage-idle" role="alert">
          <div class="stage-placeholder-title">生成中断</div>
          <button class="btn btn-ghost" type="button" @click="$emit('openRecovery')">查看恢复选项</button>
          <div class="stage-placeholder-copy">
            请检查参数或连接后重试。
            <span class="stage-error-detail">（{{ generationError }}）</span>
          </div>
          <div class="stage-quick-actions">
            <button class="btn btn-primary" type="button" @click="$emit('generate')">重新生成</button>
            <!-- F2：本次失败不毁掉上一张未入册成片——它还在暂存里，一键找回 -->
            <button v-if="hasStashedResult" class="btn btn-ghost" type="button" @click="$emit('restoreStashed')">
              找回上一张成片
            </button>
          </div>
        </div>
        <div v-else-if="generationStopped" class="stage-idle">
          <div class="stage-placeholder-title">生成已暂停</div>
          <div class="stage-placeholder-copy">
            随时可继续生成。
          </div>
          <div class="stage-quick-actions">
            <button class="btn btn-primary" type="button" @click="$emit('generate')">继续生成</button>
            <button v-if="hasStashedResult" class="btn btn-ghost" type="button" @click="$emit('restoreStashed')">
              找回上一张成片
            </button>
          </div>
        </div>
        <div v-else class="stage-idle stage-idle-guide">
          <AtelierEmptyArt :character="emptyCharacterId" class="atelier-canvas-illustration" />
          <div class="stage-placeholder-title">{{ emptyStageTitle }}</div>
          <p class="stage-character-quote">「{{ emptyStageQuote }}」</p>
          <div class="stage-placeholder-copy">
            选择场景或输入画面描述。
          </div>
          <div class="stage-quick-actions">
            <button class="btn btn-primary studio-press-ripple" type="button" @click.capture="pressRipple" @click="$emit('exploreScenes')"><ArchiveIcon name="scene" /><span class="studio-control-label">挑选场景</span></button>
            <button class="btn btn-quiet" type="button" @click="$emit('editDescription')"><ArchiveIcon name="spark" /><span class="studio-control-label">写画面描述</span></button>
          </div>
        </div>
        </template>
        </div>
      </div>
    </section>
    </Transition>

    <!-- The same fine-line orbit stays mounted through breakup, waiting and formation. -->
    <div v-if="(generationBusy || waitingForResult || textureMotionActive || forming) && !retryingResult && !coveringResult"
      class="stage-generation-orbit" :class="{ 'is-forming': forming && !textureMotionActive }">
      <GenerationParticles ref="generationOrbit" :progress="stageProgress" :palette="generationPalette" />
    </div>

    <Transition name="stage-feedback">
      <span v-if="waitingForResult && !generationBusy" class="stage-generation-feedback" role="status">
        {{ retryingResult ? '正在重新读取成片…' : '正在读取成片…' }}
      </span>
    </Transition>

    <!-- Result image -->
    <div v-if="displayResultUrl" class="result-image-wrap archive-canvas" :class="{ 'is-error': failedResultUrl === displayResultUrl }">
      <div class="result-artwork" :style="{ '--result-aspect': resultAspect }" :class="{ 'can-tilt': restingResult }"
        @pointerenter="tilt.enter" @pointermove="tilt.move" @pointerleave="tilt.reset" @pointercancel="tilt.reset">
        <ImageCompareSlider
          v-if="inpaintCompareActive && inpaintOriginalUrl"
          :before-src="inpaintOriginalUrl"
          :after-src="displayResultUrl"
          before-label="换装前原图"
          after-label="换装后成片"
        />
        <div v-else ref="artPlane" class="result-art-plane">
        <CgImageReveal
          :key="`${displayResultUrl}:${imageRetry}`"
          class="result-image-reveal"
          :src="displayResultUrl"
          :auto-reveal="displayResultUrl === resultRevealUrl && !revealedResults.has(displayResultUrl)"
          :reveal-effect="revealTextureResult"
          :duration="900"
          alt="当前生成的画面成片"
          @load="fitResult"
          @reveal-start="onRevealStart"
          @reveal-complete="onResultReveal"
          @error="onResultImageError"
        />
        </div>
      </div>
      <div v-if="!generationBusy && !waitingForResult && !inpaintCompareActive && failedResultUrl !== displayResultUrl" class="result-reading-feedback" role="status"><ArchiveIcon name="image" /><span>正在读取成片…</span></div>
      <div v-if="focusBurstActive" class="fx-focus-lines is-bursting" aria-hidden="true" @animationend="clearFocusBurst" />
    </div>
    </div>
    <DirectorResultTools
      v-if="displayResultUrl"
      v-bind="{ generationBusy, hasPrevResult, resultArchived, savingResult, resultTemporary, capturingScene }"
      :can-save-scene="canSaveScene"
      :size="resultSize"
      :tilt-enabled="tiltEnabled"
      :tilt-available="canAnimate && !!loadedResultUrl && !inpaintCompareActive"
      @saveScene="$emit('saveScene')" @saveResult="$emit('saveResult')" @openCompare="$emit('openCompare')"
      @clearResult="$emit('clearResult')" @toggle-tilt="toggleTilt"
    />
    <!-- 供两态共用的上传入口 -->
    <input ref="interrogateInputRef" hidden type="file" accept="image/*" @change="onInterrogateFile" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onDeactivated, ref, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import AtelierEmptyArt from '@/components/visual/AtelierEmptyArt.vue'
import CornerFrame from '@/components/visual/CornerFrame.vue'
import ImageCompareSlider from '@/components/visual/ImageCompareSlider.vue'
import CgImageReveal from '@/components/visual/CgImageReveal.vue'
import GenerationParticles from '@/components/visual/GenerationParticles.vue'
import BorderBeam from '@/components/visual/BorderBeam.vue'
import DirectorSceneReference from './DirectorSceneReference.vue'
import DirectorResultTools from './DirectorResultTools.vue'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { useCanvasGenerationMotion } from '@/composables/useCanvasGenerationMotion'
import { useCanvasClearMotion } from '@/composables/useCanvasClearMotion'
import { useArtworkTilt } from '@/composables/useArtworkTilt'
import { useVisualActivity } from '@/composables/useVisualActivity'
import { usePressRipple } from '@/composables/usePressRipple'
import type { GenerationPresentation } from '@/composables/prompt/useGenerationPresentation'
import { sampleGenerationPalette } from '@/utils/generationPalette'
import { useInterrogate } from '@/composables/useInterrogate'
import type { InterrogateResult } from '@/composables/useInterrogate'

const props = defineProps<{
  sceneTitle?: string
  applyInterrogateResult: (result: InterrogateResult, current: () => boolean) => Promise<void>
  displayResultUrl: string
  resultRevealUrl?: string
  canvasSize?: string
  generationBusy: boolean
  generationError: string | null
  generationStopped: boolean
  generation: GenerationPresentation
  drawEngine: string
  inpaintOriginalUrl: string | null
  inpaintCompareActive: boolean
  hasPrevResult: boolean
  /** 当前结果是否已入册（null = 画布无结果，不显示徽章）。 */
  resultArchived?: boolean | null
  capturingScene?: boolean
  canSaveScene?: boolean
  savingResult?: boolean
  resultTemporary?: boolean
  /** Anima/Krea 暂存里还有上一张未入册成片（失败/取消后可找回）。 */
  hasStashedResult?: boolean
}>()

const pb = usePromptBuilderStore()
const emptyCharacterId = computed(() => pb.subject.kind === 'popular' ? pb.subject.characterId : pb.char)
const activePopularChar = computed(() => {
  const subject = pb.subject
  return subject.kind === 'popular'
    ? pb.popularCharacters.find(item => item.id === subject.characterId) ?? null
    : null
})
const emptyStageTitle = computed(() => {
  if (activePopularChar.value) return `${activePopularChar.value.displayName} · 画室留白`
  if (pb.char === 'natsume') return '四季夏目 · 午后画桌'
  if (pb.char === 'triad') return '双人同行 · 画境序章'
  return '绫地宁宁 · 月下画桌'
})
const emptyStageQuote = computed(() => {
  if (activePopularChar.value) return `光影与构图都已备好，随时描绘${activePopularChar.value.displayName}的这一幕。`
  if (pb.char === 'natsume') return '咖啡刚温好，慢慢挑一页想画的故事。'
  if (pb.char === 'triad') return '两道目光交汇的瞬间，就是这一幕的开场。'
  return '月影落进窗格前，先为这一幕留白吧。'
})

const canvasViewport = ref<HTMLElement | null>(null)
const { canAnimate, lowEffects } = useVisualActivity(canvasViewport)
const texturesEnabled = computed(() => canAnimate.value && !lowEffects.value)
const focusBurstActive = ref(false)
let focusBurstTimer: ReturnType<typeof setTimeout> | null = null
function clearFocusBurst() {
  focusBurstActive.value = false
  if (focusBurstTimer !== null) {
    clearTimeout(focusBurstTimer)
    focusBurstTimer = null
  }
}
function triggerFocusBurst() {
  clearFocusBurst()
  if (!canAnimate.value || lowEffects.value) return
  focusBurstActive.value = true
  focusBurstTimer = setTimeout(clearFocusBurst, 680)
}
onDeactivated(clearFocusBurst)
onBeforeUnmount(clearFocusBurst)
const pressRipple = usePressRipple()
const generationOrbit = ref<InstanceType<typeof GenerationParticles> | null>(null)
const resultPalette = ref<string[]>([])
const generationPalette = ref<string[]>([])
// Capture before publication/clearing; the new image's load must not recolor an ongoing wait.
watch(() => props.generationBusy, busy => { if (busy) { generationPalette.value = [...resultPalette.value]; retryingResult.value = false } }, { flush: 'sync' })
const { active: textureMotionActive, reveal: revealTextureResult, stop: stopTextureMotion } = useCanvasGenerationMotion(canvasViewport, texturesEnabled, () => props.displayResultUrl, () => props.generationBusy, () => props.inpaintCompareActive, () => props.generation.progress, () => generationPalette.value, () => resultPalette.value, () => generationOrbit.value)
const { playClear: dissolveResult, coveringResult } = useCanvasClearMotion(canvasViewport, texturesEnabled, () => props.displayResultUrl, () => props.generationBusy, () => props.inpaintCompareActive)

const resultAspect = ref(1)
const decodedSize = ref('')
const resultSize = computed(() => decodedSize.value || props.canvasSize?.replace(/[x×]/, ' × ') || '')
const loadedResultUrl = ref('')
const failedResultUrl = ref('')
const imageRetry = ref(0), retryingResult = ref(false)
const artPlane = ref<HTMLElement | null>(null), forming = ref(false)
watch(() => props.displayResultUrl, () => {
  const [width, height] = (props.canvasSize || '').split('x').map(Number)
  resultAspect.value = width > 0 && height > 0 ? width / height : 1
  decodedSize.value = ''
  loadedResultUrl.value = ''
  failedResultUrl.value = ''
  imageRetry.value = 0; retryingResult.value = false; forming.value = false
}, { immediate: true })
function fitResult(image: HTMLImageElement) {
  resultAspect.value = image.naturalWidth / image.naturalHeight
  decodedSize.value = `${image.naturalWidth} × ${image.naturalHeight}`
  resultPalette.value = sampleGenerationPalette(image)
  loadedResultUrl.value = props.displayResultUrl
  retryingResult.value = false
}

// Keep reveal history local and bounded. Returning from compare/history must not replay it.
const revealedResults = ref(new Set<string>())
const waitingForResult = computed(() => retryingResult.value || Boolean(props.displayResultUrl && props.displayResultUrl === props.resultRevealUrl
  && !props.inpaintCompareActive && !revealedResults.value.has(props.displayResultUrl) && failedResultUrl.value !== props.displayResultUrl))
const stageProgress = computed(() => waitingForResult.value ? null : props.generation.progress)
const tiltEnabled = ref(true)
const restingResult = computed(() => tiltEnabled.value && canAnimate.value && !!loadedResultUrl.value && !props.generationBusy && !waitingForResult.value && !forming.value
  && !coveringResult.value && !props.inpaintCompareActive && !failedResultUrl.value)
const tilt = useArtworkTilt(artPlane, () => restingResult.value)
function toggleTilt() {
  tiltEnabled.value = !tiltEnabled.value
  if (!tiltEnabled.value) tilt.flatten()
}
function playClear() { tilt.flatten(); dissolveResult() }
watch(() => props.generationBusy, busy => { if (busy) tilt.flatten() }, { flush: 'sync' })
function onResultImageError() { failedResultUrl.value = props.displayResultUrl; retryingResult.value = false; forming.value = false; stopTextureMotion() }
async function retryResultImage() {
  rememberResultReveal(); failedResultUrl.value = ''; loadedResultUrl.value = ''
  retryingResult.value = true; imageRetry.value++
  await nextTick(); canvasViewport.value?.focus({ preventScroll: true })
}
function onRevealStart() { forming.value = true; rememberResultReveal() }
function onResultReveal() { forming.value = false; stopTextureMotion(); rememberResultReveal(); triggerFocusBurst() }
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
  if (props.inpaintCompareActive) {
    forming.value = false
    if (props.displayResultUrl === props.resultRevealUrl) rememberResultReveal()
  }
}, { immediate: true })

const emit = defineEmits<{
  generate: []
  openRecovery: []
  exploreScenes: []
  editDescription: []
  saveScene: []
  saveResult: []
  clearResult: []
  openCompare: []
  restoreStashed: []
  interrogateError: [message: string]
}>()

const interrogateInputRef = ref<HTMLInputElement | null>(null)
const { busy: interrogateBusy, error: interrogateError, interrogate, cancel } = useInterrogate((result, current) => props.applyInterrogateResult(result, current))
const interrogateMode = computed(() => props.drawEngine === 'krea2' ? 'caption' as const : 'tag' as const)
// Keep the source identity after success so delayed notices also retire when
// the current picture changes. File/clipboard requests do not own the canvas.
let interrogatedResultUrl: string | null = null
watch(() => props.drawEngine, () => cancel(), { flush: 'sync' })
watch(() => props.displayResultUrl, url => { if (interrogatedResultUrl !== null && url !== interrogatedResultUrl) cancel() }, { flush: 'sync' })

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
  if (interrogateBusy.value) return
  interrogatedResultUrl = null
  try {
    await interrogate(file, interrogateMode.value)
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
  interrogatedResultUrl = props.displayResultUrl
  try {
    await interrogate(interrogatedResultUrl, interrogateMode.value)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    emit('interrogateError', msg)
    console.warn('[interrogate]', msg)
  }
}
defineExpose({ playClear, interrogateBusy, interrogateError, cancelInterrogate: cancel, interrogateCurrentImage, interrogateClipboardImage, triggerInterrogatePick, onInterrogatePaste })
</script>

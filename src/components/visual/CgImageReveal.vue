<template>
  <div ref="containerRef" class="cg-image-reveal" :class="{ 'is-revealing': isRevealing, 'is-loaded': isLoaded }">
    <!-- Keying the image prevents a late event from the previous URL owning a new reveal. -->
    <img
      :key="src"
      ref="imgRef"
      class="cg-image-target"
      :class="imgClass"
      :src="resolveRuntimeUrl(src)"
      :alt="alt || '生成的画面成片'"
      loading="eager"
      decoding="async"
      @load="onImageLoad"
      @error="onImageError"
      @click="$emit('click', $event)"
    />
    <canvas v-show="isRevealing" ref="canvasRef" class="cg-reveal-canvas" aria-hidden="true" />
    <div v-if="isRevealing && !lowEffects" class="cg-reveal-sweep" :style="sweepStyle" aria-hidden="true" />
  </div>
</template>

<script setup lang="ts">
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'

import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useResizeObserver } from '@vueuse/core'
import { useVisualActivity } from '@/composables/useVisualActivity'

const props = withDefaults(defineProps<{
  src: string
  alt?: string
  imgClass?: string
  duration?: number
  autoReveal?: boolean
}>(), { alt: '生成的画面成片', imgClass: '', duration: 880, autoReveal: true })

const emit = defineEmits<{
  load: [event: Event]
  error: [event: Event]
  click: [event: MouseEvent]
  'reveal-start': []
  'reveal-complete': []
}>()
const containerRef = ref<HTMLElement | null>(null)
const imgRef = ref<HTMLImageElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const { canAnimate, lowEffects } = useVisualActivity(containerRef)
const isRevealing = ref(false)
const isLoaded = ref(false)
const sweepProgress = ref(0)
let rafId: number | null = null
let generation = 0
let handledImage: HTMLImageElement | null = null
let completedImage: HTMLImageElement | null = null
let revealWidth = 0
let revealHeight = 0

const sweepStyle = computed(() => ({
  '--sweep-p': `${sweepProgress.value * 130 - 15}%`,
  '--sweep-opacity': sweepProgress.value > 0 && sweepProgress.value < 1 ? '1' : '0',
}))

function stopAnimation(): void {
  generation += 1
  if (rafId !== null) cancelAnimationFrame(rafId)
  rafId = null
  isRevealing.value = false
  sweepProgress.value = 0
}

function finishReveal(): void {
  stopAnimation()
  isLoaded.value = true
  const img = imgRef.value
  if (img && completedImage !== img) {
    completedImage = img
    emit('reveal-complete')
  }
}

function isCurrentImage(img: HTMLImageElement | null): img is HTMLImageElement {
  return Boolean(img && img === imgRef.value && img.getAttribute('src') === props.src)
}

function triggerReveal(): void {
  const img = imgRef.value
  if (!isCurrentImage(img) || !img.complete || img.naturalWidth === 0) return
  stopAnimation()
  completedImage = null
  if (!canAnimate.value || lowEffects.value || !canvasRef.value) {
    finishReveal()
    return
  }
  const canvas = canvasRef.value
  const rect = img.getBoundingClientRect()
  revealWidth = rect.width
  revealHeight = rect.height
  if (rect.width < 1 || rect.height < 1) {
    finishReveal()
    return
  }
  const duration = Number.isFinite(props.duration) ? Math.max(160, Math.min(1600, props.duration)) : 880
  const dpr = Math.min(window.devicePixelRatio || 1, 2, 1600 / Math.max(rect.width, rect.height), Math.sqrt(2_000_000 / (rect.width * rect.height)))
  canvas.width = Math.max(1, Math.round(rect.width * dpr))
  canvas.height = Math.max(1, Math.round(rect.height * dpr))
  const gridX = Math.max(8, Math.min(64, Math.floor(28 * rect.width / 320)))
  const gridY = Math.max(8, Math.min(64, Math.floor(28 * rect.height / 320)))
  let ctx: CanvasRenderingContext2D | null = null
  let pixels: Uint8ClampedArray

  try {
    ctx = canvas.getContext('2d', { alpha: true })
    const sample = document.createElement('canvas')
    sample.width = gridX
    sample.height = gridY
    const sampleCtx = sample.getContext('2d', { willReadFrequently: true })
    if (!ctx || !sampleCtx) {
      finishReveal()
      return
    }
    // Match object-fit: contain, including portrait/landscape letterboxing.
    const scale = Math.min(rect.width / img.naturalWidth, rect.height / img.naturalHeight)
    const width = img.naturalWidth * scale
    const height = img.naturalHeight * scale
    sampleCtx.drawImage(img, (rect.width - width) / 2 / rect.width * gridX,
      (rect.height - height) / 2 / rect.height * gridY, width / rect.width * gridX, height / rect.height * gridY)
    // Cross-origin images usually throw here, not at drawImage. Never block the real <img>.
    pixels = sampleCtx.getImageData(0, 0, gridX, gridY).data
  } catch {
    finishReveal()
    return
  }

  const styles = getComputedStyle(containerRef.value!)
  const accent = styles.getPropertyValue('--accent').trim() || '#F2A8BE'
  const violet = styles.getPropertyValue('--accent-violet').trim() || '#B784F6'
  const bg = styles.getPropertyValue('--bg-deep').trim() || '#181420'
  const thresholds = new Float32Array(gridX * gridY)
  for (let y = 0; y < gridY; y++) {
    for (let x = 0; x < gridX; x++) {
      const wave = x / (gridX - 1) * 0.55 + y / (gridY - 1) * 0.45
      const noise = Math.abs((Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1)
      thresholds[y * gridX + x] = Math.max(0, Math.min(0.88, wave + (noise - 0.5) * 0.28))
    }
  }
  const token = generation
  const startedAt = performance.now()
  const cellW = canvas.width / gridX
  const cellH = canvas.height / gridY
  const context = ctx

  function renderFrame(now: number): void {
    if (token !== generation || !isCurrentImage(img)) return
    rafId = null
    if (!canAnimate.value) {
      finishReveal()
      return
    }
    const raw = Math.max(0, Math.min(1, (now - startedAt) / duration))
    const progress = 1 - Math.pow(1 - raw, 3)
    sweepProgress.value = raw < 0.5 ? 2 * raw * raw : 1 - Math.pow(-2 * raw + 2, 2) / 2
    context.clearRect(0, 0, canvas.width, canvas.height)
    for (let y = 0; y < gridY; y++) {
      for (let x = 0; x < gridX; x++) {
        const idx = y * gridX + x
        const age = progress - thresholds[idx]
        // Cleared cells expose the full-resolution artwork, rather than replacing it with a mosaic.
        if (age >= 0.12) continue
        context.globalAlpha = 1
        context.fillStyle = bg
        if (age >= 0) {
          const p = idx * 4
          context.fillStyle = `rgba(${pixels[p]}, ${pixels[p + 1]}, ${pixels[p + 2]}, ${pixels[p + 3] / 255})`
          context.globalAlpha = Math.max(0, 1 - age / 0.12)
        }
        context.fillRect(x * cellW, y * cellH, cellW + 0.5, cellH + 0.5)
        if (age < 0 && age > -0.18) {
          context.fillStyle = (x + y) % 2 ? accent : violet
          context.globalAlpha = 0.35 * (1 + age / 0.18)
          context.fillRect((x + 0.2) * cellW, (y + 0.2) * cellH, cellW * 0.6, cellH * 0.6)
        }
      }
    }
    context.globalAlpha = 1
    if (raw < 1) rafId = requestAnimationFrame(renderFrame)
    else finishReveal()
  }

  isRevealing.value = true
  renderFrame(startedAt)
  emit('reveal-start')
}

function handleReadyImage(): void {
  const img = imgRef.value
  if (!isCurrentImage(img) || !img.complete || img.naturalWidth === 0 || handledImage === img) return
  handledImage = img
  isLoaded.value = true
  if (props.autoReveal) triggerReveal()
  else finishReveal()
}

function onImageLoad(event: Event): void {
  if (event.target !== imgRef.value || !isCurrentImage(imgRef.value)) return
  emit('load', event)
  handleReadyImage()
}
function onImageError(event: Event): void {
  if (event.target !== imgRef.value) return
  stopAnimation()
  isLoaded.value = true
  emit('error', event)
}

// Cancel synchronously; inspect the replacement DOM only after Vue has patched it.
watch(() => props.src, () => {
  stopAnimation()
  isLoaded.value = false
  handledImage = null
  completedImage = null
}, { flush: 'sync' })
watch(() => props.src, handleReadyImage, { flush: 'post' })
watch([canAnimate, lowEffects], () => {
  if (isRevealing.value && (!canAnimate.value || lowEffects.value)) finishReveal()
}, { flush: 'sync' })
useResizeObserver(imgRef, () => {
  if (!isRevealing.value || !imgRef.value) return
  const rect = imgRef.value.getBoundingClientRect()
  if (Math.abs(rect.width - revealWidth) > 1 || Math.abs(rect.height - revealHeight) > 1) finishReveal()
})
onMounted(handleReadyImage)
onBeforeUnmount(stopAnimation)
defineExpose({ triggerReveal })
</script>

<style scoped>
.cg-image-reveal {
  position: relative;
  display: block;
  overflow: hidden;
  border-radius: inherit;
  background: var(--bg-deep);
}
.cg-image-target {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.cg-reveal-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 2;
}
.cg-reveal-sweep {
  position: absolute;
  inset: -50%;
  width: 200%;
  height: 200%;
  pointer-events: none;
  z-index: 3;
  transform: translate3d(var(--sweep-p, -15%), var(--sweep-p, -15%), 0) rotate(-45deg);
  opacity: var(--sweep-opacity, 0);
  background: linear-gradient(90deg, transparent 42%, color-mix(in srgb, var(--accent) 25%, transparent) 48%,
    var(--glass-specular) 50%, color-mix(in srgb, var(--accent-violet) 30%, transparent) 52%, transparent 58%);
  mix-blend-mode: screen;
}
</style>

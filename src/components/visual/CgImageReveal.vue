<template>
  <div
    ref="containerRef"
    class="cg-image-reveal"
    :class="{ 'is-revealing': isRevealing, 'is-loaded': isLoaded }"
  >
    <!-- 底层真实图片：保持语义与无障碍，动画完成后由它常驻呈现 -->
    <img
      ref="imgRef"
      class="cg-image-target"
      :class="imgClass"
      :src="src"
      :alt="alt || '生成的画面成片'"
      loading="eager"
      decoding="async"
      @load="onImageLoad"
      @error="onImageError"
      @click="$emit('click', $event)"
    />

    <!-- 顶层粒子与像素马赛克溶解画布：仅在揭示期运行 rAF -->
    <canvas
      v-show="isRevealing"
      ref="canvasRef"
      class="cg-reveal-canvas"
      aria-hidden="true"
    />

    <!-- 二次元水晶扫光条 -->
    <div
      v-if="isRevealing && !isReducedMotion"
      class="cg-reveal-sweep"
      :style="sweepStyle"
      aria-hidden="true"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'

const props = withDefaults(
  defineProps<{
    src: string
    alt?: string
    imgClass?: string
    duration?: number
    autoReveal?: boolean
  }>(),
  {
    alt: '生成的画面成片',
    imgClass: '',
    duration: 880,
    autoReveal: true,
  }
)

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

const isRevealing = ref(false)
const isLoaded = ref(false)
const isReducedMotion = ref(false)
const sweepProgress = ref(0)

let rafId: number | null = null
let animStartTime = 0

// 离屏微型 Canvas：用于获取低分辨率降采样像素颜色
let offscreenCanvas: HTMLCanvasElement | null = null
let offscreenCtx: CanvasRenderingContext2D | null = null

// 预先生成的随机噪点表，避免每帧 Math.random 导致抖动杂乱
let dropThresholds: Float32Array | null = null

function checkReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function parseColors(): { accent: string; violet: string; bg: string } {
  if (typeof window === 'undefined' || !containerRef.value) {
    return { accent: '#F2A8BE', violet: '#B784F6', bg: '#181420' }
  }
  const styles = getComputedStyle(containerRef.value)
  const accent = styles.getPropertyValue('--accent').trim() || '#F2A8BE'
  const violet = styles.getPropertyValue('--accent-violet').trim() || '#B784F6'
  const bg = styles.getPropertyValue('--bg-deep').trim() || '#181420'
  return { accent, violet, bg }
}

// 缓动曲线：平滑减速
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
}

const sweepStyle = computed(() => ({
  '--sweep-p': `${sweepProgress.value * 130 - 15}%`,
  '--sweep-opacity': sweepProgress.value > 0 && sweepProgress.value < 1 ? '1' : '0',
}))

function stopAnimation(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
  isRevealing.value = false
  sweepProgress.value = 0
}

function triggerReveal(): void {
  if (isReducedMotion.value || !imgRef.value || !canvasRef.value) {
    isRevealing.value = false
    isLoaded.value = true
    emit('reveal-complete')
    return
  }

  const img = imgRef.value
  const canvas = canvasRef.value
  const ctx = canvas.getContext('2d', { alpha: true })
  if (!ctx) return

  const rect = img.getBoundingClientRect()
  const displayW = Math.round(rect.width) || img.naturalWidth || 640
  const displayH = Math.round(rect.height) || img.naturalHeight || 480

  // 视网膜清晰度适配
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = displayW * dpr
  canvas.height = displayH * dpr
  canvas.style.width = `${displayW}px`
  canvas.style.height = `${displayH}px`

  // 基于基准尺寸（320px）计算网格数，保持像素块适中且接近正方形
  const baseCells = 28
  const gridX = Math.max(8, Math.min(64, Math.floor((baseCells * displayW) / 320)))
  const gridY = Math.max(8, Math.min(64, Math.floor((baseCells * displayH) / 320)))
  const totalCells = gridX * gridY

  // 初始化或复用离屏微型画布
  if (!offscreenCanvas) {
    offscreenCanvas = document.createElement('canvas')
    offscreenCtx = offscreenCanvas.getContext('2d', { willReadFrequently: true })
  }
  offscreenCanvas.width = gridX
  offscreenCanvas.height = gridY
  if (!offscreenCtx) return

  // 将大图按覆盖裁剪（cover）绘制进微型画布
  try {
    offscreenCtx.drawImage(img, 0, 0, gridX, gridY)
  } catch {
    // 跨域或未就绪兜底
    stopAnimation()
    return
  }

  const pixelData = offscreenCtx.getImageData(0, 0, gridX, gridY).data

  // 生成对角波前 + 空间随机噪点的激活阈值
  dropThresholds = new Float32Array(totalCells)
  for (let y = 0; y < gridY; y++) {
    for (let x = 0; x < gridX; x++) {
      const idx = y * gridX + x
      const wave = (x / (gridX - 1)) * 0.55 + (y / (gridY - 1)) * 0.45
      // 简单伪随机数，让边缘富有数码噪点质感
      const noise = (Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1
      const jitter = (Math.abs(noise) - 0.5) * 0.28
      dropThresholds[idx] = Math.max(0, Math.min(1, wave + jitter))
    }
  }

  const { accent, violet, bg } = parseColors()

  isRevealing.value = true
  animStartTime = performance.now()
  emit('reveal-start')

  const cellW = canvas.width / gridX
  const cellH = canvas.height / gridY

  function renderFrame(now: number): void {
    const activeCtx = ctx
    if (!activeCtx) return

    const elapsed = now - animStartTime
    const rawP = Math.min(1, elapsed / props.duration)
    const progress = easeOutCubic(rawP)
    sweepProgress.value = easeInOutQuad(rawP)

    activeCtx.clearRect(0, 0, canvas.width, canvas.height)
    activeCtx.imageSmoothingEnabled = false

    const thresholdMargin = 0.12

    for (let y = 0; y < gridY; y++) {
      for (let x = 0; x < gridX; x++) {
        const idx = y * gridX + x
        const threshold = dropThresholds![idx]
        const px = x * cellW
        const py = y * cellH

        if (progress >= threshold) {
          // 已完全揭示的像素块：绘制真实图片下采样颜色
          const pIdx = idx * 4
          const r = pixelData[pIdx]
          const g = pixelData[pIdx + 1]
          const b = pixelData[pIdx + 2]
          const a = pixelData[pIdx + 3] / 255

          const age = progress - threshold
          if (age < thresholdMargin) {
            // 刚刚诞生的瞬时高亮：混合甜系粉紫光晕
            const flash = (1 - age / thresholdMargin) * 0.5
            activeCtx.fillStyle = `rgba(${r + (255 - r) * flash}, ${g + (180 - g) * flash}, ${b + (210 - b) * flash}, ${a})`
          } else {
            activeCtx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`
          }
          activeCtx.fillRect(px, py, cellW + 0.5, cellH + 0.5)
        } else {
          // 尚未揭示的区域：绘制具有 Galgame 氛围的半透明夜空绀蓝底块与星芒微光
          const distance = threshold - progress
          if (distance < thresholdMargin * 1.5) {
            // 扫光锋面前沿：跳动的粉紫微光粒子
            const spark = Math.sin((x + y + elapsed * 0.02) * 2) * 0.5 + 0.5
            activeCtx.fillStyle = spark > 0.4 ? accent : violet
            activeCtx.globalAlpha = 0.35 * (1 - distance / (thresholdMargin * 1.5))
            activeCtx.fillRect(px + cellW * 0.2, py + cellH * 0.2, cellW * 0.6, cellH * 0.6)
            activeCtx.globalAlpha = 1
          } else {
            // 远端深色底衬
            activeCtx.fillStyle = bg
            activeCtx.globalAlpha = 0.8
            activeCtx.fillRect(px, py, cellW + 0.5, cellH + 0.5)
            activeCtx.globalAlpha = 1
          }
        }
      }
    }

    if (rawP < 1) {
      rafId = requestAnimationFrame(renderFrame)
    } else {
      // 动画顺利收尾，平滑让位给底层的原图
      stopAnimation()
      isLoaded.value = true
      emit('reveal-complete')
    }
  }

  rafId = requestAnimationFrame(renderFrame)
}

function onImageLoad(e: Event): void {
  emit('load', e)
  if (props.autoReveal) {
    triggerReveal()
  } else {
    isLoaded.value = true
  }
}

function onImageError(e: Event): void {
  stopAnimation()
  isLoaded.value = true
  emit('error', e)
}

watch(
  () => props.src,
  (newSrc, oldSrc) => {
    if (newSrc !== oldSrc) {
      isLoaded.value = false
      stopAnimation()
      // 若浏览器已命中强缓存并且图片已经完整，立即触发
      if (imgRef.value?.complete && imgRef.value.naturalWidth > 0 && props.autoReveal) {
        triggerReveal()
      }
    }
  }
)

onMounted(() => {
  isReducedMotion.value = checkReducedMotion()
  if (imgRef.value?.complete && imgRef.value.naturalWidth > 0 && props.autoReveal) {
    triggerReveal()
  }
})

onBeforeUnmount(() => {
  stopAnimation()
  offscreenCanvas = null
  offscreenCtx = null
  dropThresholds = null
})

defineExpose({
  triggerReveal,
})
</script>

<style scoped>
.cg-image-reveal {
  position: relative;
  display: block;
  overflow: hidden;
  border-radius: inherit;
  background: var(--bg-deep, #181420);
}

.cg-image-target {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  transition: opacity var(--motion-hover, 160ms) var(--ease-out, ease-out);
}

.cg-image-reveal.is-revealing .cg-image-target {
  /* 揭示动效进行时，底层图片保持低透明度，由上层 canvas 的马赛克粒子流主导视觉 */
  opacity: 0.05;
}

.cg-image-reveal.is-loaded .cg-image-target {
  opacity: 1;
}

.cg-reveal-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 2;
  transition: opacity var(--motion-hover, 160ms) var(--ease-out, ease-out);
}

.cg-reveal-sweep {
  position: absolute;
  inset: -50%;
  pointer-events: none;
  z-index: 3;
  width: 200%;
  height: 200%;
  transform: translate3d(var(--sweep-p, -15%), var(--sweep-p, -15%), 0) rotate(-45deg);
  opacity: var(--sweep-opacity, 0);
  background: linear-gradient(
    90deg,
    transparent 42%,
    color-mix(in srgb, var(--accent, #F2A8BE) 35%, transparent) 48%,
    rgba(255, 255, 255, 0.75) 50%,
    color-mix(in srgb, var(--accent-violet, #B784F6) 40%, transparent) 52%,
    transparent 58%
  );
  filter: drop-shadow(0 0 16px var(--accent-glow, rgba(242, 168, 190, 0.4)));
  mix-blend-mode: screen;
}

@media (prefers-reduced-motion: reduce) {
  .cg-reveal-canvas,
  .cg-reveal-sweep {
    display: none !important;
  }

  .cg-image-target {
    transition: opacity var(--motion-control, 200ms) ease-out !important;
  }
}
</style>

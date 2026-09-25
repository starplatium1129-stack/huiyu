<template>
  <div
    class="border-beam-wrap"
    :class="{
      'is-active': active,
      'is-standalone': !hasSlotContent,
      [`variant-${colorVariant}`]: true,
      [`size-${size}`]: true,
    }"
  >
    <slot />

    <!-- 边框描边光轨：使用 CSS mask 镂空卡片内部，仅保留精确边缘 -->
    <div
      v-if="active"
      class="border-beam-track"
      :style="trackStyle"
      aria-hidden="true"
    >
      <div class="border-beam-ray" :style="rayStyle" />
    </div>

    <!-- 水晶漫射微光层 (Bloom)：柔化扩散光斑 -->
    <div
      v-if="active && glow && !isReducedMotion"
      class="border-beam-bloom"
      :style="bloomStyle"
      aria-hidden="true"
    >
      <div class="border-beam-ray" :style="rayStyle" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, useSlots } from 'vue'

const props = withDefaults(
  defineProps<{
    /** 是否激活流光 */
    active?: boolean
    /** 旋转一圈的时长 (秒) */
    duration?: number
    /** 光束描边线宽 (px) */
    borderWidth?: number
    /** 尺寸预设：sm (小按钮/徽章) | md (普通卡片/工位) | lg (主画室/大展示台) */
    size?: 'sm' | 'md' | 'lg'
    /** 色彩变体：dual (甜系樱花粉+薰衣草紫) | accent (纯粉) | violet (纯紫) | crystal (清亮白晶) */
    colorVariant?: 'dual' | 'accent' | 'violet' | 'crystal'
    /** 是否开启外部漫射微光 (Bloom) */
    glow?: boolean
    /** 自定义圆角 (如 '16px' 或 'inherit') */
    borderRadius?: string
  }>(),
  {
    active: true,
    duration: 3.6,
    borderWidth: 1.5,
    size: 'md',
    colorVariant: 'dual',
    glow: true,
    borderRadius: 'inherit',
  }
)

const slots = useSlots()
const hasSlotContent = computed(() => !!slots.default)
const isReducedMotion = ref(false)

function checkReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

onMounted(() => {
  isReducedMotion.value = checkReducedMotion()
})

const trackStyle = computed(() => ({
  '--beam-radius': props.borderRadius,
  '--beam-border-width': `${props.borderWidth}px`,
  '--beam-duration': `${props.duration}s`,
}))

const bloomStyle = computed(() => ({
  '--beam-radius': props.borderRadius,
  '--beam-duration': `${props.duration}s`,
}))

const rayGradient = computed(() => {
  // 根据不同变体选用二次元甜系色彩
  let gradient = ''
  switch (props.colorVariant) {
    case 'accent':
      gradient = `conic-gradient(
        from 0deg,
        transparent 0deg,
        transparent 55deg,
        color-mix(in srgb, var(--accent, #F2A8BE) 25%, transparent) 75deg,
        #ffffff 90deg,
        color-mix(in srgb, var(--accent, #F2A8BE) 80%, transparent) 105deg,
        transparent 125deg,
        transparent 360deg
      )`
      break
    case 'violet':
      gradient = `conic-gradient(
        from 0deg,
        transparent 0deg,
        transparent 55deg,
        color-mix(in srgb, var(--accent-violet, #B784F6) 25%, transparent) 75deg,
        #ffffff 90deg,
        color-mix(in srgb, var(--accent-violet, #B784F6) 80%, transparent) 105deg,
        transparent 125deg,
        transparent 360deg
      )`
      break
    case 'crystal':
      gradient = `conic-gradient(
        from 0deg,
        transparent 0deg,
        transparent 65deg,
        rgba(255, 255, 255, 0.2) 78deg,
        #ffffff 90deg,
        rgba(255, 255, 255, 0.3) 102deg,
        transparent 115deg,
        transparent 360deg
      )`
      break
    case 'dual':
    default:
      gradient = `conic-gradient(
        from 0deg,
        transparent 0deg,
        transparent 50deg,
        color-mix(in srgb, var(--accent, #F2A8BE) 35%, transparent) 70deg,
        #ffffff 90deg,
        color-mix(in srgb, var(--accent-violet, #B784F6) 75%, transparent) 110deg,
        transparent 130deg,
        transparent 360deg
      )`
      break
  }

  return gradient
})

const rayStyle = computed(() => ({ '--beam-gradient': rayGradient.value }))
</script>

<style scoped>
.border-beam-wrap {
  position: relative;
  border-radius: inherit;
}

.border-beam-wrap.is-standalone {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 2;
}

/* 描边轨道：使用 padding + mask-composite 剔除卡片内部，只保留边框自身 */
.border-beam-track {
  position: absolute;
  inset: 0;
  border-radius: var(--beam-radius, inherit);
  padding: var(--beam-border-width, 1.5px);
  pointer-events: none;
  overflow: hidden;
  box-sizing: border-box;
  z-index: 2;
  mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  mask-composite: exclude;
  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  opacity: 0.9;
  transition: opacity var(--motion-surface, 260ms) var(--ease-out, ease-out);
}

/* 柔光扩散层 */
.border-beam-bloom {
  position: absolute;
  inset: -2px;
  border-radius: var(--beam-radius, inherit);
  pointer-events: none;
  overflow: hidden;
  box-sizing: border-box;
  z-index: 1;
  opacity: 0.55;
  filter: blur(8px);
  mix-blend-mode: screen;
  transition: opacity var(--motion-surface, 260ms) var(--ease-out, ease-out);
}

.size-sm .border-beam-bloom {
  filter: blur(4px);
  opacity: 0.45;
}

.size-lg .border-beam-bloom {
  filter: blur(14px);
  opacity: 0.65;
}

/* 光束光斑（运行在合成器上的 transform: rotate，0 重排 0 重绘） */
.border-beam-ray {
  position: absolute;
  inset: -150%;
  background: var(--beam-gradient);
  transform-origin: center center;
  animation: border-beam-spin var(--beam-duration, 3.6s) linear infinite;
  will-change: transform;
}

@keyframes border-beam-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

/* 无障碍减弱动效降级：停止旋转，固定在 45 度的静态微反光 */
@media (prefers-reduced-motion: reduce) {
  .border-beam-ray {
    animation: none !important;
    transform: rotate(45deg) !important;
  }

  .border-beam-bloom {
    display: none !important;
  }

  .border-beam-track {
    opacity: 0.7 !important;
  }
}
</style>

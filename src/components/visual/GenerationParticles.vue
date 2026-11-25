<template>
  <div ref="surface" class="generation-particles" aria-hidden="true">
    <div ref="host" class="generation-particle-surface">
      <canvas ref="canvas"></canvas>
      <span class="generation-particle-palette"><i class="tone-pink"></i><i class="tone-cyan"></i><i class="tone-violet"></i><i class="tone-highlight"></i></span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useResizeObserver } from '@vueuse/core'
import { useVisualActivity } from '@/composables/useVisualActivity'
import { registerParticleFrame } from '@/utils/particleScheduler'
import { visibleGenerationPigment } from '@/utils/generationPalette'
import { generationOrbitPoint, generationOrbitPose } from '@/utils/generationOrbit'

const props = defineProps<{ progress: number | null; palette?: readonly string[] }>()
const host = ref<HTMLElement | null>(null)
const surface = ref<HTMLElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const { canPresent, canAnimate, lowEffects, appearanceRevision } = useVisualActivity(host)

interface DustMote {
  baseAngle: number
  radial: number
  tone: number
  phase: number
  size: number
  driftSpeed: number
  gathering: boolean
  sparkle: boolean
  shimmerSpeed: number
}

let motes: DustMote[] = []
const colors = ref<string[]>([])
let moteSprites: HTMLCanvasElement[] = []
let glowSprites: HTMLCanvasElement[] = []
let isLightTheme = false
let context: CanvasRenderingContext2D | null = null
let width = 0, height = 0, ratio = 1
let clock = 1500
let driftClock = 1.5
let rotation = .27
let concentration = props.progress ?? 0
let stopFrames: (() => void) | null = null

function hash(n: number) {
  const s = Math.sin(n * 127.13 + 19.7) * 43758.5453
  return s - Math.floor(s)
}

function stop() {
  stopFrames?.()
  stopFrames = null
}

function releaseSprites() {
  for (const sprite of moteSprites) sprite.width = sprite.height = 0
  for (const sprite of glowSprites) sprite.width = sprite.height = 0
  moteSprites = []
  glowSprites = []
}

function createSoftDotSprite(color: string) {
  const sprite = document.createElement('canvas')
  sprite.width = sprite.height = 16
  const paint = sprite.getContext('2d')
  if (paint) {
    // Matches the feathered circular edge of the WebGL2 clear-image dust motes.
    const dot = paint.createRadialGradient(8, 8, 0, 8, 8, 7.2)
    dot.addColorStop(0, color)
    dot.addColorStop(.56, color)
    dot.addColorStop(1, 'transparent')
    paint.fillStyle = dot
    paint.fillRect(0, 0, 16, 16)
  }
  return sprite
}

function createGlowSprite(color: string) {
  const sprite = document.createElement('canvas')
  sprite.width = sprite.height = 48
  const paint = sprite.getContext('2d')
  if (paint) {
    const glow = paint.createRadialGradient(24, 24, 0, 24, 24, 24)
    glow.addColorStop(0, color)
    glow.addColorStop(.42, color)
    glow.addColorStop(1, 'transparent')
    paint.fillStyle = glow
    paint.fillRect(0, 0, 48, 48)
  }
  return sprite
}

function preparePalette() {
  if (!canPresent.value || !host.value) return
  isLightTheme = host.value.closest('[data-theme]')?.getAttribute('data-theme') === 'light'
  colors.value = [...host.value.querySelectorAll<HTMLElement>('.generation-particle-palette i')].map(item => getComputedStyle(item).color)
  if (props.palette?.length === 3) {
    colors.value.splice(0, 3, ...props.palette.map(color => `rgb(${visibleGenerationPigment(color, isLightTheme)})`))
  }
  releaseSprites()
  moteSprites = colors.value.slice(0, 4).map(createSoftDotSprite)
  glowSprites = colors.value.slice(0, 3).map(createGlowSprite)
}

function resize([entry]: ResizeObserverEntry[]) {
  if (!host.value || !canvas.value) return
  const bounds = entry?.contentRect
  if (!bounds?.width || !bounds.height) return
  width = bounds.width; height = bounds.height
  // Spend resolution on the local effect, never stretch a stage-sized low-res bitmap.
  ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(600_000 / (width * height)))
  const pixelWidth = Math.round(width * ratio), pixelHeight = Math.round(height * ratio)
  if (canvas.value.width !== pixelWidth || canvas.value.height !== pixelHeight) {
    canvas.value.width = pixelWidth
    canvas.value.height = pixelHeight
  }
  context = canvas.value.getContext('2d')
  reconcile()
}

function prepareMotes() {
  const count = lowEffects.value ? 56 : 168
  if (motes.length === count) return
  motes = Array.from({ length: count }, (_, index) => {
    const s1 = hash(index + 1.3)
    const s2 = hash(index + 31.7)
    const s3 = hash(index + 73.1)
    const gathering = index % 5 < 2
    return {
      baseAngle: index * 2.39996323 + (index % 3) * 2.0943951,
      radial: Math.pow(s2, .72),
      tone: index % 3,
      phase: s3 * Math.PI * 2,
      size: gathering ? 1.15 + s1 * 1.45 : 1.05 + s1 * 1.65,
      driftSpeed: .11 + s1 * .09,
      gathering,
      sparkle: !gathering && s3 > .84,
      shimmerSpeed: .7 + s2 * 1.05,
    }
  })
}

function draw() {
  if (!context || !width || !height || moteSprites.length < 4) return
  const ctx = context, time = clock / 1000
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  ctx.clearRect(0, 0, width, height)
  const centerX = width / 2, centerY = height / 2
  const pose = snapshot()
  const { radius, formed, finishing } = pose

  // Soft atmospheric core breath built from cached glow sprites (no per-frame blur).
  if (!lowEffects.value && glowSprites.length === 3) {
    const breath = .88 + Math.sin(time * .65) * .12
    const mistRadius = radius * (.92 - finishing * .18) * breath
    const mistAlpha = (isLightTheme ? .042 : .082) * (.85 + formed * .25 + finishing * .18)
    for (let band = 0; band < 3; band++) {
      const driftAngle = time * .22 + band * 2.0943951
      const offsetX = Math.cos(driftAngle) * radius * .14
      const offsetY = Math.sin(driftAngle) * radius * .1
      ctx.globalAlpha = mistAlpha
      ctx.drawImage(
        glowSprites[band],
        centerX + offsetX - mistRadius,
        centerY + offsetY - mistRadius * .86,
        mistRadius * 2,
        mistRadius * 1.72,
      )
    }
  }

  for (const mote of motes) {
    let x = centerX, y = centerY, alpha = 1, drawSize = mote.size
    if (mote.gathering) {
      // Mirror of the clear-image breeze: soft dust wisps drift inward from the rim into the cloud.
      const cycle = (driftClock * mote.driftSpeed + mote.phase / (Math.PI * 2)) % 1
      const inward = 1 - Math.pow(1 - cycle, 1.72)
      const distance = radius * (1.46 - inward * 1.2)
      const arcAngle = mote.baseAngle + rotation * .55 + inward * .82
      const flutter = (1 - inward * .65) * 6.5
      x = centerX + Math.cos(arcAngle) * distance * 1.12 + Math.sin(time * .9 + mote.phase) * flutter
      y = centerY + Math.sin(arcAngle) * distance * .86 + Math.cos(time * .72 + mote.phase * 1.2) * flutter
      const fadeIn = Math.min(1, cycle / .22)
      const fadeOut = Math.min(1, (1 - cycle) / .24)
      alpha = fadeIn * fadeOut * (.48 + inward * .38)
      drawSize = mote.size * (.72 + Math.sin(cycle * Math.PI) * .45)
    } else {
      const swirl = rotation * (1.15 - mote.radial * .45) * (mote.tone === 1 ? -.72 : .92)
      const point = generationOrbitPoint(mote.baseAngle + swirl, mote.tone, pose, mote.radial, mote.phase)
      x = centerX + point.x
      y = centerY + point.y
      const shimmer = .56 + .34 * Math.sin(time * mote.shimmerSpeed + mote.phase) + finishing * .14
      const radialFade = 1 - mote.radial * .44
      alpha = Math.min(1, shimmer * radialFade * (.88 + formed * .16))
      drawSize = mote.size * (.86 + shimmer * .24)
    }

    if (alpha <= .01) continue
    if (!lowEffects.value && mote.sparkle) {
      const halo = drawSize * 3.4 + 2.2
      ctx.globalAlpha = alpha * (isLightTheme ? .11 : .18)
      ctx.drawImage(glowSprites[mote.tone], x - halo, y - halo, halo * 2, halo * 2)
    }
    const spread = drawSize * 1.35
    ctx.globalAlpha = alpha * (isLightTheme ? .86 : .94)
    ctx.drawImage(moteSprites[mote.tone], x - spread, y - spread, spread * 2, spread * 2)
    if (mote.sparkle) {
      const core = Math.max(.9, drawSize * .62)
      ctx.globalAlpha = alpha * (isLightTheme ? .55 : .78)
      ctx.drawImage(moteSprites[3], x - core, y - core, core * 2, core * 2)
    }
  }
  ctx.globalAlpha = 1
}

function snapshot() { return generationOrbitPose(width, height, concentration, clock / 1000, rotation) }
function setOpacity(opacity: number) {
  if (surface.value && surface.value.style.opacity !== String(opacity)) surface.value.style.opacity = String(opacity)
}
defineExpose({ snapshot, setOpacity })

function reconcile() {
  stop()
  if (!canPresent.value || !context) return
  prepareMotes()
  draw()
  if (canAnimate.value) stopFrames = registerParticleFrame((_now, delta = 0) => {
    clock += delta
    if (props.progress !== null) concentration += (props.progress - concentration) * (1 - Math.exp(-delta / 420))
    const step = delta / 1000
    driftClock += step * (1 + concentration * .65)
    rotation += step * (.14 + concentration * .24)
    draw()
  }, lowEffects.value ? 30 : 0)
}

useResizeObserver(host, resize)
watch([canPresent, canAnimate, lowEffects, appearanceRevision, () => props.palette], () => { preparePalette(); reconcile() }, { flush: 'post' })
watch(() => props.progress, progress => {
  if (!canAnimate.value && canPresent.value) {
    if (progress !== null) concentration = progress
    draw()
  }
}, { flush: 'post' })
onMounted(preparePalette)
onBeforeUnmount(() => {
  stop()
  releaseSprites()
  motes = []; context = null
  // Vue retains this DOM during the parent's leave transition. Keep its last
  // bitmap for the collapse/fade; the DOM releases it when that transition ends.
})
</script>

<style scoped>
.generation-particles { position:relative; isolation:isolate; width:100%; height:100%; pointer-events:none; }
.generation-particle-surface { position:relative; width:100%; height:100%; animation:generation-dust-arrival 420ms var(--ease-out) both; }
@keyframes generation-dust-arrival { from { opacity:0; } to { opacity:1; } }
:root:is([data-motion='reduce'],[data-motion='reduced']) .generation-particle-surface { animation:none; }
@media (prefers-reduced-motion:reduce) { :root:not([data-motion='full']) .generation-particle-surface { animation:none; } }
/* compositor-exempt: A bounded Canvas renders stardust depth; cached radial sprites avoid per-frame blur. */
.generation-particle-surface > canvas { position:relative; display:block; width:100%; height:100%; }
.generation-particle-palette { position:absolute; width:0; height:0; overflow:hidden; visibility:hidden; }
.tone-pink { color:var(--accent); }
.tone-cyan { color:var(--archive-cyan); }
.tone-violet { color:var(--accent-violet,var(--accent)); }
.tone-highlight { color:var(--text-primary); }
</style>

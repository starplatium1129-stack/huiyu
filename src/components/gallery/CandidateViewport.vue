<template>
  <div ref="stage" class="candidate-viewport" role="group" tabindex="0"
    :aria-label="`${title}对比画面，加减键缩放、方向键移动、Home 复位`"
    @wheel="wheel" @keydown="keydown" @dblclick="doubleClick" @blur="stopPan()"
    @pointerdown="startPan" @pointermove="pan" @pointerup="stopPan" @pointercancel="stopPan" @lostpointercapture="stopPan">
    <img v-if="imageRequest.src" v-show="imageState !== 'error'" :key="imageRequest.token" ref="image" :src="imageRequest.src" :data-attempt="imageRequest.token"
      :crossorigin="runtimeResourceCors()" :alt="title" draggable="false" @load="onLoad" @error="onError" />
    <div v-if="imageState !== 'ready' || error || loading" class="candidate-image-feedback">
      <p :role="loading || imageState === 'loading' ? 'status' : 'alert'">{{ loading || imageState === 'loading' ? '正在读取原图…' : error || '原图暂不可用，作品记录仍保留。' }}</p>
      <button v-if="!loading && imageState !== 'loading'" class="btn btn-ghost btn-sm" type="button" @pointerdown.stop @click.stop="retry">重新读取原图</button>
    </div>
  </div>
</template>
<script setup lang="ts">
import { onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, shallowRef, watch } from 'vue'
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'
import { clampCandidatePose, initialCandidatePose, type CandidatePose, type CandidateFit, type CandidateViewportState } from '@/composables/gallery/useCandidateViewport'
const props = defineProps<{ id: string | number; src: string; title: string; viewport: CandidateViewportState; loading: boolean; error: string; revision: number; active: boolean }>()
const emit = defineEmits<{ retry: [] }>()
const stage = ref<HTMLElement | null>(null), image = ref<HTMLImageElement | null>(null)
const imageRequest = shallowRef({ token: 0, src: '' }), imageState = ref<'empty' | 'loading' | 'ready' | 'error'>('empty')
let pose = initialCandidatePose(), fit: CandidateFit = { width: 0, height: 0 }
let width = 0, height = 0, naturalWidth = 0, naturalHeight = 0, viewActive = true
let observer: ResizeObserver | null = null, unbind: (() => void) | null = null
let drag: { pointer: number; x: number; y: number; width: number; height: number; pose: CandidatePose } | null = null
let pendingPose: CandidatePose | null = null, panFrame = 0
function paint(value: CandidatePose) {
  pose = clampCandidatePose(value, fit)
  if (image.value) image.value.style.transform = `translate(${pose.x * 100}%,${pose.y * 100}%) scale(${pose.scale})`
  const zoomed = String(imageState.value === 'ready' && pose.scale > 1)
  if (stage.value && stage.value.dataset.zoomed !== zoomed) stage.value.dataset.zoomed = zoomed
}
function fitImage() {
  const ratio = width && height && naturalWidth && naturalHeight ? Math.min(width / naturalWidth, height / naturalHeight) : 0
  fit = ratio ? { width: naturalWidth * ratio / width, height: naturalHeight * ratio / height } : { width: 0, height: 0 }
  paint(props.viewport.poseFor(props.id))
}
function measure(nextWidth: number, nextHeight: number) {
  if (nextWidth === width && nextHeight === height) return
  stopPan(); width = nextWidth; height = nextHeight; fitImage()
}
function requestSource(src: string) {
  const resolved = resolveRuntimeUrl(src)
  if (!props.revision || /^(data:|blob:)/.test(resolved)) return resolved
  try { const url = new URL(resolved, location.href); url.searchParams.set('_imageRetry', String(props.revision)); return url.href }
  catch { return resolved }
}
function currentImage(event: Event): event is Event & { target: HTMLImageElement } {
  const target = event.target
  return props.active && viewActive && target instanceof HTMLImageElement && target === image.value
    && target.dataset.attempt === String(imageRequest.value.token) && target.getAttribute('src') === imageRequest.value.src
}
function onLoad(event: Event) {
  if (!currentImage(event)) return
  naturalWidth = event.target.naturalWidth; naturalHeight = event.target.naturalHeight
  imageState.value = 'ready'; fitImage()
}
function onError(event: Event) {
  if (!currentImage(event)) return
  stopPan(); imageState.value = 'error'; paint(props.viewport.poseFor(props.id))
}
function retry() {
  stage.value?.focus({ preventScroll: true })
  emit('retry')
}
function commit(value: CandidatePose) { props.viewport.update(props.id, clampCandidatePose(value, fit)) }
function zoom(scale: number, anchor = { x: 0, y: 0 }) {
  stopPan()
  const next = Math.min(4, Math.max(1, scale)), ratio = next / pose.scale
  commit({ scale: next, x: anchor.x - (anchor.x - pose.x) * ratio, y: anchor.y - (anchor.y - pose.y) * ratio })
}
function wheel(event: WheelEvent) {
  if (imageState.value !== 'ready' || !event.deltaY || !props.active) return
  const box = stage.value?.getBoundingClientRect()
  if (!box?.width || !box.height) return
  event.preventDefault()
  zoom(pose.scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15), { x: (event.clientX - box.left) / box.width - .5, y: (event.clientY - box.top) / box.height - .5 })
}
function doubleClick(event: MouseEvent) {
  if (imageState.value === 'ready' && (event.target === stage.value || event.target === image.value)) zoom(pose.scale > 1 ? 1 : 2)
}
function keydown(event: KeyboardEvent) {
  if (event.target !== stage.value || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.keyCode === 229) return
  if (event.key === 'Escape' && drag) { stopPan(); event.preventDefault(); event.stopPropagation(); return }
  if (imageState.value !== 'ready') return
  if (['+', '=', '-', '_', 'Home'].includes(event.key) || pose.scale > 1 && event.key.startsWith('Arrow')) event.preventDefault()
  if (event.key === '+' || event.key === '=') zoom(pose.scale * 1.25)
  else if (event.key === '-' || event.key === '_') zoom(pose.scale / 1.25)
  else if (event.key === 'Home') { stopPan(); commit(initialCandidatePose()) }
  else if (pose.scale > 1 && event.key.startsWith('Arrow')) { stopPan(); commit({ ...pose,
    x: pose.x + (event.key === 'ArrowLeft' ? -.08 : event.key === 'ArrowRight' ? .08 : 0),
    y: pose.y + (event.key === 'ArrowUp' ? -.08 : event.key === 'ArrowDown' ? .08 : 0) }) }
}
function startPan(event: PointerEvent) {
  if (drag || event.button !== 0 || !event.isPrimary || imageState.value !== 'ready' || !props.active
    || event.target !== stage.value && event.target !== image.value) return
  stage.value?.focus({ preventScroll: true })
  if (pose.scale <= 1) return
  const box = stage.value?.getBoundingClientRect()
  if (!box?.width || !box.height) return
  drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, width: box.width, height: box.height, pose: { ...pose } }
  try { stage.value?.setPointerCapture(event.pointerId) } catch { stopPan(); return }
  event.preventDefault()
}
function pan(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.pointer) return
  pendingPose = { ...drag.pose, x: drag.pose.x + (event.clientX - drag.x) / drag.width, y: drag.pose.y + (event.clientY - drag.y) / drag.height }
  // One pointer can move all four previews; share its latest sample per painted frame.
  if (!panFrame) panFrame = requestAnimationFrame(flushPan)
}
function flushPan() {
  cancelAnimationFrame(panFrame); panFrame = 0
  const pending = pendingPose; pendingPose = null
  if (pending) commit(pending)
}
function stopPan(event?: PointerEvent) {
  if (event && drag && event.pointerId !== drag.pointer) return
  if (event?.type === 'pointerup') pan(event)
  const pointer = drag?.pointer
  drag = null
  flushPan()
  if (pointer !== undefined && stage.value?.hasPointerCapture(pointer)) stage.value.releasePointerCapture(pointer)
}
function hidden() { if (document.hidden) stopPan() }
function activate() {
  if (!props.active || !viewActive || unbind || !stage.value) return
  unbind = props.viewport.bind(props.id, paint)
  measure(stage.value.clientWidth, stage.value.clientHeight)
  const currentObserver = new ResizeObserver(entries => {
    if (observer !== currentObserver || !viewActive || !props.active) return
    const bounds = entries[0]?.contentRect
    if (bounds) measure(bounds.width, bounds.height)
  })
  observer = currentObserver
  observer.observe(stage.value)
  window.addEventListener('blur', stopOnBlur)
  document.addEventListener('visibilitychange', hidden)
  // A cached image can finish while this native dialog is closed.
  const picture = image.value
  if (picture?.complete && picture.dataset.attempt === String(imageRequest.value.token) && picture.getAttribute('src') === imageRequest.value.src) {
    if (picture.naturalWidth) {
      naturalWidth = picture.naturalWidth; naturalHeight = picture.naturalHeight
      imageState.value = 'ready'; fitImage()
    } else imageState.value = 'error'
  }
}
function stopOnBlur() { stopPan() }
function deactivate() {
  stopPan(); observer?.disconnect(); observer = null; unbind?.(); unbind = null
  window.removeEventListener('blur', stopOnBlur)
  document.removeEventListener('visibilitychange', hidden)
}
watch(() => [props.src, props.revision] as const, () => {
  stopPan(); imageState.value = props.src ? 'loading' : 'empty'
  imageRequest.value = { token: imageRequest.value.token + 1, src: props.src ? requestSource(props.src) : '' }
}, { immediate: true })
watch(image, () => { paint(props.viewport.poseFor(props.id)) }, { flush: 'post' })
watch(() => props.active, active => { if (active) activate(); else deactivate() })
onMounted(activate)
onActivated(() => { viewActive = true; activate() })
onDeactivated(() => { viewActive = false; deactivate() })
onBeforeUnmount(() => { viewActive = false; deactivate() })
</script>
<style scoped>
@reference "../../assets/css/tailwind.css";
.candidate-viewport { @apply tw:relative tw:flex tw:items-center tw:justify-center tw:rounded-md tw:overflow-hidden tw:text-secondary tw:text-label tw:select-none; height:min(48dvh,480px); background:var(--bg-base); touch-action:none; cursor:zoom-in; }
.candidate-viewport[data-zoomed="true"] { cursor:grab; }
.candidate-viewport[data-zoomed="true"]:active { cursor:grabbing; }
.candidate-viewport img { @apply tw:block tw:w-full tw:h-full tw:object-contain; }
.candidate-viewport:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.candidate-image-feedback { position:absolute; inset:auto var(--s-3) var(--s-3); display:grid; justify-items:start; gap:var(--s-2); padding:var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-elevated); color:var(--text-primary); cursor:default; }
.candidate-image-feedback p { margin:0; }
@media (forced-colors:active) { .candidate-viewport:focus-visible { outline:2px solid Highlight; outline-offset:2px; } }
</style>

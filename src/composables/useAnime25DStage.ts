import { computed, onBeforeUnmount, onMounted, ref, type Ref } from 'vue'
import { loadAnimeRenderer, parseAnimePsd } from '@/anime25d/loader'
import { readAnimeCalibration, readAnimeModel, writeAnimeModel, type AnimeModel } from '@/anime25d/modelStore'
import { useAnimeCalibration } from './useAnimeCalibration'
import type { AnimeRenderer } from '@/anime25d/types'
import type { AnimePerformance } from '@/anime25d/performance'
import { ANIME_EXPRESSIONS, ANIME_MOTIONS } from '@/anime25d/capabilities'
import { listenMotionChanges, prefersReducedMotion } from '@/utils/motionPreference'

export function useAnime25DStage(characterId: () => string, host: Ref<HTMLElement | undefined>) {
  const selected = ref(false), ready = ref(false), busy = ref(false), restoring = ref(false)
  const modelName = ref(''), status = ref(''), error = ref('')
  const warnings = ref<string[]>([])
  let renderer: AnimeRenderer | undefined, controller: AbortController | undefined
  let performance: AnimePerformance | undefined
  const calibration = useAnimeCalibration(value => renderer?.calibrate(value))
  let focus: { width: number; height: number; x: number; y: number } | undefined
  let faceBounds: { x0: number; x1: number; y0: number; y1: number } | undefined
  let saved: AnimeModel | null = null, rendererCanvas: HTMLCanvasElement | undefined
  let generation = 0, restoreRequest = 0, alive = true, frame = 0, lastFrame = 0, elapsed = 0
  let mouth = 0, gazeX = 0, gazeY = 0, visible = true, battery = false
  let gazeChangedAt = -Infinity, emotion = 'neutral', presence = 'available', speaking = false
  let mouthPreviewUntil = 0
  const active = computed(() => selected.value && ready.value)
  function stop() { cancelAnimationFrame(frame); frame = 0; lastFrame = 0 }
  function dispose() {
    stop(); ready.value = false
    rendererCanvas?.removeEventListener('webglcontextlost', contextLost)
    renderer?.destroy(); renderer = undefined; rendererCanvas?.remove(); rendererCanvas = undefined
    performance = undefined
    mouthPreviewUntil = 0
    calibration.clear()
    focus = undefined
    faceBounds = undefined
  }
  function fail(reason: unknown) {
    dispose(); selected.value = false
    error.value = reason instanceof Error ? reason.message : String(reason)
  }
  function tick(now: number) {
    frame = 0
    if (!renderer || !performance || !visible || document.hidden) return
    const interval = battery || prefersReducedMotion() ? 1000 / 30 : 1000 / 60
    if (!lastFrame || now - lastFrame >= interval - 1) {
      const dt = lastFrame ? Math.min(.05, (now - lastFrame) / 1000) : 1 / 60
      elapsed += dt
      lastFrame = now
      const reduced = prefersReducedMotion()
      try {
        const previewMouth = !speaking && elapsed < mouthPreviewUntil ? .5 + .5 * Math.sin(elapsed * 12) : mouth
        const pose = performance.sample({ time: elapsed, dt, mouth: previewMouth, gazeX, gazeY, reduced, presence,
          attention: clamp((6 - (elapsed - gazeChangedAt)) / 2) })
        renderer.render({ time: elapsed, pose, reduced })
        if (rendererCanvas && faceBounds) calibration.drawPreview(rendererCanvas, faceBounds, elapsed)
      }
      catch (reason) { fail(reason); return }
    }
    frame = requestAnimationFrame(tick)
  }
  function resume() {
    stop()
    if (renderer && visible && !document.hidden) frame = requestAnimationFrame(tick)
  }
  function cancel() {
    generation++; controller?.abort(); controller = undefined; busy.value = false
    status.value = ''
  }
  async function load(model: AnimeModel, persist: boolean) {
    cancel()
    const ticket = generation, id = characterId()
    const abort = new AbortController(); controller = abort
    busy.value = true; error.value = ''; status.value = '正在读取 PSD…'
    let next: AnimeRenderer | undefined
    const current = () => alive && generation === ticket && characterId() === id
    try {
      const parsed = await parseAnimePsd(model.file, abort.signal, text => { if (current()) status.value = text })
      const [performanceModule, , corrections] = await Promise.all([
        import('@/anime25d/performance'), loadAnimeRenderer(), readAnimeCalibration(parsed.fingerprint),
      ])
      if (!current() || !host.value) return
      const nextCanvas = document.createElement('canvas')
      next = window.HuiyuAnime25D!.create(nextCanvas, parsed)
      next.calibrate(corrections)
      const nextPerformance = performanceModule.createAnimePerformance(model.name)
      nextPerformance.setEmotion(emotion); nextPerformance.setSpeaking(speaking)
      // Draw before accepting the import, so unsupported GPU/masks keep the old model.
      next.render({ time: 0, pose: nextPerformance.sample({ time: 0, dt: 0, mouth: 0, gazeX: 0, gazeY: 0, attention: 0, reduced: true, presence }), reduced: true })
      if (persist) await writeAnimeModel(id, model)
      if (!current()) { next.destroy(); next = undefined; return }
      dispose(); renderer = next; next = undefined; elapsed = 0
      performance = nextPerformance; gazeChangedAt = -Infinity
      calibration.attach(parsed.fingerprint, corrections)
      focus = { width: parsed.canvas.w, height: parsed.canvas.h, x: parsed.anchors.face.cx, y: parsed.anchors.face.cy }
      faceBounds = { ...parsed.anchors.face }
      rendererCanvas = nextCanvas; host.value.append(nextCanvas)
      nextCanvas.addEventListener('webglcontextlost', contextLost)
      saved = model; selected.value = true; ready.value = true
      modelName.value = model.name; warnings.value = [...parsed.warnings]
      status.value = `${parsed.layers.length} 个图层 · 2.5D 已加载`
      resume()
    } catch (reason) {
      next?.destroy()
      if (current() && !abort.signal.aborted) {
        error.value = reason instanceof Error ? reason.message : String(reason)
        status.value = ''
        if (!ready.value) selected.value = false
      }
    } finally { if (current()) { busy.value = false; controller = undefined } }
  }
  async function restore() {
    const request = ++restoreRequest
    restoring.value = true
    cancel(); dispose(); selected.value = false; saved = null; mouth = 0; gazeX = 0; gazeY = 0
    emotion = 'neutral'; speaking = false
    modelName.value = ''; warnings.value = []; error.value = ''
    const ticket = generation, id = characterId()
    try {
      const model = await readAnimeModel(id)
      if (!alive || ticket !== generation || id !== characterId()) return
      saved = model; modelName.value = model?.name || ''
      if (model?.enabled) await load(model, false)
    } catch (reason) { if (alive && ticket === generation) fail(reason) }
    finally { if (alive && request === restoreRequest) restoring.value = false }
  }
  async function importFile(file: File) {
    if (busy.value) return
    await load({ characterId: characterId(), file, name: file.name, enabled: true }, true)
  }
  async function useOriginal() {
    cancel()
    const model = saved, id = characterId(), ticket = generation
    try {
      if (model) await writeAnimeModel(id, { ...model, enabled: false })
      if (!alive || ticket !== generation) return
      saved = model ? { ...model, enabled: false } : null
      dispose(); selected.value = false; status.value = ''; error.value = ''
    } catch (reason) { if (alive && ticket === generation) error.value = String(reason) }
  }
  async function retry() { if (saved && !busy.value) await load({ ...saved, enabled: true }, true) }
  async function remove() {
    cancel()
    const id = characterId(), ticket = generation
    try {
      await writeAnimeModel(id, null)
      if (!alive || ticket !== generation) return
      dispose(); selected.value = false; saved = null; modelName.value = ''; status.value = ''; error.value = ''; warnings.value = []
    } catch (reason) { if (alive && ticket === generation) error.value = String(reason) }
  }
  const clamp = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
  function setMouth(value: number) { mouth = clamp(value) }
  function setGlobalPointer(x: number, y: number, bounds: { x: number; y: number; width: number; height: number }) {
    if (!focus) return
    // Aim relative to the actual face within the contained PSD, rather than the
    // window centre (usually the torso of a full-body model).
    const scale = Math.min(bounds.width / focus.width, bounds.height / focus.height)
    const fx = (bounds.width - focus.width * scale) / 2 + focus.x * scale
    const fy = (bounds.height - focus.height * scale) / 2 + focus.y * scale
    const nx = Math.max(-1, Math.min(1, (x - bounds.x - fx) / Math.max(1, bounds.width * .45)))
    const ny = Math.max(-1, Math.min(1, (y - bounds.y - fy) / Math.max(1, bounds.height * .45)))
    if (Math.hypot(nx - gazeX, ny - gazeY) > .005) gazeChangedAt = elapsed
    gazeX = nx; gazeY = ny
  }
  function pointer(event: PointerEvent) {
    const bounds = host.value?.getBoundingClientRect()
    if (bounds) setGlobalPointer(event.clientX, event.clientY, bounds)
  }
  function touchHead(event: MouseEvent) {
    if (!active.value || event.defaultPrevented || event.button !== 0 || event.detail > 1 || !focus || !faceBounds) return
    const target = event.target instanceof Element ? event.target : null
    if (!target?.closest('.portrait-stage') || target.closest('button,a,input,textarea,select,summary,[role="button"]')) return
    const bounds = host.value?.getBoundingClientRect()
    if (!bounds) return
    const scale = Math.min(bounds.width / focus.width, bounds.height / focus.height)
    const x = (event.clientX - bounds.x - (bounds.width - focus.width * scale) / 2) / scale
    const y = (event.clientY - bounds.y - (bounds.height - focus.height * scale) / 2) / scale
    const width = faceBounds.x1 - faceBounds.x0, height = faceBounds.y1 - faceBounds.y0
    if (Math.abs(x - focus.x) <= width * .8 && y >= faceBounds.y0 - height * .8 && y <= faceBounds.y1) performance?.playMotion('headpat')
  }
  function contextLost(event: Event) {
    event.preventDefault()
    if (ready.value) fail(new Error('2.5D 图形上下文已丢失，可在角色外观中重新加载'))
  }
  let removeMotionListener: (() => void) | undefined
  onMounted(() => {
    removeMotionListener = listenMotionChanges(resume)
    window.addEventListener('pointermove', pointer, { passive: true })
    window.addEventListener('click', touchHead)
  })
  onBeforeUnmount(() => {
    alive = false; cancel(); dispose(); removeMotionListener?.()
    window.removeEventListener('pointermove', pointer)
    window.removeEventListener('click', touchHead)
  })
  return {
    selected, active, ready, busy, restoring, modelName, status, error, warnings, calibration, restore, importFile, cancel, useOriginal, retry, remove,
    expressions: ANIME_EXPRESSIONS, motions: ANIME_MOTIONS,
    previewMouth() { if (active.value && !speaking) mouthPreviewUntil = elapsed + 2.4 },
    setExpression: async (id: string) => performance?.setExpression(id) ?? false,
    playMotion(id: string) { performance?.playMotion(id) },
    setEmotion(value: string) { emotion = value; performance?.setEmotion(value) },
    setPresence(value: string) { presence = value },
    setAudioLevel(level: number, peak = level) { performance?.setAudioLevel(level, peak) },
    setMouth, setGlobalPointer,
    setSpeaking(value: boolean) { speaking = value; performance?.setSpeaking(value); if (!value) mouth = 0 },
    setVisible(value: boolean) { visible = value; resume() },
    setBattery(value: boolean) { battery = value; resume() },
    releasePointerFocus() { gazeChangedAt = -Infinity; gazeX = 0; gazeY = 0 },
  }
}

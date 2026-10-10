import { computed, onBeforeUnmount, onMounted, onActivated, onDeactivated, ref, watch, type Ref } from 'vue'

import { MaskTileHistory } from './maskTileHistory'

export interface InpaintMaskCanvasDeps {
  /** 弹窗是否打开（关闭时不响应撤销快捷键）。 */
  active: () => boolean
  /** Native masks keep full paint strength; preview transparency is CSS-only. */
  opaquePaint?: () => boolean
  /** 预览 <img> 元素（同步画布尺寸时读 naturalWidth/Height）。 */
  imageEl: Ref<HTMLImageElement | null>
  /** 检测到的目标画幅（优先于 naturalWidth，见 useInpaintImageSource）。 */
  resolution: () => { width: number; height: number } | null
}

/**
 * 局部换装弹窗「手绘遮罩引擎」（2026-08-22 自 AnimaInpaintModal 下沉）。
 *
 * 半透明白色笔触（ComfyUI 以亮度识别遮罩）、Shift/右键擦除
 * （destination-out）、pointer capture 跨元素连续笔划、坐标按
 * canvas/display 双比例换算、最多 20 步局部像素撤销栈（Ctrl+Z）、
 * Alt+滚轮调笔刷、自定义属性笔刷光标。toBlob 导出前做空遮罩检测。
 */
export function useInpaintMaskCanvas(deps: InpaintMaskCanvasDeps) {
  const maskCanvasEl = ref<HTMLCanvasElement | null>(null)
  // 2026-08-30 默认切「自动识别」（CLIPSeg）：手绘涂抹门槛高、涂不准是换装效果差的
  // 主因；自动识别按服装词圈区域贴合衣服轮廓。手绘仍可随时切回精确微调。
  const maskMode = ref<'auto' | 'paint'>('auto')
  const brushSize = ref(36)
  const history = new MaskTileHistory()
  const maskUndoCount = ref(0)
  const cursorVisible = ref(false)
  const cursorX = ref(0)
  const cursorY = ref(0)
  let attached = true
  let drawing = false
  let erase = false
  let lastMaskPoint: { x: number; y: number } | null = null

  // 自定义属性载体：笔刷光标样式规则留在 scoped CSS，内联只承载数据（style-debt 门禁约定）
  const brushCursorStyle = computed(() => ({
    '--cursor-x': `${cursorX.value}px`,
    '--cursor-y': `${cursorY.value}px`,
    '--brush-diameter': `${brushSize.value * 2}px`,
  }))

  function maskContext() {
    // Every stroke reads pixels for undo; choose a readback context at creation.
    return maskCanvasEl.value?.getContext('2d', { willReadFrequently: true }) ?? null
  }

  function clearMask() {
    stopMaskPaint()
    history.clear()
    maskUndoCount.value = 0
    const canvas = maskCanvasEl.value
    if (canvas) maskContext()?.clearRect(0, 0, canvas.width, canvas.height)
  }

  function undoMask() {
    const context = maskContext()
    if (!context) return
    stopMaskPaint()
    history.undo(context)
    maskUndoCount.value = history.strokes.length
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (!attached || !deps.active() || maskMode.value !== 'paint' || event.defaultPrevented
      || event.isComposing || event.keyCode === 229 || event.shiftKey || event.altKey
      || event.ctrlKey === event.metaKey || event.key.toLowerCase() !== 'z') return
    const target = event.target instanceof Element ? event.target : document.activeElement
    const dialog = maskCanvasEl.value?.closest('[role="dialog"], dialog')
    if (!target || !dialog || target.closest('[role="dialog"], [role="alertdialog"], dialog') !== dialog) return
    const editable = target.closest('[contenteditable]')
    if (target.closest('input, textarea, select, [inert], [hidden]') || editable && editable.getAttribute('contenteditable') !== 'false') return
    const nativeModal = document.querySelector('dialog:modal')
    if (nativeModal && !nativeModal.contains(dialog)) return
    event.preventDefault()
    undoMask()
  }

  function handleCanvasWheel(event: WheelEvent) {
    if (event.altKey && maskMode.value === 'paint') {
      event.preventDefault()
      const delta = event.deltaY < 0 ? 4 : -4
      brushSize.value = Math.max(8, Math.min(96, brushSize.value + delta))
    }
  }

  function syncMaskCanvas() {
    const image = deps.imageEl.value
    const canvas = maskCanvasEl.value
    if (!image || !canvas || !image.naturalWidth || !image.naturalHeight) return false
    canvas.width = deps.resolution()?.width ?? image.naturalWidth
    canvas.height = deps.resolution()?.height ?? image.naturalHeight
    clearMask()
    return true
  }

  function pointerPosition(event: PointerEvent): { x: number; y: number } | null {
    const canvas = maskCanvasEl.value
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    if (!rect.width || !rect.height) return null
    return {
      x: (event.clientX - rect.left) * (canvas.width / rect.width),
      y: (event.clientY - rect.top) * (canvas.height / rect.height),
    }
  }

  function drawMaskStroke(event: PointerEvent) {
    const canvas = maskCanvasEl.value
    const position = pointerPosition(event)
    if (!canvas || !position) return
    const context = maskContext()
    if (!context) return
    const rect = canvas.getBoundingClientRect()
    const radius = brushSize.value * (canvas.width / rect.width)
    // Include antialiasing fringe around the round cap and segment before drawing.
    const previous = lastMaskPoint ?? position
    history.capture(context,
      Math.min(previous.x, position.x) - radius - 2,
      Math.min(previous.y, position.y) - radius - 2,
      Math.max(previous.x, position.x) + radius + 2,
      Math.max(previous.y, position.y) + radius + 2)
    maskUndoCount.value = history.strokes.length
    context.globalCompositeOperation = erase ? 'destination-out' : 'source-over'
    context.fillStyle = deps.opaquePaint?.() ? 'white' : 'rgba(255, 255, 255, 0.72)'
    context.strokeStyle = context.fillStyle
    context.lineWidth = radius * 2
    context.lineCap = 'round'
    if (lastMaskPoint) {
      context.beginPath()
      context.moveTo(lastMaskPoint.x, lastMaskPoint.y)
      context.lineTo(position.x, position.y)
      context.stroke()
    } else {
      context.beginPath()
      context.arc(position.x, position.y, radius, 0, Math.PI * 2)
      context.fill()
    }
    lastMaskPoint = position
  }

  function startMaskPaint(event: PointerEvent) {
    if (maskMode.value !== 'paint' || drawing || !maskContext()) return
    maskCanvasEl.value?.focus({ preventScroll: true })
    history.begin()
    drawing = true
    erase = event.button === 2 || event.shiftKey
    lastMaskPoint = null
    event.currentTarget instanceof HTMLElement && event.currentTarget.setPointerCapture(event.pointerId)
    drawMaskStroke(event)
  }

  function updateCursor(event: PointerEvent) {
    const canvas = maskCanvasEl.value
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    cursorX.value = event.clientX - rect.left
    cursorY.value = event.clientY - rect.top
  }

  function continueMaskPaint(event: PointerEvent) {
    updateCursor(event)
    if (drawing) drawMaskStroke(event)
  }

  function stopMaskPaint() {
    history.end()
    drawing = false
    erase = false
    lastMaskPoint = null
  }

  watch(deps.active, active => {
    if (!active) { stopMaskPaint(); cursorVisible.value = false }
  }, { flush: 'sync' })

  /** 导出遮罩 PNG；空遮罩（全 0 alpha）返回 null，交由宿主提示先涂抹。 */
  async function maskBlob(): Promise<Blob | null> {
    if (maskMode.value !== 'paint' || !maskCanvasEl.value) return null
    const canvas = maskCanvasEl.value
    const context = maskContext()
    if (!context || !history.hasPaint(context)) return null
    return new Promise(resolve => canvas.toBlob(blob => resolve(blob), 'image/png'))
  }

  onMounted(() => {
    window.addEventListener('keydown', handleKeyDown)
  })

  onActivated(() => { attached = true; window.addEventListener('keydown', handleKeyDown) })
  onDeactivated(() => { attached = false; window.removeEventListener('keydown', handleKeyDown); stopMaskPaint() })

  onBeforeUnmount(() => {
    attached = false
    window.removeEventListener('keydown', handleKeyDown)
    stopMaskPaint()
    history.clear()
    maskUndoCount.value = 0
  })

  return {
    maskCanvasEl,
    maskMode,
    brushSize,
    cursorVisible,
    brushCursorStyle,
    /** 视图只需要步数，不持有像素快照。 */
    maskUndoCount,
    clearMask,
    undoMask,
    handleCanvasWheel,
    syncMaskCanvas,
    startMaskPaint,
    continueMaskPaint,
    stopMaskPaint,
    maskBlob,
  }
}

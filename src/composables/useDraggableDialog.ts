import { computed, nextTick, onBeforeUnmount, onMounted, ref, type Ref } from 'vue'

const DRAG_THRESHOLD_PX = 4
const VIEWPORT_PADDING_PX = 8

type DialogPosition = { left: number; top: number }
type DragSession = {
  pointerId: number
  startX: number
  startY: number
  originLeft: number
  originTop: number
  width: number
  height: number
  moved: boolean
}

function chromeTopInset() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--desktop-chrome-height')
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function clampDialogPosition(left: number, top: number, width: number, height: number): DialogPosition {
  const minLeft = VIEWPORT_PADDING_PX
  const maxLeft = Math.max(minLeft, window.innerWidth - width - VIEWPORT_PADDING_PX)
  const minTop = chromeTopInset() + VIEWPORT_PADDING_PX
  const maxTop = Math.max(minTop, window.innerHeight - height - VIEWPORT_PADDING_PX)
  return {
    left: Math.min(Math.max(left, minLeft), maxLeft),
    top: Math.min(Math.max(top, minTop), maxTop),
  }
}

/**
 * 为原生 `<dialog>` 提供标题栏指针拖拽、方向键微调、视口防出界钳制与双击/按钮居中复位。
 * 拖拽中仅更新 `translate3d` 避免每帧触发布局，释放后提交最终 `left`/`top`。
 */
export function useDraggableDialog(
  dialog: Ref<HTMLDialogElement | null>,
  header: Ref<HTMLElement | null>,
  handle: Ref<HTMLButtonElement | null>,
) {
  const position = ref<DialogPosition | null>(null)
  const dragDelta = ref({ x: 0, y: 0 })
  const isDragging = ref(false)
  const announcement = ref('')
  let session: DragSession | null = null
  let suppressBackdropUntil = 0
  let announcementTimer: number | undefined

  const dialogStyle = computed<Record<string, string>>(() => {
    if (!position.value) return {}
    const style: Record<string, string> = {
      left: `${Math.round(position.value.left)}px`,
      top: `${Math.round(position.value.top)}px`,
    }
    if (isDragging.value && (dragDelta.value.x || dragDelta.value.y)) {
      style.transform = `translate3d(${Math.round(dragDelta.value.x)}px, ${Math.round(dragDelta.value.y)}px, 0)`
    }
    return style
  })

  function announce(text: string) {
    announcement.value = ''
    window.clearTimeout(announcementTimer)
    void nextTick(() => {
      announcement.value = text
      announcementTimer = window.setTimeout(() => { announcement.value = '' }, 1000)
    })
  }

  function reset() {
    session = null
    isDragging.value = false
    dragDelta.value = { x: 0, y: 0 }
    position.value = null
  }

  function recenter() {
    reset()
    announce('预览窗口已居中')
  }

  function shouldIgnoreBackdropClick() {
    return isDragging.value || performance.now() < suppressBackdropUntil
  }

  function onPointerDown(event: PointerEvent) {
    if (event.button !== 0 || !dialog.value || !header.value) return
    const control = (event.target as HTMLElement | null)?.closest('button, input, select, textarea, a')
    if (control && control !== handle.value) return
    const rect = dialog.value.getBoundingClientRect()
    session = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originLeft: rect.left,
      originTop: rect.top,
      width: rect.width,
      height: rect.height,
      moved: false,
    }
    header.value.setPointerCapture(event.pointerId)
  }

  function onPointerMove(event: PointerEvent) {
    if (!session || event.pointerId !== session.pointerId) return
    const rawDx = event.clientX - session.startX
    const rawDy = event.clientY - session.startY
    if (!session.moved && Math.hypot(rawDx, rawDy) < DRAG_THRESHOLD_PX) return
    if (!session.moved) {
      session.moved = true
      isDragging.value = true
      if (!position.value) {
        position.value = clampDialogPosition(session.originLeft, session.originTop, session.width, session.height)
      }
    }
    const base = position.value ?? { left: session.originLeft, top: session.originTop }
    const clamped = clampDialogPosition(session.originLeft + rawDx, session.originTop + rawDy, session.width, session.height)
    dragDelta.value = { x: clamped.left - base.left, y: clamped.top - base.top }
  }

  function commitDrag() {
    if (!session) return
    const current = session
    session = null
    if (current.moved && position.value) {
      position.value = clampDialogPosition(
        position.value.left + dragDelta.value.x,
        position.value.top + dragDelta.value.y,
        current.width,
        current.height,
      )
      suppressBackdropUntil = performance.now() + 180
    }
    isDragging.value = false
    dragDelta.value = { x: 0, y: 0 }
  }

  function onPointerEnd(event: PointerEvent) {
    if (!session || event.pointerId !== session.pointerId) return
    if (header.value?.hasPointerCapture(event.pointerId)) {
      header.value.releasePointerCapture(event.pointerId)
    }
    commitDrag()
  }

  function onDoubleClick(event: MouseEvent) {
    const control = (event.target as HTMLElement | null)?.closest('button')
    if (control && control !== handle.value) return
    if (position.value) recenter()
  }

  function onHandleKeydown(event: KeyboardEvent) {
    if (!dialog.value?.open) return
    if (event.key === 'Home') {
      event.preventDefault()
      recenter()
      return
    }
    const step = event.shiftKey ? 64 : 24
    let dx = 0, dy = 0, label = ''
    if (event.key === 'ArrowLeft') { dx = -step; label = '预览窗口已向左移动' }
    else if (event.key === 'ArrowRight') { dx = step; label = '预览窗口已向右移动' }
    else if (event.key === 'ArrowUp') { dy = -step; label = '预览窗口已向上移动' }
    else if (event.key === 'ArrowDown') { dy = step; label = '预览窗口已向下移动' }
    else return
    event.preventDefault()
    const rect = dialog.value.getBoundingClientRect()
    position.value = clampDialogPosition(rect.left + dx, rect.top + dy, rect.width, rect.height)
    announce(label)
  }

  function onWindowResize() {
    if (!dialog.value?.open || !position.value) return
    const rect = dialog.value.getBoundingClientRect()
    position.value = clampDialogPosition(position.value.left, position.value.top, rect.width, rect.height)
  }

  onMounted(() => window.addEventListener('resize', onWindowResize))
  onBeforeUnmount(() => {
    window.removeEventListener('resize', onWindowResize)
    window.clearTimeout(announcementTimer)
  })

  return {
    position,
    isDragging,
    announcement,
    dialogStyle,
    reset,
    recenter,
    shouldIgnoreBackdropClick,
    onPointerDown,
    onPointerMove,
    onPointerEnd,
    onLostCapture: commitDrag,
    onDoubleClick,
    onHandleKeydown,
  }
}

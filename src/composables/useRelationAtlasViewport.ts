import { nextTick, onScopeDispose, watch, type Ref } from 'vue'
import type { ViewportTransform } from '@vue-flow/core'

type CanvasSize = { width: number; height: number }

/** Each atlas view owns its camera; opening a description never changes that view. */
export function useRelationAtlasViewport(input: {
  view: Ref<string>; size: Ref<CanvasSize>; get: () => ViewportTransform
  set: (viewport: ViewportTransform, animate?: boolean) => Promise<boolean>; frame: () => void
}) {
  const cameras = new Map<string, { viewport: ViewportTransform; size: CanvasSize }>()
  let ready = false, changing = false, revision = 0
  let currentView = input.view.value, currentSize = { ...input.size.value }

  function remember() {
    if (ready && currentSize.width && currentSize.height) {
      cameras.set(currentView, { viewport: { ...input.get() }, size: { ...currentSize } })
    }
  }
  function resizeCamera(viewport: ViewportTransform, previous: CanvasSize, size: CanvasSize) {
    return { ...viewport, x: viewport.x + (size.width - previous.width) / 2, y: viewport.y + (size.height - previous.height) / 2 }
  }
  async function restore() {
    const ticket = ++revision
    changing = true
    await nextTick()
    if (!ready || ticket !== revision) return
    currentView = input.view.value; currentSize = { ...input.size.value }
    const saved = cameras.get(currentView)
    if (saved) await input.set(resizeCamera(saved.viewport, saved.size, currentSize))
    else input.frame()
    if (ticket === revision) changing = false
  }
  function initialize() {
    if (ready) return
    ready = true
    void restore()
  }
  function reframe(viewport?: ViewportTransform) {
    revision++; changing = false
    currentView = input.view.value; currentSize = { ...input.size.value }
    cameras.delete(currentView)
    if (viewport) void input.set(viewport, true)
    else input.frame()
  }
  watch(input.view, () => {
    remember()
    if (ready) void restore()
  }, { flush: 'pre' })
  watch(input.size, size => {
    if (!ready || changing || !size.width || !size.height) return
    if (currentSize.width && currentSize.height) void input.set(resizeCamera(input.get(), currentSize, size))
    currentSize = { ...size }
  }, { flush: 'post' })
  onScopeDispose(() => { ready = false; revision++; cameras.clear() })
  return { initialize, reframe }
}

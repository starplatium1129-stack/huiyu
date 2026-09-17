import { afterEach, expect, it, vi } from 'vitest'
import { captureScrollAnchor, restoreScrollAnchor, watchForUserScroll } from './scrollAnchor'

/**
 * 原语的语义要点（009 F3.2）：
 *  1) 文档已经够高就立刻落到锚点；
 *  2) 文档还不够高时逐帧重试，长回来再落，超时放弃；
 *  3) 两路并存的恢复互不干扰 —— 场景库筛选期间会写 URL 触发导航，
 *     共享一个取消槽时路由的取消会把筛选那一路一起干掉（实测回归）。
 */

const state = { scrollX: 0, scrollY: 0, scrollHeight: 4000, innerHeight: 1000 }
const frames: FrameRequestCallback[] = []
let now = 0
const originalAnimationFrame = window.requestAnimationFrame
const originalCancelAnimationFrame = window.cancelAnimationFrame
const originalScrollTo = window.scrollTo

function setup() {
  Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => state.innerHeight })
  Object.defineProperty(window, 'scrollX', { configurable: true, get: () => state.scrollX })
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => state.scrollY })
  Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, get: () => state.scrollHeight })
  window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  }) as typeof window.requestAnimationFrame
  window.cancelAnimationFrame = ((handle: number) => {
    frames[handle - 1] = () => undefined
  }) as typeof window.cancelAnimationFrame
  window.scrollTo = ((x: number, y: number) => {
    state.scrollX = x
    state.scrollY = y
  }) as typeof window.scrollTo
  vi.spyOn(performance, 'now').mockImplementation(() => now)
}

function runFrame() {
  for (const callback of frames.splice(0, frames.length)) callback(now)
}

afterEach(() => {
  frames.length = 0
  now = 0
  state.scrollX = 0
  state.scrollY = 0
  state.scrollHeight = 4000
  state.innerHeight = 1000
  vi.restoreAllMocks()
  window.requestAnimationFrame = originalAnimationFrame
  window.cancelAnimationFrame = originalCancelAnimationFrame
  window.scrollTo = originalScrollTo
})

it('restores the anchor on the next frame when the document is tall enough', () => {
  setup()
  state.scrollY = 700
  const anchor = captureScrollAnchor()
  state.scrollY = 0
  restoreScrollAnchor(anchor!)
  runFrame()
  expect(state.scrollY).toBe(700)
})

it('retries while the document is short, then lands once it grows back', () => {
  setup()
  state.scrollY = 1400
  const anchor = captureScrollAnchor()
  state.scrollY = 0
  state.scrollHeight = 2000
  restoreScrollAnchor(anchor!, { timeoutMs: 500 })
  runFrame()
  expect(state.scrollY).toBe(0)
  now = 100
  state.scrollHeight = 4000
  runFrame()
  expect(state.scrollY).toBe(1400)
})

it('gives up after the timeout instead of holding the position forever', () => {
  setup()
  state.scrollY = 1400
  const anchor = captureScrollAnchor()
  state.scrollY = 0
  state.scrollHeight = 2000
  restoreScrollAnchor(anchor!, { timeoutMs: 100 })
  runFrame()
  now = 150
  runFrame()
  expect(state.scrollY).toBe(1000)
})

it('keeps two concurrent restores independent', () => {
  setup()
  state.scrollY = 700
  const first = captureScrollAnchor()
  state.scrollY = 0
  const cancelFirst = restoreScrollAnchor(first!, { shouldContinue: () => true })
  state.scrollY = 300
  const second = captureScrollAnchor()
  state.scrollY = 0
  restoreScrollAnchor(second!, { shouldContinue: () => true })

  cancelFirst()
  runFrame()
  expect(state.scrollY).toBe(300)
})

it('reports user scroll gestures but ignores typing in a field', () => {
  setup()
  const onUserScroll = vi.fn()
  const stop = watchForUserScroll(onUserScroll)
  const input = document.createElement('input')
  document.body.append(input)
  try {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(onUserScroll).not.toHaveBeenCalled()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown' }))
    expect(onUserScroll).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'End' }))
    expect(onUserScroll).toHaveBeenCalledTimes(1)
  } finally {
    stop()
    input.remove()
  }
})

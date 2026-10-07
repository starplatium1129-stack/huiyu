import assert from 'node:assert/strict'
import { vi } from 'vitest'

export class AnimationStub {
  onfinish: (() => void) | null = null
  oncancel: (() => void) | null = null
  effect: object | null = {}
  cancelCalls = 0
  cancelThrows = false
  cancel() {
    this.cancelCalls++
    if (this.cancelThrows) throw new Error('optional animation cancellation unavailable')
  }
}

export function surface(path = '/gallery') {
  const animations: AnimationStub[] = []
  const calls: unknown[][] = []
  const el = {
    dataset: { routePath: path },
    querySelectorAll: () => [],
    inert: true,
    animate: (...args: unknown[]) => {
      calls.push(args)
      const animation = new AnimationStub()
      animations.push(animation)
      return animation
    },
  } as unknown as HTMLElement
  return { el, animations, calls }
}

export function mediaQuery(mode: 'modern' | 'legacy' | 'none' = 'modern') {
  const listeners = new Set<() => void>()
  const add = (callback: () => void) => { listeners.add(callback) }
  const remove = (callback: () => void) => { listeners.delete(callback) }
  return {
    listeners,
    emit: () => { for (const callback of [...listeners]) callback() },
    ...(mode === 'modern' ? {
      addEventListener: (event: string, callback: () => void) => { assert.equal(event, 'change'); add(callback) },
      removeEventListener: (event: string, callback: () => void) => { assert.equal(event, 'change'); remove(callback) },
    } : mode === 'legacy' ? { addListener: add, removeListener: remove } : {}),
  }
}

export function browser(media: ReturnType<typeof mediaQuery> | null = mediaQuery()) {
  const events = new EventTarget()
  const matchMedia = media ? (query: string) => {
    assert.equal(query, '(prefers-reduced-motion: reduce)')
    return media
  } : undefined
  vi.stubGlobal('window', Object.assign(events, { matchMedia }))
  vi.stubGlobal('matchMedia', matchMedia)
  return events
}

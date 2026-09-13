import { describe, expect, it } from 'vitest'
import { effectScope, ref } from 'vue'
import { usePortraitFallback, type PortraitSources } from './usePortraitFallback'

function setup() {
  const source = ref<PortraitSources>({ id: 'a', main: 'main-a', thumb: 'thumb-a' })
  const scope = effectScope()
  const state = scope.run(() => usePortraitFallback(source))!
  return { source, state, stop: () => scope.stop() }
}

describe('portrait fallback attempts', () => {
  it('tries each source once and declares success only after decoding', () => {
    const { state, stop } = setup()
    state.fail(state.view.value.token)
    expect(state.view.value.state).toBe('fallback')
    expect(state.isLoaded.value).toBe(false)
    state.loaded(state.view.value.token, 0, 0)
    expect(state.isLoaded.value).toBe(false)
    state.loaded(state.view.value.token, 300, 600)
    expect(state.isLoaded.value).toBe(true)
    expect(state.ratio.value).toBe(0.5)
    state.fail(state.view.value.token)
    expect(state.view.value.state).toBe('missing')
    state.fail(state.view.value.token)
    expect(state.view.value.state).toBe('missing')
    stop()
  })

  it('resets the same instance for A to B to A and ignores old events', () => {
    const { source, state, stop } = setup()
    const oldMain = state.view.value.token
    state.fail(oldMain)
    const oldThumb = state.view.value.token
    state.fail(oldThumb)
    source.value = { ...source.value, main: 'main-b' }
    expect(state.view.value.src).toBe('main-b')
    state.fail(state.view.value.token)
    expect(state.view.value.src).toBe('thumb-a')
    source.value = { ...source.value, main: 'main-a' }
    state.fail(oldMain)
    state.loaded(oldThumb, 100, 1)
    expect(state.view.value.state).toBe('main')
    expect(state.ratio.value).toBe(0.7)
    expect(state.isLoaded.value).toBe(false)
    stop()
  })

  it('retries on role and thumbnail changes even with the same main URL', () => {
    const { source, state, stop } = setup()
    const old = state.view.value.token
    state.fail(old)
    source.value = { ...source.value, id: 'b' }
    expect(state.view.value.state).toBe('main')
    state.fail(old)
    expect(state.view.value.state).toBe('main')
    state.fail(state.view.value.token)
    state.fail(state.view.value.token)
    source.value = { ...source.value, thumb: 'thumb-b' }
    expect(state.view.value.state).toBe('main')
    state.fail(state.view.value.token)
    expect(state.view.value.src).toBe('thumb-b')
    stop()
  })

  it('does not repeat identical main and thumbnail URLs or invent sources', () => {
    const { source, state, stop } = setup()
    source.value = { id: 'a', main: 'same', thumb: 'same' }
    state.fail(state.view.value.token)
    expect(state.view.value.state).toBe('missing')
    source.value = { id: 'a', main: '', thumb: '' }
    expect(state.view.value.reason).toBe('empty')
    expect(state.view.value.state).toBe('missing')
    stop()
  })
})

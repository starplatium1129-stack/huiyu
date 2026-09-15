import { afterEach, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { installNavigationFeedback, useNavigationFeedback } from './useNavigationFeedback'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
let stop: (() => void) | undefined
afterEach(() => { stop?.(); vi.useRealTimers() })
async function setup() {
  vi.useFakeTimers()
  const first = deferred<object>(), second = deferred<object>()
  const firstStarted = deferred<void>(), secondStarted = deferred<void>()
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/', component: {} },
    { path: '/fast', component: {} },
    { path: '/first', component: () => { firstStarted.resolve(); return first.promise } },
    { path: '/second', component: () => { secondStarted.resolve(); return second.promise } },
  ] })
  stop = installNavigationFeedback(router)
  await router.push('/')
  return { router, first, second, firstStarted, secondStarted, ...useNavigationFeedback() }
}

it('keeps fast navigation quiet and reports a slow load until it resolves', async () => {
  const state = await setup()
  await state.router.push('/fast')
  await vi.advanceTimersByTimeAsync(200)
  expect(state.loading.value).toBe(false)
  const pending = state.router.push('/first')
  await state.firstStarted.promise
  expect(state.pendingPath.value).toBe('/first')
  await vi.advanceTimersByTimeAsync(179)
  expect(state.loading.value).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(state.loading.value).toBe(true)
  state.first.resolve({})
  await pending
  expect(state.loading.value).toBe(false)
  expect(state.pendingPath.value).toBe('')
})

it('does not let an older cancelled navigation hide a newer pending route', async () => {
  const state = await setup()
  const older = state.router.push('/first')
  await state.firstStarted.promise
  const newer = state.router.push('/second')
  await state.secondStarted.promise
  await vi.advanceTimersByTimeAsync(200)
  state.first.resolve({})
  await older
  expect(state.pendingPath.value).toBe('/second')
  expect(state.loading.value).toBe(true)
  state.second.resolve({})
  await newer
  expect(state.loading.value).toBe(false)
})

it('clears feedback on failure without changing the current page', async () => {
  const state = await setup()
  const pending = state.router.push('/first').catch(error => error)
  await state.firstStarted.promise
  await vi.advanceTimersByTimeAsync(200)
  state.first.reject(new Error('offline'))
  expect(await pending).toBeInstanceOf(Error)
  expect(state.pendingPath.value).toBe('')
  expect(state.loading.value).toBe(false)
  expect(state.router.currentRoute.value.path).toBe('/')
})

it('returning to the current page cancels feedback for an unresolved destination', async () => {
  const state = await setup()
  const pending = state.router.push('/first')
  await state.firstStarted.promise
  await vi.advanceTimersByTimeAsync(200)
  await state.router.push('/')
  expect(state.loading.value).toBe(false)
  state.first.resolve({})
  await pending
  expect(state.router.currentRoute.value.path).toBe('/')
})

it('an error from an older navigation does not dismiss the current loading feedback', async () => {
  const state = await setup()
  const older = state.router.push('/first').catch(error => error)
  await state.firstStarted.promise
  const newer = state.router.push('/second')
  await state.secondStarted.promise
  await vi.advanceTimersByTimeAsync(200)
  state.first.reject(new Error('old chunk failed'))
  await older
  expect(state.pendingPath.value).toBe('/second')
  expect(state.loading.value).toBe(true)
  state.second.resolve({})
  await newer
})

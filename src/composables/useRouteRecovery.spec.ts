import { expect, it } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { installRouteRecovery, routeRecovery } from './useRouteRecovery'

it('keeps the current route on failed navigation and clears recovery after success', async () => {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/', component: {} },
    { path: '/missing', component: () => Promise.reject(new Error('Failed to fetch dynamically imported module')) },
    { path: '/ready', component: {} },
  ] })
  installRouteRecovery(router)
  await router.push('/')
  await expect(router.push('/missing?return=1')).rejects.toThrow()
  expect(router.currentRoute.value.path).toBe('/')
  expect(routeRecovery.value?.target).toBe('/missing?return=1')
  await router.push('/ready')
  expect(routeRecovery.value).toBeNull()
})

it.each(['pending', 'opened', 'current'])('ignores a late failed import when the newer destination is %s', async state => {
  let fail!: (error: Error) => void
  const pending = new Promise<object>((_resolve, reject) => { fail = reject })
  let started!: () => void
  const loading = new Promise<void>(resolve => { started = resolve })
  let ready!: (component: object) => void
  const newerPage = new Promise<object>(resolve => { ready = resolve })
  let newerStarted!: () => void
  const newerLoading = new Promise<void>(resolve => { newerStarted = resolve })
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/', component: {} },
    { path: '/slow', component: () => { started(); return pending } },
    { path: '/ready', component: () => { newerStarted(); return newerPage } },
  ] })
  installRouteRecovery(router)
  await router.push('/')
  const older = router.push('/slow').catch(error => error)
  await loading
  const newer = router.push(state === 'current' ? '/' : '/ready')
  if (state === 'current') await newer
  else {
    await newerLoading
    if (state === 'opened') { ready({}); await newer }
  }
  fail(new Error('Late lazy import failure'))
  expect(await older).toBeInstanceOf(Error)
  expect(routeRecovery.value).toBeNull()
  ready({})
  await newer
  expect(router.currentRoute.value.path).toBe(state === 'current' ? '/' : '/ready')
  expect(routeRecovery.value).toBeNull()
})

import { afterEach, expect, it } from 'vitest'
import { effectScope, ref } from 'vue'
import { useRuntimeImage } from './useRuntimeImage'
import { setRuntimeOrigin } from '@/platform/runtimeUrl'

afterEach(() => setRuntimeOrigin(null, false))

it('retries after an epoch change on the same port, but not a repeated healthy handshake', () => {
  setRuntimeOrigin('http://127.0.0.1:3002', true, 'first')
  const scope = effectScope(), resource = scope.run(() => useRuntimeImage('/a.webp'))!
  const first = resource.image.value.key
  setRuntimeOrigin('http://127.0.0.1:3002', true, 'first')
  expect(resource.image.value.key).toBe(first)
  setRuntimeOrigin('http://127.0.0.1:3002', true, 'second')
  expect(resource.image.value.key).toBeGreaterThan(first)
  expect(resource.src.value).toBe('http://127.0.0.1:3002/a.webp')
  scope.stop()
})

it('rejects events from an earlier attempt even when switching A to B to A', () => {
  const scope = effectScope(), source = ref('/a.webp')
  const resource = scope.run(() => useRuntimeImage(source))!
  const old = resource.image.value, img = document.createElement('img')
  img.setAttribute('src', old.src)
  img.setAttribute('data-image-attempt', old['data-image-attempt'])
  source.value = '/b.webp'; source.value = '/a.webp'
  const event = new Event('error')
  Object.defineProperty(event, 'target', { value: img })
  expect(old.onError(event)).toBe(false)
  expect(resource.failed.value).toBe(false)
  img.setAttribute('data-image-attempt', resource.image.value['data-image-attempt'])
  expect(resource.image.value.onError(event)).toBe(true)
  expect(resource.failed.value).toBe(true)
  resource.retry()
  expect(resource.failed.value).toBe(false)
  scope.stop()
})

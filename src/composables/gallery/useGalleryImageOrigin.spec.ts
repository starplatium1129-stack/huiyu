import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import type { ArtworkRecord } from '@/types/artwork'
import { useGalleryImageOrigin } from './useGalleryImageOrigin'

const flight = vi.hoisted(() => ({ capture: vi.fn(() => '/preview.png'), enter: vi.fn(), leave: vi.fn(), cancel: vi.fn() }))
vi.mock('@/composables/useImageOriginTransition', () => ({ useImageOriginTransition: () => flight }))
let wrapper: VueWrapper
let now = 0
beforeEach(() => { vi.clearAllMocks(); now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now) })
afterEach(() => { wrapper?.unmount(); document.body.innerHTML = ''; vi.restoreAllMocks() })

function setup() {
  const shell = document.createElement('div'), viewer = document.createElement('div')
  shell.innerHTML = '<article class="artwork" data-card-id="one"><button><img class="artwork-image" src="/preview.png"></button></article>'
  viewer.innerHTML = '<img class="zoomable-img" src="/preview.png">'
  document.body.append(shell, viewer)
  const image = viewer.querySelector('img')!
  Object.defineProperties(image, { complete: { value: false, configurable: true }, naturalWidth: { value: 0, configurable: true } })
  const viewerIndex = ref(-1), current = ref<ArtworkRecord | null>(null)
  let motion!: ReturnType<typeof useGalleryImageOrigin>
  wrapper = mount(defineComponent({ setup() {
    motion = useGalleryImageOrigin({ shellEl: ref(shell), viewerEl: ref(viewer), viewerIndex, viewerUrl: ref(''), current })
    return () => h('div')
  } }))
  const button = shell.querySelector('button')!
  button.addEventListener('click', motion.capture)
  button.click()
  current.value = { id: 'one' } as ArtworkRecord
  viewerIndex.value = 0
  function loaded() {
    Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 320 } })
    image.addEventListener('load', motion.loaded)
    image.dispatchEvent(new Event('load'))
  }
  return { motion, image, viewer, viewerIndex, current, loaded }
}

it('retains the card origin until the visible thumbnail loads within its bounded handoff', async () => {
  const env = setup()
  await env.motion.enter()
  expect(flight.enter).not.toHaveBeenCalled()
  now = 60
  env.loaded()
  await nextTick()
  expect(flight.enter).toHaveBeenCalledExactlyOnceWith(env.image, env.viewer)
  await env.motion.enter()
  expect(flight.enter).toHaveBeenCalledTimes(1)
})

it('does not start a late flight after the cold thumbnail misses the handoff', async () => {
  const env = setup()
  await env.motion.enter()
  now = 181
  env.loaded()
  await nextTick()
  expect(flight.enter).not.toHaveBeenCalled()
})

it('drops the captured preview when navigation replaces the selected artwork', async () => {
  const env = setup()
  await env.motion.enter()
  env.current.value = { id: 'two' } as ArtworkRecord
  env.loaded()
  await nextTick()
  expect(env.motion.previewSrc.value).toBe('')
  expect(flight.enter).not.toHaveBeenCalled()
  expect(flight.cancel).toHaveBeenCalled()
})

import { afterEach, expect, it } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { setRuntimeOrigin } from '@/platform/runtimeUrl'
import SceneCard from './SceneCard.vue'
import CharacterPortrait from './library/CharacterPortrait.vue'
import CgImageReveal from './visual/CgImageReveal.vue'

enableAutoUnmount(afterEach)
afterEach(() => setRuntimeOrigin(null, false))

it('loads scene thumbnails from the runtime without a shell-origin srcset override', async () => {
  setRuntimeOrigin(null, true)
  const card = mount(SceneCard, { props: { scene: { id: 'sc001' } } })
  expect(card.find('img').exists()).toBe(false)
  setRuntimeOrigin('http://127.0.0.1:3002', true)
  await nextTick()
  expect(card.get('img').attributes('src')).toBe('http://127.0.0.1:3002/scene-showcase/thumbs/sc001.jpg')
  expect(card.get('img').attributes('srcset')).toBeUndefined()
  expect(card.get('img').attributes('crossorigin')).toBe('anonymous')
  Object.defineProperties(card.get('img').element, { naturalWidth: { value: 320 }, naturalHeight: { value: 480 } })
  await card.get('img').trigger('load')
  expect(card.get('img').classes()).toContain('sc-thumb-ready')
})

it('retries the same portrait after runtime recovery without changing its source prop', async () => {
  setRuntimeOrigin('http://127.0.0.1:3002', true)
  const portrait = mount(CharacterPortrait, { props: { src: '/assets/characters/nene-official.webp', name: '宁宁' } })
  await portrait.get('img').trigger('error')
  expect(portrait.find('img').exists()).toBe(false)
  setRuntimeOrigin(null, true)
  await nextTick()
  setRuntimeOrigin('http://127.0.0.1:3002', true)
  await nextTick()
  expect(portrait.get('img').attributes('src')).toContain('/assets/characters/nene-official.webp')
})

it('accepts a loaded reveal image after resolving a relative URL to the desktop runtime', async () => {
  setRuntimeOrigin('http://127.0.0.1:3002', true)
  const reveal = mount(CgImageReveal, { props: { src: '/scene-showcase/images/sc001.jpg', autoReveal: false } })
  const img = reveal.get('img')
  Object.defineProperties(img.element, { complete: { value: true }, naturalWidth: { value: 1024 }, naturalHeight: { value: 1344 } })
  await img.trigger('load')
  expect(reveal.emitted('load')).toHaveLength(1)
  expect(reveal.classes()).toContain('is-loaded')
})

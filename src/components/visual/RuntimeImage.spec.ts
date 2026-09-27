import { afterEach, expect, it } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import RuntimeImage from './RuntimeImage.vue'
import { setRuntimeOrigin } from '@/platform/runtimeUrl'

enableAutoUnmount(afterEach)
afterEach(() => setRuntimeOrigin(null, false))

it('restores an ordinary image from its fallback when runtime reconnects, preserving native attributes', async () => {
  setRuntimeOrigin(null, true)
  const view = mount(RuntimeImage, { props: { src: '/assets/a.webp' },
    attrs: { alt: '角色', loading: 'lazy', width: 320, srcset: '/wrong-shell.webp 320w' },
    slots: { fallback: '<span class="missing">暂未连接</span>' } })
  expect(view.find('img').exists()).toBe(false)
  setRuntimeOrigin('http://127.0.0.1:3002', true); await nextTick()
  const img = view.get('img')
  expect(img.attributes()).toMatchObject({ src: 'http://127.0.0.1:3002/assets/a.webp', crossorigin: 'anonymous', alt: '角色', loading: 'lazy', width: '320' })
  expect(img.attributes('srcset')).toBeUndefined()
  await img.trigger('error')
  expect(view.find('.missing').exists()).toBe(true)
  expect(view.emitted('error')).toHaveLength(1)
  setRuntimeOrigin(null, true); await nextTick()
  setRuntimeOrigin('http://127.0.0.1:3002', true); await nextTick()
  Object.defineProperties(view.get('img').element, { naturalWidth: { value: 320 }, naturalHeight: { value: 480 } })
  await view.get('img').trigger('load')
  expect(view.emitted('load')).toHaveLength(1)
  expect(view.find('.missing').exists()).toBe(false)
})

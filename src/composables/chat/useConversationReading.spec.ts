import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { useConversationReading } from './useConversationReading'

const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')

afterEach(() => {
  if (scrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', scrollHeight)
  else delete (HTMLElement.prototype as any).scrollHeight
  if (clientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeight)
  else delete (HTMLElement.prototype as any).clientHeight
})

describe('useConversationReading', () => {
  it('opens an already-populated conversation at the latest message', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 640 })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 160 })
    const list = ref<HTMLElement>()
    const character = ref('nene')
    const wrapper = mount(defineComponent({
      setup() {
        useConversationReading(list, () => ['already-loaded'], character)
        return () => h('div', { ref: list, class: 'conversation-list' })
      },
    }))

    await nextTick()
    await nextTick()
    expect(list.value?.scrollTop).toBe(640)
    wrapper.unmount()
  })
})

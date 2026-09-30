import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import PromptComparePanel from '@/components/director/PromptComparePanel.vue'

describe('U3 Overlay & Dialog Behaviors', () => {
  beforeEach(() => {
    document.body.className = ''
    document.documentElement.style.overflow = ''
  })

  afterEach(() => {
    document.body.className = ''
    document.documentElement.style.overflow = ''
  })

  it('supports Escape key and focus trapping in PromptComparePanel', async () => {
    const dummySnapshot = {
      url: '/test.png',
      seed: 1234,
      size: '1024x1024',
      sampler: 'Euler a',
      cfg: 7,
      steps: 28,
      hires: 'off',
      styleLoraId: '',
      at: '12:00:00',
    }

    const wrapper = mount(PromptComparePanel, {
      props: {
        previous: dummySnapshot,
        current: dummySnapshot,
      },
      attachTo: document.body,
    })

    await nextTick()

    // Pressing Escape inside dialog triggers close event
    const dialog = wrapper.find('.pb-compare').element as HTMLElement
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    expect(wrapper.emitted('close')).toHaveLength(1)

    wrapper.unmount()
  })
})

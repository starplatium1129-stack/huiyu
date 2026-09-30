import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import VoiceGlow from './VoiceGlow.vue'
import { useVoiceMeter } from '@/composables/useVoiceMeter'

describe('VoiceGlow component', () => {
  it('renders decorative canvas with aria-hidden="true"', () => {
    const wrapper = mount(VoiceGlow, {
      props: {
        active: true,
        level: 0.5,
      },
    })

    const container = wrapper.find('.voice-glow-container')
    expect(container.exists()).toBe(true)
    expect(container.attributes('aria-hidden')).toBe('true')

    const canvas = wrapper.find('canvas.voice-glow-canvas')
    expect(canvas.exists()).toBe(true)
  })

  it('useVoiceMeter sets manual level and cleans up cleanly', () => {
    const meter = useVoiceMeter()
    expect(meter.level.value).toBe(0)

    meter.setManualLevel(0.8)
    expect(meter.level.value).toBe(0.8)

    meter.detachStream()
    expect(meter.level.value).toBe(0)
    expect(meter.isListening.value).toBe(false)
  })
})

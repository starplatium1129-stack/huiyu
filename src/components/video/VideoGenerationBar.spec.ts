import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import VideoGenerationBar from './VideoGenerationBar.vue'

let wrapper: ReturnType<typeof mount> | undefined
afterEach(() => wrapper?.unmount())

function setup() {
  wrapper = mount(VideoGenerationBar, { props: {
    aspectRatio: 'landscape', duration: 3, quality: 'standard',
    aspectOptions: [{ value: 'landscape', label: '横屏' }, { value: 'original', label: '跟随原图' }],
    durationOptions: [{ value: 3, label: '3 秒' }, { value: 15, label: '15 秒' }],
    qualityOptions: [{ value: 'standard', label: '标准' }, { value: 'fine', label: '精细' }],
    canGenerate: false, submitting: false, submitTitle: '先写镜头描述', submitDescription: '写下这一幕再生成。',
  } })
  return wrapper
}

describe('video generation controls', () => {
  it('keeps original aspect, numeric durations and quality choices when controls move into the bar', () => {
    const bar = setup()
    const selects = bar.findAllComponents(StudioSelect)
    selects[0]!.findComponent({ name: 'SelectRoot' }).vm.$emit('update:modelValue', 'original')
    selects[1]!.findComponent({ name: 'SelectRoot' }).vm.$emit('update:modelValue', '15')
    selects[2]!.findComponent({ name: 'SelectRoot' }).vm.$emit('update:modelValue', 'fine')
    expect(bar.emitted('update:aspectRatio')).toEqual([['original']])
    expect(bar.emitted('update:duration')).toEqual([[15]])
    expect(bar.emitted('update:quality')).toEqual([['fine']])
  })

  it('keeps the blocking reason beside the disabled submit action and respects preparation locks', async () => {
    const bar = setup()
    const submit = bar.get('button.btn-primary')
    expect(bar.get('.video-generation-summary').text()).toContain('先写镜头描述')
    expect(submit.attributes('disabled')).toBeDefined()
    await submit.trigger('click')
    expect(bar.emitted('generate')).toBeUndefined()
    await bar.setProps({ canGenerate: true })
    await submit.trigger('click')
    expect(bar.emitted('generate')).toEqual([[]])
    await bar.setProps({ canGenerate: false, submitting: true })
    expect(bar.findAllComponents(StudioSelect).every(select => select.props('disabled'))).toBe(true)
    expect(submit.text()).toContain('正在提交')
  })
})

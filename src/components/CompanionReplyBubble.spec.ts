import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import CompanionReplyBubble from './CompanionReplyBubble.vue'
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
describe('companion reply preview', () => {
  it('dismisses the preview without opening or altering the full reply, then shows a new reply', async () => {
    vi.useFakeTimers()
    const timeouts = vi.spyOn(window, 'setTimeout'), clears = vi.spyOn(window, 'clearTimeout')
    const wrapper = mount(CompanionReplyBubble, { props: { text: '第一条完整回复', name: '夏目' } })
    await wrapper.get('[aria-label="收起回复气泡"]').trigger('click')
    expect(wrapper.find('.companion-reply-preview').exists()).toBe(false)
    expect(wrapper.emitted('open')).toBeUndefined()
    expect(wrapper.props('text')).toBe('第一条完整回复')
    await wrapper.setProps({ text: '下一条完整回复' })
    expect(wrapper.text()).toContain('下一条完整回复')
    await wrapper.get('[aria-label="展开完整回复"]').trigger('click')
    expect(wrapper.emitted('open')).toHaveLength(1)
    const expiry = timeouts.mock.results.at(-1)?.value
    wrapper.unmount()
    expect(clears).toHaveBeenCalledWith(expiry)
  })
  it('holds a focused reply and resumes expiry after focus leaves', async () => {
    vi.useFakeTimers()
    const wrapper = mount(CompanionReplyBubble, { props: { text: '可复制的长回复', name: '夏目' } })
    await wrapper.get('.companion-reply-preview').trigger('focusin')
    await vi.advanceTimersByTimeAsync(15000)
    expect(wrapper.find('.companion-reply-preview').exists()).toBe(true)
    await wrapper.get('.companion-reply-preview').trigger('focusout')
    await vi.advanceTimersByTimeAsync(12001)
    expect(wrapper.find('.companion-reply-preview').exists()).toBe(false)
    wrapper.unmount()
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ChatMemoryPanel from './ChatMemoryPanel.vue'
import { confirmAction } from '@/composables/useConfirm'
import type { ChatMemoryItem } from '@/utils/chatMemory'

vi.mock('@/composables/useConfirm', () => ({ confirmAction: vi.fn() }))

const fact: ChatMemoryItem = {
  id: 'memory-1',
  character: 'nene',
  text: '她喜欢雨天的咖啡。',
  sourceMid: 'message-1',
  createdAt: 1,
  updatedAt: 1,
  pinned: true,
}

describe('ChatMemoryPanel', () => {
  beforeEach(() => vi.mocked(confirmAction).mockReset())

  it('keeps cancelled memories and emits deletion only after destructive confirmation', async () => {
    vi.mocked(confirmAction).mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const wrapper = mount(ChatMemoryPanel, { props: { items: [fact], characterName: '宁宁' } })

    await wrapper.get('.memory-item .btn-ghost:last-child').trigger('click')

    expect(confirmAction).toHaveBeenCalledWith(expect.objectContaining({
      title: '删除这条长期记忆？',
      message: fact.text,
      danger: true,
    }))
    expect(wrapper.emitted('delete')).toBeUndefined()
    await wrapper.get('.memory-item .btn-ghost:last-child').trigger('click')
    expect(wrapper.emitted('delete')).toEqual([[fact.id]])
    wrapper.unmount()
  })
})

it('cancels the owning confirmation on close, changed facts and unmount', async () => {
  for (const exit of ['close', 'change', 'unmount']) {
    let resolve!: (confirmed: boolean) => void
    vi.mocked(confirmAction).mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const wrapper = mount(ChatMemoryPanel, { props: { items: [fact], characterName: '宁宁' } })
    await wrapper.get('.memory-item .btn-ghost:last-child').trigger('click')
    const options = vi.mocked(confirmAction).mock.calls.at(-1)![0]
    if (typeof options === 'string') throw new Error('Expected confirmation options')
    if (exit === 'close') await wrapper.get('.memory-close').trigger('click')
    else if (exit === 'change') await wrapper.setProps({ items: [{ ...fact, text: '已修改的记忆' }] })
    else wrapper.unmount()
    expect(options.signal?.aborted).toBe(true)
    resolve(true); await flushPromises()
    expect(wrapper.emitted('delete')).toBeUndefined()
    if (wrapper.exists()) wrapper.unmount()
  }
})

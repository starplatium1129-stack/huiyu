import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
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

  it('confirms before emitting irreversible deletion', async () => {
    vi.mocked(confirmAction).mockResolvedValue(true)
    const wrapper = mount(ChatMemoryPanel, { props: { items: [fact], characterName: '宁宁' } })

    await wrapper.get('.memory-item .btn-ghost:last-child').trigger('click')

    expect(confirmAction).toHaveBeenCalledWith(expect.objectContaining({
      title: '删除这条长期记忆？',
      message: fact.text,
      danger: true,
    }))
    expect(wrapper.emitted('delete')).toEqual([[fact.id]])
  })

  it('keeps the memory when confirmation is cancelled', async () => {
    vi.mocked(confirmAction).mockResolvedValue(false)
    const wrapper = mount(ChatMemoryPanel, { props: { items: [fact], characterName: '宁宁' } })

    await wrapper.get('.memory-item .btn-ghost:last-child').trigger('click')

    expect(wrapper.emitted('delete')).toBeUndefined()
  })
})

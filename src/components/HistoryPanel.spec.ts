import { expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import HistoryPanel from './HistoryPanel.vue'
import { artworkRepository } from '@/storage/artworkRepository'
import type { ArtworkRecord } from '@/types/artwork'

vi.mock('@/storage/artworkRepository', () => ({ artworkRepository: { getImage: vi.fn() } }))
vi.mock('@/stores/sceneStore', () => ({ useSceneStore: () => ({ popularCharacters: [] }) }))

it('names batch selection and owns thumbnails by current image request and component lifetime', async () => {
  const reads = new Map<string, (blob: Blob) => void>()
  vi.mocked(artworkRepository.getImage).mockImplementation(id => new Promise(resolve => reads.set(id, resolve)))
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:second')
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const record = (imageId: string) => ({ id: 'record', sceneTitle: 'Saved composition', image_id: imageId }) as ArtworkRecord
  const wrapper = mount(HistoryPanel, { props: { history: [record('old')] }, global: { stubs: { StudioTooltip: { template: '<div><slot /></div>' } } } })
  try {
    expect(wrapper.get('input[type="checkbox"]').attributes('aria-label')).toBe('选择作品：Saved composition')
    await wrapper.setProps({ history: [record('first')] })
    reads.get('old')!(new Blob(['old'])); await flushPromises()
    expect(create).not.toHaveBeenCalled()
    reads.get('first')!(new Blob(['first'])); await flushPromises()
    expect(wrapper.get('.history-thumb img').attributes('src')).toBe('blob:first')
    await wrapper.setProps({ history: [record('second')] })
    expect(revoke).toHaveBeenCalledWith('blob:first')
    reads.get('second')!(new Blob(['second'])); await flushPromises()
    expect(wrapper.get('.history-thumb img').attributes('src')).toBe('blob:second')
    await wrapper.setProps({ history: [] })
    expect(revoke).toHaveBeenCalledWith('blob:second')
    await wrapper.setProps({ history: [record('late')] })
    wrapper.unmount()
    reads.get('late')!(new Blob(['late'])); await flushPromises()
    expect(create).toHaveBeenCalledTimes(2)
  } finally { if (wrapper.exists()) wrapper.unmount(); create.mockRestore(); revoke.mockRestore() }
})

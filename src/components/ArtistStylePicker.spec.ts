import { expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import ArtistStylePicker from './ArtistStylePicker.vue'

it('keeps dialog padding clicks inside the picker and closes only outside its bounds', async () => {
  const wrapper = mount(ArtistStylePicker, { props: { selected: [], engine: 'sd' }, attachTo: document.body })
  try {
    const dialog = document.querySelector('dialog')!
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 20, 200, 200))
    await wrapper.get('.artist-picker-trigger').trigger('click')
    dialog.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 30, clientY: 30 }))
    expect(dialog.open).toBe(true)
    dialog.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 300, clientY: 300 }))
    await vi.waitFor(() => expect(dialog.open).toBe(false))
  } finally { wrapper.unmount(); vi.restoreAllMocks() }
})

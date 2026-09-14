import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import CharacterDirectory from './CharacterDirectory.vue'

let wrapper: VueWrapper | undefined
afterEach(() => { wrapper?.unmount(); wrapper = undefined })

async function setup(catalog = true) {
  wrapper = mount(CharacterDirectory, {
    attachTo: document.body,
    props: { catalog, selectedId: '', items: [{ id: 'one', name: '角色', source: '原神' }], search: '角色' },
  })
  await nextTick()
  const input = wrapper.get('input').element as HTMLInputElement
  input.focus()
  return input
}

describe('character search keyboard', () => {
  it.each(['Escape', 'Enter', 'ArrowDown'])('leaves composing %s to the IME', async key => {
    const input = await setup()
    for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
      const event = new KeyboardEvent('keydown', { key, ...composition, bubbles: true, cancelable: true })
      input.dispatchEvent(event)
      expect(wrapper!.emitted('dismiss')).toBeUndefined()
      expect(wrapper!.emitted('select')).toBeUndefined()
      expect(event.defaultPrevented).toBe(false)
      expect(document.activeElement).toBe(input)
    }
  })

  it('dismisses the catalog without clearing the search', async () => {
    const input = await setup()
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    input.dispatchEvent(event)
    expect(wrapper!.emitted('dismiss')).toHaveLength(1)
    expect(event.defaultPrevented).toBe(true)
    expect(input.value).toBe('角色')
  })

  it('leaves non-modal Escape to the browser', async () => {
    const input = await setup(false)
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    input.dispatchEvent(event)
    expect(wrapper!.emitted('dismiss')).toBeUndefined()
    expect(event.defaultPrevented).toBe(false)
  })

  it('moves to results and selects with Enter after composition', async () => {
    await setup()
    await wrapper!.get('input').trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(wrapper!.get('.directory-item').element)
    await wrapper!.get('input').trigger('keydown', { key: 'Enter' })
    expect(wrapper!.emitted('select')).toEqual([['one']])
  })
})

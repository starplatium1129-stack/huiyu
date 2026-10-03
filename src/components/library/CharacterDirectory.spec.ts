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
  const input = wrapper.get('[aria-label="搜索角色或作品"]').element as HTMLInputElement
  input.focus()
  return input
}

describe('character search keyboard', () => {
  it('searches the work rail without replacing the character search or result list', async () => {
    await setup()
    const railSearch = wrapper!.get('[aria-label="搜索作品目录"]')
    await railSearch.setValue('没有匹配的作品')
    expect(wrapper!.findAll('.directory-series button')).toHaveLength(1)
    expect(wrapper!.findAll('.directory-item')).toHaveLength(1)
    expect((wrapper!.get('[aria-label="搜索角色或作品"]').element as HTMLInputElement).value).toBe('角色')
    await railSearch.setValue('原神')
    expect(wrapper!.findAll('.directory-series button')).toHaveLength(2)
    await railSearch.trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(wrapper!.get('.directory-series button').element)
  })
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
    await wrapper!.get('[aria-label="搜索角色或作品"]').trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(wrapper!.get('.directory-item').element)
    await wrapper!.get('[aria-label="搜索角色或作品"]').trigger('keydown', { key: 'Enter' })
    expect(wrapper!.emitted('select')).toEqual([['one']])
  })
})

describe('character result roving focus', () => {
  const items = [
    { id: 'one', name: '第一位', source: '原神' },
    { id: 'two', name: '第二位', source: '原神' },
    { id: 'three', name: '第三位', source: '原神' },
  ]
  async function mountDirectory() {
    wrapper = mount(CharacterDirectory, { attachTo: document.body, props: { items, selectedId: 'two' } })
    await nextTick()
  }
  it('has one Tab entry, moves with arrows/Home/End and leaves Tab and activation native', async () => {
    await mountDirectory()
    const entry = () => wrapper!.findAll('.directory-item[tabindex="0"]')
    expect(entry()).toHaveLength(1)
    expect(entry()[0]!.attributes('data-character')).toBe('two')
    ;(entry()[0]!.element as HTMLButtonElement).focus()
    await entry()[0]!.trigger('keydown', { key: 'ArrowDown' })
    expect(entry()[0]!.attributes('data-character')).toBe('three')
    await entry()[0]!.trigger('keydown', { key: 'Home' })
    expect(entry()[0]!.attributes('data-character')).toBe('one')
    await entry()[0]!.trigger('keydown', { key: 'End' })
    expect(entry()[0]!.attributes('data-character')).toBe('three')
    for (const key of ['Tab', 'Enter', ' ']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      entry()[0]!.element.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
    }
    await entry()[0]!.trigger('click')
    expect(wrapper!.emitted('select')).toEqual([['three']])
  })
  it('repairs removed result focus, follows selection and never steals focus from search', async () => {
    await mountDirectory()
    ;(wrapper!.get('[data-character="two"]').element as HTMLButtonElement).focus()
    await wrapper!.setProps({ items: [items[0]!, items[2]!] })
    await nextTick()
    expect(document.activeElement).toBe(wrapper!.get('[data-character="one"]').element)
    await wrapper!.setProps({ selectedId: 'three' })
    expect(wrapper!.get('.directory-item[tabindex="0"]').attributes('data-character')).toBe('three')
    const input = wrapper!.get('[aria-label="搜索角色或作品"]')
    ;(input.element as HTMLInputElement).focus()
    await input.setValue('没有匹配')
    expect(wrapper!.findAll('.directory-item')).toHaveLength(0)
    expect(document.activeElement).toBe(input.element)
    await input.setValue('第一位')
    expect(wrapper!.get('.directory-item[tabindex="0"]').attributes('data-character')).toBe('one')
    expect(document.activeElement).toBe(input.element)
    ;(wrapper!.get('.directory-item').element as HTMLButtonElement).focus()
    await wrapper!.setProps({ items: [] })
    await nextTick()
    expect(document.activeElement).toBe(input.element)
  })
})

import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CompanionOrbitMenu from './CompanionOrbitMenu.vue'

const wrappers: ReturnType<typeof mount>[] = []
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()) })
function setup(extra = {}) {
  const wrapper = mount(CompanionOrbitMenu, {
    attachTo: document.body,
    props: { open: true, characterId: 'nene', characterName: '宁宁', pinned: false, passThrough: false,
      controls: { ready: true, motions: [{ id: 'Head', label: '摸摸头' }], expressions: [{ id: 'smile', label: '微笑' }], hint: '' }, ...extra },
    global: { stubs: { RuntimeImage: true } },
  })
  wrappers.push(wrapper)
  return wrapper
}
describe('companion orbit interactions', () => {
  it('returns from a secondary menu before closing the pet controls', async () => {
    const wrapper = setup()
    await wrapper.get('[aria-label="互动动作"]').trigger('click')
    await wrapper.get('.companion-orbit').trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('.orbit-selection').exists()).toBe(false)
    expect(wrapper.emitted('close')).toBeUndefined()
    await wrapper.get('.companion-orbit').trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
  it('cannot invoke unavailable model actions', async () => {
    const wrapper = setup({ controls: { ready: false, motions: [{ id: 'Head', label: '摸摸头' }], expressions: [], hint: '' } })
    await wrapper.get('[aria-label="互动动作"]').trigger('click')
    expect(wrapper.get('[data-value="Head"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-value="Head"]').trigger('click')
    expect(wrapper.emitted('motion')).toBeUndefined()
    expect(wrapper.text()).toContain('先在设置中加载动态立绘')
  })
  it('closes controls when enabling click-through so the menu cannot trap the desktop', async () => {
    const wrapper = setup()
    await wrapper.get('[aria-label="鼠标穿透"]').trigger('click')
    expect(wrapper.emitted('pass')).toHaveLength(1)
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
  it('does not report an old expression as applied after switching characters', async () => {
    let finish!: (applied: boolean) => void
    const setExpression = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve }))
    const wrapper = setup({ setExpression })
    await wrapper.get('[aria-label="角色表情"]').trigger('click')
    await wrapper.get('[data-value="smile"]').trigger('click')
    await wrapper.get('[data-value="smile"]').trigger('click')
    expect(setExpression).toHaveBeenCalledTimes(1)
    await wrapper.setProps({ characterId: 'natsume' })
    finish(true)
    await flushPromises()
    expect(wrapper.text()).not.toContain('已切换')
  })
})

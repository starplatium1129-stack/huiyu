import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import CharacterBookshelf from './CharacterBookshelf.vue'
import type { DirectoryCharacter } from './CharacterDirectory.vue'

let wrapper: VueWrapper | undefined
afterEach(() => { wrapper?.unmount(); wrapper = undefined })

const characters: DirectoryCharacter[] = [
  ...Array.from({ length: 27 }, (_, i) => ({
    id: `genshin-${i}`, name: `原神角色${i}`, source: i % 2 ? 'miHoYo《原神 / Genshin Impact》' : 'Genshin Impact', image: `/portraits/genshin-${i}.webp`, aliases: i === 25 ? ['测试别名', 'Amber'] : [],
  })),
  { id: 'blue-one', name: '白子', source: 'Blue Archive', image: '/assets/characters/portrait-pending.svg' },
  { id: 'blue-two', name: '星野', source: '蔚蓝档案' },
  { id: 'unknown', name: '原创角色', source: '', image: '/portraits/unknown.webp' },
]

function setup(items: readonly DirectoryCharacter[] = characters, selectedId = '') {
  wrapper = mount(CharacterBookshelf, { attachTo: document.body, props: { items, selectedId } })
  return wrapper
}

describe('角色作品书架', () => {
  it('默认按真实作品归组，合并中英文来源，最多展示五张有效封面', () => {
    const page = setup()
    expect(page.findAll('.bookshelf-work')).toHaveLength(3)
    const genshin = page.get('[data-franchise="Genshin Impact"]')
    expect(genshin.text()).toContain('27 位角色')
    expect(genshin.findAll('img')).toHaveLength(5)
    const blue = page.get('[data-franchise="Blue Archive"]')
    expect(blue.text()).toContain('2 位角色')
    expect(blue.text()).toContain('封面待补充')
    expect(blue.findAll('img')).toHaveLength(0)
    expect(page.get('[data-franchise=""]').findAll('img')).toHaveLength(1)
    expect(page.findAll('[data-character]')).toHaveLength(0)
  })

  it('作品内每页最多24位角色，翻页选择只发送对应角色ID', async () => {
    const page = setup(characters, 'genshin-25')
    await page.get('[data-franchise="Genshin Impact"]').trigger('click')
    expect(page.get('h2').text()).toBe('原神')
    expect(page.findAll('[data-character]')).toHaveLength(24)
    expect(page.get('nav button').attributes('disabled')).toBeDefined()
    await page.get('nav button:last-child').trigger('click')
    expect(page.findAll('[data-character]')).toHaveLength(3)
    expect(page.get('nav').text()).toContain('第 2 / 2 页')
    expect(page.get('[data-character="genshin-25"]').attributes('aria-pressed')).toBe('true')
    await page.get('[data-character="genshin-25"]').trigger('click')
    expect(page.emitted('select')).toEqual([['genshin-25']])
    expect(page.get('nav').text()).toContain('第 2 / 2 页')
    expect(page.get('nav button:last-child').attributes('disabled')).toBeDefined()
  })

  it('角色、别名和中英文作品名都可搜索，搜索跨作品并重置页码', async () => {
    const page = setup()
    await page.get('[data-franchise="Genshin Impact"]').trigger('click')
    await page.get('nav button:last-child').trigger('click')
    await page.get('input').setValue('  AMBER  ')
    expect(page.findAll('[data-character]')).toHaveLength(1)
    expect(page.get('[data-character]').attributes('data-character')).toBe('genshin-25')
    await page.get('input').setValue('蔚蓝档案')
    expect(page.findAll('[data-character]')).toHaveLength(2)
    await page.get('input').setValue('白子')
    expect(page.get('[data-character]').attributes('data-character')).toBe('blue-one')
    await page.get('input').setValue('Genshin Impact')
    expect(page.findAll('[data-character]')).toHaveLength(24)
    expect(page.get('nav').text()).toContain('第 1 / 2 页')
  })

  it('返回书架恢复作品按钮焦点，未标注作品也能独立打开', async () => {
    const page = setup()
    await page.get('[data-franchise=""]').trigger('click')
    expect(page.get('h2').text()).toBe('未标注作品')
    expect(page.findAll('[data-character]')).toHaveLength(1)
    await page.get('.bookshelf-back').trigger('click')
    await nextTick()
    expect(document.activeElement).toBe(page.get('[data-franchise=""]').element)
  })

  it('无匹配时可清除搜索并恢复书架，全角色入口继续遵守分页上限', async () => {
    const page = setup()
    await page.get('input').setValue('并不存在的名字')
    expect(page.get('.bookshelf-empty').text()).toContain('没有找到匹配的角色')
    await page.get('.bookshelf-empty button').trigger('click')
    expect(page.findAll('.bookshelf-work')).toHaveLength(3)
    expect(document.activeElement).toBe(page.get('input').element)
    await page.get('.bookshelf-modes button:last-child').trigger('click')
    expect(page.get('h2').text()).toBe('全部角色')
    expect(page.findAll('[data-character]')).toHaveLength(24)
    await page.get('nav button:last-child').trigger('click')
    expect(page.findAll('[data-character]')).toHaveLength(6)
  })

  it('输入法确认不触发选择，搜索确认和方向键可正常使用', async () => {
    const page = setup()
    await page.get('input').setValue('测试别名')
    await page.get('input').trigger('keydown', { key: 'Enter', isComposing: true })
    await page.get('input').trigger('keydown', { key: 'Enter', keyCode: 229 })
    expect(page.emitted('select')).toBeUndefined()
    await page.get('input').trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(page.get('[data-character]').element)
    await page.get('input').trigger('keydown', { key: 'Enter' })
    expect(page.emitted('select')).toEqual([['genshin-25']])
  })

  it('父页面恢复时聚焦当前结果中的角色，列表状态不变', async () => {
    const page = setup(characters, 'genshin-25')
    await page.get('input').setValue('Amber')
    await (page.vm as unknown as { focusSelected: () => Promise<void> }).focusSelected()
    expect(document.activeElement).toBe(page.get('[data-character="genshin-25"]').element)
    expect((page.get('input').element as HTMLInputElement).value).toBe('Amber')
    await page.setProps({ selectedId: 'blue-one' })
    await (page.vm as unknown as { focusSelected: () => Promise<void> }).focusSelected()
    expect(document.activeElement).toBe(page.get('input').element)
  })

  it('图片加载失败使用现有肖像占位，不伪造角色或封面数量', async () => {
    const page = setup([{ id: 'broken', name: '测试角色', source: '原神', image: '/missing.webp' }])
    await page.get('img').trigger('error')
    expect(page.findAll('img')).toHaveLength(0)
    expect(page.get('[data-state="placeholder"]').text()).toBe('测')
    expect(page.get('.bookshelf-work-count').text()).toBe('1 位角色')
  })

  it('异步数据缩减时收回越界页码，目录空数据可正常展示', async () => {
    const page = setup()
    await page.get('.bookshelf-modes button:last-child').trigger('click')
    await page.get('nav button:last-child').trigger('click')
    await page.setProps({ items: characters.slice(0, 2) })
    expect(page.findAll('[data-character]')).toHaveLength(2)
    await page.setProps({ items: [] })
    await page.get('.bookshelf-modes button:first-child').trigger('click')
    expect(page.get('.bookshelf-empty').text()).toBe('角色目录暂时为空。')
  })
})

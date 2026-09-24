import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import GlobalSearch from './GlobalSearch.vue'

const mocks = vi.hoisted(() => ({
  routerPush: vi.fn(),
  openRequest: { value: 0, __v_isRef: true },
  openSource: { value: 'keyboard' as 'keyboard' | 'pointer' },
  loadHome: vi.fn().mockResolvedValue(undefined),
  scenes: [] as Array<Record<string, unknown>>,
  kvInit: vi.fn().mockResolvedValue(undefined),
  kvGet: vi.fn().mockResolvedValue([]),
  indexArtworkSearch: vi.fn().mockReturnValue([]),
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: mocks.routerPush }),
}))

vi.mock('@/composables/useGlobalSearch', () => ({
  useGlobalSearchRequest: () => ({
    openRequest: mocks.openRequest,
    openSource: mocks.openSource,
  }),
}))

vi.mock('@/stores/sceneStore', () => ({
  useSceneStore: () => ({
    loadHome: mocks.loadHome,
    scenes: mocks.scenes,
  }),
}))

vi.mock('@/composables/useKVStore', () => ({
  kvInit: mocks.kvInit,
  kvGet: mocks.kvGet,
}))

vi.mock('@/utils/artworkSearch', () => ({
  indexArtworkSearch: mocks.indexArtworkSearch,
}))

vi.mock('@/composables/useFluidSurface', () => ({
  useFluidSurface: () => ({
    enter: (_el: Element, done: () => void) => done(),
    leave: (_el: Element, done: () => void) => done(),
    dispose: vi.fn(),
  }),
}))

vi.mock('@/composables/useFocusTrap', () => ({
  useFocusTrap: vi.fn(),
}))

const mounted: Array<{ unmount: () => void }> = []
const tooltipStub = { template: '<span><slot /></span>' }

async function settleSearch() {
  await flushPromises()
  await nextTick()
  await nextTick()
}

async function openSearch() {
  const trigger = document.createElement('button')
  document.body.append(trigger)
  const wrapper = mount(GlobalSearch, {
    attachTo: document.body,
    props: {
      initialSource: 'keyboard',
      initialTrigger: trigger,
    },
    global: {
      stubs: { StudioTooltip: tooltipStub },
    },
  })
  mounted.push(wrapper)
  await settleSearch()
  return { wrapper, trigger }
}

function rows() {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.gs-row'))
}

function searchInput() {
  return document.querySelector<HTMLInputElement>('.gs-input')!
}

beforeEach(() => {
  mocks.routerPush.mockReset()
  mocks.openRequest.value = 0
  mocks.openSource.value = 'keyboard'
  mocks.loadHome.mockClear()
  mocks.kvInit.mockClear()
  mocks.kvGet.mockClear()
  mocks.indexArtworkSearch.mockClear()
})

afterEach(() => {
  mounted.splice(0).reverse().forEach(wrapper => wrapper.unmount())
  document.body.innerHTML = ''
})

describe('GlobalSearch combobox', () => {
  it('connects the input to a stable listbox and announces the active result', async () => {
    await openSearch()
    const input = searchInput()
    const listboxId = input.getAttribute('aria-controls')!
    const listbox = document.getElementById(listboxId)!

    expect(input.getAttribute('role')).toBe('combobox')
    expect(input.getAttribute('aria-autocomplete')).toBe('list')
    expect(input.getAttribute('aria-expanded')).toBe('true')
    expect(listbox.getAttribute('role')).toBe('listbox')

    const initialRows = rows()
    expect(initialRows.length).toBeGreaterThan(1)
    const initialId = initialRows[0].id
    expect(initialId).toBeTruthy()
    expect(input.getAttribute('aria-activedescendant')).toBe(initialId)
    expect(initialRows.every(row => row.id && row.getAttribute('role') === 'option')).toBe(true)

    const announcement = document.getElementById(input.getAttribute('aria-describedby')!)!
    expect(announcement.getAttribute('aria-live')).toBe('polite')
    expect(announcement.textContent).toContain(`找到 ${initialRows.length} 个结果`)
    expect(announcement.textContent).toContain('开始一幅新的绘制')

    const down = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    input.dispatchEvent(down)
    await nextTick()
    expect(down.defaultPrevented).toBe(true)
    expect(input.getAttribute('aria-activedescendant')).toBe(initialRows[1].id)
    expect(announcement.textContent).toContain('当前第 2 项')

    initialRows[2].dispatchEvent(new Event('pointermove', { bubbles: true }))
    await nextTick()
    expect(input.getAttribute('aria-activedescendant')).toBe(initialRows[2].id)
  })

  it('keeps option ids stable while filtering and preserves mouse and Enter activation', async () => {
    await openSearch()
    const input = searchInput()
    const homeRow = rows().find(row => row.textContent?.includes('首页'))!
    const homeId = homeRow.id

    input.value = '首页'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    const filteredRows = rows()
    expect(filteredRows).toHaveLength(1)
    expect(filteredRows[0].id).toBe(homeId)
    expect(input.getAttribute('aria-activedescendant')).toBe(homeId)

    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    input.dispatchEvent(enter)
    await nextTick()
    expect(mocks.routerPush).toHaveBeenCalledWith('/')
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('.global-search')?.getAttribute('aria-hidden')).toBe('true')
  })
})

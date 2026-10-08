import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import GlobalSearch from './GlobalSearch.vue'
import { searchArtworkRecords } from '@/application/artwork/searchIndex'

const mocks = vi.hoisted(() => ({
  routerPush: vi.fn(),
  loadHome: vi.fn().mockResolvedValue(undefined),
  scenes: [] as Array<Record<string, unknown>>,
  searchArtworks: vi.fn().mockResolvedValue([]),
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: mocks.routerPush }),
}))

vi.mock('@/composables/useGlobalSearch', async () => {
  const { ref } = await import('vue')
  const openRequest = ref(0)
  const openSource = ref<'keyboard' | 'pointer'>('keyboard')
  return {
    useGlobalSearchRequest: () => ({ openRequest, openSource }),
    openGlobalSearch: (source: 'keyboard' | 'pointer' = 'pointer') => {
      openSource.value = source
      openRequest.value += 1
    },
  }
})

vi.mock('@/stores/sceneStore', () => ({
  useSceneStore: () => ({
    loadHome: mocks.loadHome,
    scenes: mocks.scenes,
  }),
}))

vi.mock('@/storage/artworkRepository', () => ({
  artworkRepository: { searchArtworks: (query: string, signal?: AbortSignal) => mocks.searchArtworks(query, signal).then((rows: unknown) => searchArtworkRecords(rows, query)) },
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

async function search(value: string) {
  const input = searchInput()
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
  await vi.advanceTimersByTimeAsync(150)
  await settleSearch()
}

function toggleSearch() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }))
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  mocks.routerPush.mockReset()
  mocks.loadHome.mockClear()
  mocks.searchArtworks.mockReset().mockResolvedValue([])
  mocks.scenes.length = 0
})

afterEach(() => {
  mounted.splice(0).reverse().forEach(wrapper => wrapper.unmount())
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('GlobalSearch combobox', () => {
  it('connects the input to a stable listbox and announces the active result', async () => {
    await openSearch()
    expect(mocks.searchArtworks).not.toHaveBeenCalled()
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

  it('响应外部 openGlobalSearch 唤起并打开搜索面板', async () => {
    const { openGlobalSearch } = await import('@/composables/useGlobalSearch')
    const wrapper = mount(GlobalSearch, {
      attachTo: document.body,
      global: {
        stubs: { StudioTooltip: tooltipStub },
      },
    })
    mounted.push(wrapper)
    await settleSearch()

    expect(document.querySelector('.global-search')?.getAttribute('aria-hidden')).toBe('true')

    openGlobalSearch('pointer')
    await settleSearch()

    expect(document.querySelector('.global-search')?.getAttribute('aria-hidden')).toBe('false')
  })

  it('matches multiple words across the whole library, limits results and passes every changed query to the repository', async () => {
    mocks.searchArtworks.mockResolvedValue(Array.from({ length: 10000 }, (_, i) => ({
      id: i + 1, timestamp: i + 1, title: i ? `Garden ${i}` : 'Oldest Sentinel', prompt: 'BLUE flower', size: '1216x912',
    })))
    mocks.scenes.push(...Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, title: `Scene ${i}`, story: 'Blue Flower' })))
    await openSearch()
    await search('  SeNtInEl  oldest ')
    expect(rows().map(row => row.textContent)).toEqual([expect.stringContaining('Oldest Sentinel')])
    await search('FLOWER blue')
    expect(rows().filter(row => row.id.includes('-scene-'))).toHaveLength(8)
    const works = rows().filter(row => row.id.includes('-work-'))
    expect(works).toHaveLength(5)
    expect(works[0].textContent).toContain('Garden 9999')
    expect(works[0].textContent).toContain('1216x912')
    expect(mocks.searchArtworks).toHaveBeenCalledTimes(2)
    works[0].click()
    expect(mocks.routerPush).toHaveBeenCalledWith('/prompt-builder?regen=10000')
  })

  it('aborts a closed search and rejects its late result after reopening', async () => {
    let finish!: (rows: unknown[]) => void
    mocks.searchArtworks.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await openSearch()
    await search('stale')
    const signal = mocks.searchArtworks.mock.calls[0][1] as AbortSignal
    toggleSearch()
    await settleSearch()
    expect(signal.aborted).toBe(true)
    mocks.searchArtworks.mockResolvedValue([{ id: 'fresh', title: 'Fresh artwork' }])
    toggleSearch()
    await settleSearch()
    expect(mocks.searchArtworks).toHaveBeenCalledOnce()
    await search('fresh')
    finish([{ id: 'stale', title: 'Stale artwork' }])
    await settleSearch()
    expect(rows().map(row => row.textContent)).toEqual([expect.stringContaining('Fresh artwork')])
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

  it('cancels pending reads on query clearing and unmount without retaining results', async () => {
    let finish!: (rows: unknown[]) => void
    mocks.searchArtworks.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const { wrapper } = await openSearch()
    await search('stale')
    const firstSignal = mocks.searchArtworks.mock.calls[0][1] as AbortSignal
    await search(' ')
    expect(firstSignal.aborted).toBe(true)
    finish([{ id: 'stale', title: 'Stale artwork' }])
    await settleSearch()
    expect(document.querySelector('[role="status"].gs-empty')).toBeNull()
    await search('next')
    const secondSignal = mocks.searchArtworks.mock.calls[1][1] as AbortSignal
    wrapper.unmount()
    expect(secondSignal.aborted).toBe(true)
    finish([])
    await settleSearch()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('keeps a read failure visible and retries only after reopening', async () => {
    mocks.searchArtworks.mockRejectedValueOnce(new Error('offline'))
    await openSearch()
    await search('work')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('作品读取失败')
    await search('another work')
    expect(mocks.searchArtworks).toHaveBeenCalledOnce()
    toggleSearch()
    await settleSearch()
    toggleSearch()
    await settleSearch()
    await search('work')
    expect(mocks.searchArtworks).toHaveBeenCalledTimes(2)
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })
})

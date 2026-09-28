import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, ref } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { useAlbumNavigation } from './useAlbumNavigation'

const scroll = vi.hoisted(() => ({ capture: vi.fn(), restore: vi.fn(), cancel: vi.fn() }))
vi.mock('@/utils/scrollAnchor', () => ({ captureScrollAnchor: scroll.capture, restoreScrollAnchor: scroll.restore }))
const wrappers: VueWrapper[] = []

beforeEach(() => {
  vi.clearAllMocks()
  scroll.capture.mockReturnValue({ left: 0, top: 0 })
  scroll.restore.mockReturnValue(scroll.cancel)
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})
})
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); vi.restoreAllMocks() })

function setup(initial = '') {
  let navigation!: ReturnType<typeof useAlbumNavigation<string>>
  const selection = ref(initial), query = ref('雨夜')
  const wrapper = mount(defineComponent({
    setup() { navigation = useAlbumNavigation(selection); return { ...navigation, selection, query } },
    template: `<div>
      <section ref="albumRoot" v-show="albumsOpen" tabindex="-1">
        <button data-album-id="rain" @click="openAlbum('rain')">雨后画册</button>
        <button data-album-id="snow" @click="openAlbum('snow')">冬日画册</button>
      </section>
      <section ref="imageHeading" v-show="!albumsOpen" tabindex="-1"><input v-model="query" />{{ selection }}</section>
    </div>`,
  }), { attachTo: document.body })
  wrappers.push(wrapper)
  return { wrapper, navigation, selection, query }
}

describe('album overview and image navigation', () => {
  it('starts on the image view and retains a restored collection filter', () => {
    const { navigation, selection } = setup('rain')
    expect(navigation.albumsOpen.value).toBe(false)
    expect(selection.value).toBe('rain')
    expect(navigation.albumRoot.value?.style.display).toBe('none')
    expect(navigation.imageHeading.value?.style.display).not.toBe('none')
  })

  it('opens album images, then restores the cover position and focus without clearing search', async () => {
    const { navigation, selection, query, wrapper } = setup()
    scroll.capture.mockReturnValue({ left: 0, top: 80 })
    await navigation.showAlbums()
    scroll.capture.mockReturnValue({ left: 0, top: 480 })
    await navigation.openAlbum('rain')
    expect(navigation.albumsOpen.value).toBe(false)
    expect(selection.value).toBe('rain')
    expect(document.activeElement).toBe(navigation.imageHeading.value)
    expect(navigation.imageHeading.value?.scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'instant' })
    scroll.capture.mockReturnValue({ left: 0, top: 275 })
    await navigation.showAlbums()
    expect(scroll.restore).toHaveBeenLastCalledWith({ left: 0, top: 480 }, expect.objectContaining({ immediate: true }))
    expect(document.activeElement).toBe(wrapper.get('[data-album-id="rain"]').element)
    expect(query.value).toBe('雨夜')
    await navigation.showImages()
    expect(scroll.restore).toHaveBeenLastCalledWith({ left: 0, top: 275 }, expect.objectContaining({ immediate: true }))
  })

  it('does not apply a stale overview restore after the next navigation or unmount', async () => {
    const { navigation, wrapper } = setup()
    await navigation.showAlbums()
    await navigation.openAlbum('rain')
    await navigation.showAlbums()
    const options = scroll.restore.mock.lastCall?.[1]
    expect(options.shouldContinue()).toBe(true)
    const returning = navigation.showImages()
    expect(options.shouldContinue()).toBe(false)
    await returning
    const latest = scroll.restore.mock.lastCall?.[1]
    wrapper.unmount()
    expect(latest.shouldContinue()).toBe(false)
    expect(scroll.cancel).toHaveBeenCalled()
  })
})

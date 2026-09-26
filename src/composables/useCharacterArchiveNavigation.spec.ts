import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { useCharacterArchiveNavigation } from './useCharacterArchiveNavigation'
import type { CharacterProfile } from '@/types/character'

const profiles = ['nene', 'natsume'].map(id => ({
  id, name: id, source: '作品', icon: '', alias: [], voice: '', tags: [], bg_story: '', personality: [], likes: [],
})) satisfies CharacterProfile[]
let wrapper: VueWrapper | undefined
afterEach(() => wrapper?.unmount())

async function setup(url = '/character', initiallyLoaded = true) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/character', component: {} }] })
  await router.push(url)
  await router.isReady()
  const characters = ref(initiallyLoaded ? profiles : [])
  const restoreFocus = vi.fn()
  let navigation!: ReturnType<typeof useCharacterArchiveNavigation>
  wrapper = mount(defineComponent({
    setup() {
      navigation = useCharacterArchiveNavigation(characters, ref(null), restoreFocus)
      return () => h('div', navigation.current.value?.name || '作品书架')
    },
  }), { global: { plugins: [router] } })
  await flushPromises()
  return { router, navigation, characters, restoreFocus }
}

describe('character archive navigation', () => {
  it('starts on the shelf and waits for catalog data before resolving a deep link', async () => {
    const { navigation, router, characters } = await setup('/character', false)
    expect(navigation.showShelf.value).toBe(true)
    expect(navigation.current.value).toBeNull()
    await router.push('/character?character=natsume')
    characters.value = profiles
    await flushPromises()
    expect(navigation.current.value?.id).toBe('natsume')
    expect(navigation.showShelf.value).toBe(false)
  })

  it('preserves other query fields and returns to the shelf with browser history', async () => {
    const { router, navigation, restoreFocus } = await setup('/character?source=home')
    navigation.selectCharacter('nene')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ source: 'home', character: 'nene' })
    navigation.selectCharacter('natsume')
    await flushPromises()
    expect(navigation.lastViewedId.value).toBe('natsume')
    router.back()
    await flushPromises()
    expect(navigation.showShelf.value).toBe(true)
    expect(router.currentRoute.value.query).toEqual({ source: 'home' })
    expect(restoreFocus).toHaveBeenCalledOnce()
    router.forward()
    await flushPromises()
    expect(navigation.current.value?.id).toBe('natsume')
  })

  it('opens direct links and clears only the selected character when returning', async () => {
    const { router, navigation } = await setup('/character?character=nene&source=scene')
    expect(navigation.current.value?.id).toBe('nene')
    navigation.showBookshelf()
    await flushPromises()
    expect(navigation.showShelf.value).toBe(true)
    expect(navigation.lastViewedId.value).toBe('nene')
    expect(router.currentRoute.value.query).toEqual({ source: 'scene' })
  })

  it('does not silently select a different profile for unknown or ambiguous links', async () => {
    const { router, navigation } = await setup('/character?character=missing')
    expect(navigation.showShelf.value).toBe(true)
    expect(navigation.current.value).toBeNull()
    navigation.selectCharacter('missing')
    await flushPromises()
    expect(router.currentRoute.value.query.character).toBe('missing')
    await router.push('/character?character=nene&character=natsume')
    expect(navigation.current.value).toBeNull()
  })
})

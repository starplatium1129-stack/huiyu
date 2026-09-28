import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, KeepAlive, nextTick, ref } from 'vue'
import { characterThemeStyle } from '@/utils/characterTheme'

const palettes = {
  alpha: { accent: '#38bdf8', aura: 'rgba(56,189,248,.3)', auraSecondary: 'rgba(12,30,45,.2)' },
  beta: { accent: '#f43f5e', aura: 'rgba(244,63,94,.3)', auraSecondary: 'rgba(31,15,42,.2)' },
}
let wrapper: VueWrapper | undefined

beforeEach(() => vi.resetModules())
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.doUnmock('@/utils/characterThemeCatalog')
  document.documentElement.style.removeProperty('--character-aura')
  document.documentElement.style.removeProperty('--character-aura-secondary')
})

function deferredCatalog() {
  let resolve!: (value: { POPULAR_CHARACTER_THEMES: typeof palettes }) => void
  const promise = new Promise<{ POPULAR_CHARACTER_THEMES: typeof palettes }>(done => { resolve = done })
  return { promise, resolve: () => resolve({ POPULAR_CHARACTER_THEMES: palettes }) }
}

async function setup(load: () => Promise<{ POPULAR_CHARACTER_THEMES: typeof palettes }>, initial = 'nene') {
  const loader = vi.fn(load)
  vi.doMock('@/utils/characterThemeCatalog', loader)
  const { useCharacterAtmosphere } = await import('./useCharacterAtmosphere')
  const character = ref(initial)
  const visible = ref(true)
  let style!: ReturnType<typeof useCharacterAtmosphere>
  const component = defineComponent({ setup() {
    style = useCharacterAtmosphere(() => character.value, () => [{ id: 'alpha', accent_color: '#123abc' }])
    return () => h('div')
  } })
  const other = defineComponent({ render: () => h('div') })
  wrapper = mount(defineComponent({ setup: () => () => h(KeepAlive, null, {
    default: () => visible.value ? h(component) : h(other),
  }) }))
  return { character, visible, loader, style: () => style.value }
}
const aura = () => document.documentElement.style.getPropertyValue('--character-aura')

describe('optional character atmosphere', () => {
  it('renders every studio palette synchronously without requesting the popular catalog', async () => {
    const { character, loader, style } = await setup(async () => ({ POPULAR_CHARACTER_THEMES: palettes }))
    for (const id of ['nene', 'natsume', 'triad']) {
      character.value = id
      await nextTick()
      expect(style()).toEqual(characterThemeStyle(id))
      expect(aura()).toBe(characterThemeStyle(id)['--character-aura'])
    }
    await flushPromises()
    expect(loader).not.toHaveBeenCalled()
  })

  it('only applies the latest selected character after a shared late download', async () => {
    const gate = deferredCatalog()
    const { character, loader, style } = await setup(() => gate.promise, 'alpha')
    expect(style()['--character-accent']).toBe('#123abc')
    await vi.waitFor(() => expect(loader).toHaveBeenCalledOnce())
    character.value = 'beta'
    await nextTick()
    gate.resolve()
    await vi.dynamicImportSettled()
    expect(style()['--character-accent']).toBe(palettes.beta.accent)
    expect(aura()).toBe(palettes.beta.aura)
    expect(loader).toHaveBeenCalledOnce()
  })

  it('does not replace a studio theme with a late popular result', async () => {
    const gate = deferredCatalog()
    const { character, loader, style } = await setup(() => gate.promise, 'alpha')
    await vi.waitFor(() => expect(loader).toHaveBeenCalledOnce())
    character.value = 'natsume'
    await nextTick()
    gate.resolve()
    await vi.dynamicImportSettled()
    expect(style()).toEqual(characterThemeStyle('natsume'))
    expect(aura()).toBe(characterThemeStyle('natsume')['--character-aura'])
  })

  it('keeps document tokens cleared while inactive and restores the current palette on activation', async () => {
    const gate = deferredCatalog()
    const { character, visible, loader } = await setup(() => gate.promise, 'alpha')
    await vi.waitFor(() => expect(loader).toHaveBeenCalledOnce())
    visible.value = false
    await nextTick()
    character.value = 'beta'
    gate.resolve()
    await vi.dynamicImportSettled()
    expect(aura()).toBe('')
    visible.value = true
    await nextTick()
    expect(aura()).toBe(palettes.beta.aura)
    expect(loader).toHaveBeenCalledOnce()
  })

  it('does not write document tokens after destruction', async () => {
    const gate = deferredCatalog()
    const { loader } = await setup(() => gate.promise, 'alpha')
    await vi.waitFor(() => expect(loader).toHaveBeenCalledOnce())
    wrapper!.unmount()
    wrapper = undefined
    gate.resolve()
    await vi.dynamicImportSettled()
    expect(aura()).toBe('')
  })

  it('keeps a safe fallback on failure and retries on reactivation', async () => {
    const { visible, loader, style } = await setup(vi.fn()
      .mockRejectedValueOnce(new Error('optional download failed'))
      .mockResolvedValue({ POPULAR_CHARACTER_THEMES: palettes }), 'alpha')
    await vi.dynamicImportSettled()
    expect(style()['--character-accent']).toBe('#123abc')
    expect(aura()).toContain('#123abc')
    visible.value = false
    await nextTick()
    visible.value = true
    await nextTick()
    await vi.dynamicImportSettled()
    expect(loader).toHaveBeenCalledTimes(2)
    expect(aura()).toBe(palettes.alpha.aura)
  })
})

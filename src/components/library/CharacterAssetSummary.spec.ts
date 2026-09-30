import { afterEach, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import CharacterAssetSummary from './CharacterAssetSummary.vue'
let wrapper: VueWrapper | undefined
afterEach(() => { wrapper?.unmount(); vi.useRealTimers(); vi.unstubAllGlobals() })
it('re-enables retry when a HEAD check never settles, then can recover', async () => {
  vi.useFakeTimers()
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ characterId: 'summary-test', outfits: [{ isDefault: true, references: [{ url: '/character-references/example/default/front.png' }] }] })))
    .mockImplementationOnce(() => new Promise(() => {}))
  vi.stubGlobal('fetch', fetcher)
  wrapper = mount(CharacterAssetSummary, { props: { characterId: 'summary-test' } })
  await flushPromises()
  expect(wrapper.get('button').attributes('disabled')).toBeDefined()
  await vi.advanceTimersByTimeAsync(15_001)
  await flushPromises()
  expect(wrapper.get('button').attributes('disabled')).toBeUndefined()
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ characterId: 'summary-test', outfits: [{ isDefault: true, references: [{ url: '/character-references/example/default/front.png' }] }] })))
    .mockResolvedValueOnce(new Response(null, { headers: { 'content-type': 'image/png' } }))
  await wrapper.get('button').trigger('click'); await flushPromises()
  expect(wrapper.text()).toContain('1 / 1 可读取')
})

it('releases profile timeout and ignores a previous character after switching', async () => {
  vi.useFakeTimers()
  let finish!: (response: Response) => void
  const fetcher = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  vi.stubGlobal('fetch', fetcher)
  wrapper = mount(CharacterAssetSummary, { props: { characterId: 'summary-old' } })
  await flushPromises()
  await vi.advanceTimersByTimeAsync(15_001); await flushPromises()
  expect(wrapper.get('button').attributes('disabled')).toBeUndefined()
  expect(wrapper.text()).toContain('请重试')
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ characterId: 'summary-new', outfits: [] })))
  await wrapper.setProps({ characterId: 'summary-new' }); await flushPromises()
  finish(new Response(JSON.stringify({ characterId: 'summary-old', outfits: [] })))
  await flushPromises()
  expect(wrapper.text()).toContain('尚未登记')
  expect(wrapper.get('button').attributes('disabled')).toBeUndefined()
})

import { flushPromises, mount } from '@vue/test-utils'
import { reactive, nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DirectorSceneReference from './DirectorSceneReference.vue'

const context = vi.hoisted(() => ({ store: {} as Record<string, unknown>, local: false }))
vi.mock('@/stores/promptBuilderStore', () => ({ usePromptBuilderStore: () => context.store }))
vi.mock('@/utils/runtimeEnvironment', () => ({ isLocalStudioHost: () => context.local }))

beforeEach(() => {
  context.local = false
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ entries: [
    { id: 'scene_one', title: '放学后', char: 'nene', rating: 'All' },
    { id: 'scene_two', title: '图书馆', char: 'nene', rating: 'All' },
    { id: 'private', title: '场景', char: 'nene', rating: 'R18' },
    { id: 'pc_alice_library', title: '书架之间', char: 'alice', type: 'popular', rating: 'All' },
  ] }) }))
  context.store = reactive({
    subject: { kind: 'studio', characterId: 'nene' },
    activeScene: { id: 'scene_one', title: '放学后', rating: 'All' },
    sceneBlueprints: [],
    selections: { shot: 'close', composition: null, lighting: null },
  })
})

describe('scene canvas reference', () => {
  it('labels references separately and recovers a failed sample when the scene changes', async () => {
    const wrapper = mount(DirectorSceneReference)
    await flushPromises()
    expect(wrapper.text()).toContain('非本次生成')
    expect(wrapper.get('img').attributes('src')).toBe('/scene-showcase/thumbs/scene_one.jpg')
    await wrapper.get('img').trigger('error')
    expect(wrapper.text()).toContain('暂未提供可核实的样张')
    context.store.activeScene = { id: 'scene_two', title: '图书馆', rating: 'All' }
    await nextTick()
    expect(wrapper.get('img').attributes('src')).toBe('/scene-showcase/thumbs/scene_two.jpg')
    expect(wrapper.text()).toContain('图书馆')
  })

  it.each(['R18', 'R15', 'All', undefined])('uses the sample rating even if scene metadata differs (%s)', async rating => {
    context.store.activeScene = { id: 'private', title: '场景', rating }
    const wrapper = mount(DirectorSceneReference)
    await flushPromises()
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).toContain('分级参考已遮挡')
  })

  it('keeps local adult references blurred and does not mutate the selected draft', async () => {
    context.local = true
    context.store.activeScene = { id: 'private', title: '场景', rating: 'R18' }
    const before = JSON.stringify(context.store)
    const wrapper = mount(DirectorSceneReference)
    await flushPromises()
    expect(wrapper.find('.is-restricted img').exists()).toBe(true)
    expect(wrapper.text()).toContain('已模糊')
    expect(JSON.stringify(context.store)).toBe(before)
  })

  it('matches a popular blueprint to its character and discards a stale studio scene', async () => {
    context.store.subject = { kind: 'popular', characterId: 'alice', blueprintId: 'library' }
    context.store.sceneBlueprints = [{ id: 'library', characterId: 'alice', title: '书架之间', sampleRating: 'All', adult: false }]
    const wrapper = mount(DirectorSceneReference)
    await flushPromises()
    expect(wrapper.get('img').attributes('src')).toBe('/scene-showcase/thumbs/pc_alice_library.jpg')
    context.store.subject = { kind: 'popular', characterId: 'bob', blueprintId: 'library' }
    await nextTick()
    expect(wrapper.find('figure').exists()).toBe(false)
  })

  it('keeps missing or ambiguous manifest entries closed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ entries: [
      { id: 'scene_one', title: 'A', char: 'nene', rating: 'All' },
      { id: 'scene_one', title: 'B', char: 'nene', rating: 'R18' },
    ] }) }))
    const wrapper = mount(DirectorSceneReference)
    await flushPromises()
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).toContain('暂未提供可核实的样张')
  })
})

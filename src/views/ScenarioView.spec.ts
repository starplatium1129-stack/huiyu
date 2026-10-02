import { expect, it, vi } from 'vitest'
import { shallowMount } from '@vue/test-utils'
import { ref } from 'vue'
import ScenarioView from './ScenarioView.vue'

const copied = vi.hoisted(() => vi.fn())
vi.mock('@/composables/useCopyFeedback', () => ({ copyWithFeedback: copied }))
vi.mock('@/composables/useScrollReveal', () => ({ useScrollReveal: () => {} }))
vi.mock('@/composables/useMoodReferences', () => ({ useMoodReferences: () => ({ available: ref(new Set()), loading: ref(false) }) }))
vi.mock('@/stores/videoStore', () => ({ useVideoStore: () => ({}) }))
vi.mock('vue-router', () => ({ useRouter: () => ({}) }))
vi.mock('@/config/scenarios', () => ({
  SCENARIO_CHARACTERS: ['nene', 'natsume'],
  SCENARIO_RES_MAP: { Square: { dim: '1024×1024', reason: 'fixture', vram: 'fixture' } },
  substituteScenarioPrompt: (text: string, char: string) => text.replace('{{char}}', char),
  SCENARIOS: [{ id: 'fixture', name: 'Fixture', iconName: 'book', acts: [{
    n: 1, title: 'Fixture', res: 'Square', prompt: '\nsoft light\nwide shot,\r\n{{char}}\u2028暖色 氛围\n',
  }] }],
}))

it('copies separate module tokens and the selected character without joining line boundaries', async () => {
  const view = shallowMount(ScenarioView, { global: { directives: { 'content-motion': {} }, stubs: { RouterLink: true } } })
  await view.get('.act-actions button').trigger('click')
  expect(copied).toHaveBeenLastCalledWith('soft_light, wide_shot, nene, 暖色_氛围', '已复制本幕提示词')
  await view.findAll('.char-btn')[1].trigger('click')
  await view.get('.act-actions button').trigger('click')
  expect(copied).toHaveBeenLastCalledWith('soft_light, wide_shot, natsume, 暖色_氛围', '已复制本幕提示词')
  view.unmount()
})

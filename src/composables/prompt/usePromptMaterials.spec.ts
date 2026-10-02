import { expect, it, vi } from 'vitest'
import { effectScope, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { usePromptMaterials } from './usePromptMaterials'

vi.mock('@/composables/scene/useDirectorDerived', () => ({ useDirectorDerived: () => ({}) }))
vi.mock('@/composables/scene/useDirectorPopular', () => ({ useDirectorPopular: () => ({}) }))
vi.mock('@/utils/sceneUX', () => ({ readHiddenScenes: () => new Set() }))

it('rechecks generation and owner lifetime across the lazy import boundary', async () => {
  setActivePinia(createPinia())
  const pb = usePromptBuilderStore(), generationBusy = ref(false), scope = effectScope()
  pb.story = 'current'
  const animaState = ref({ cfg: 3 })
  const input = { animaState, generationBusy, drawEngine: ref('sd'), sdSize: ref('832x1216'), pb, setDrawEngine: vi.fn() } as unknown as Parameters<typeof usePromptMaterials>[0]
  const materials = scope.run(() => usePromptMaterials(input))!
  const pending = materials.handleLoadBlueprint({ story: 'old' })
  generationBusy.value = true
  await pending
  expect(pb.story).toBe('current')
  generationBusy.value = false
  const detached = materials.handleLoadBlueprint({ story: 'detached' })
  scope.stop(); await detached
  expect(pb.story).toBe('current')
  const nextScope = effectScope(), next = nextScope.run(() => usePromptMaterials(input))!
  const edited = next.handleLoadBlueprint({ story: 'stale numeric import' })
  animaState.value.cfg = 7
  await edited
  expect(pb.story).toBe('current')
  const resized = next.handleLoadBlueprint({ story: 'stale size import' })
  input.sdSize.value = '1024x1024'
  await resized
  expect(pb.story).toBe('current')
  const first = next.handleLoadBlueprint({ story: 'first' }), second = next.handleLoadBlueprint({ story: 'second' })
  await Promise.all([first, second])
  expect(pb.story).toBe('second')
  nextScope.stop(); pb.$dispose()
})

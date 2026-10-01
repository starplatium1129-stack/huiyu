import { expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h, KeepAlive, nextTick, ref } from 'vue'
import PromptDataTools from './PromptDataTools.vue'

vi.mock('@/composables/useBackup', () => ({ useBackup: () => ({
  lastBackupAt: ref(0), pending: ref(null), pendingWorkspace: ref(null), busy: ref(false),
  desktopActive: ref(false), exportProgress: ref(null), imageExportProgress: ref(null),
}) }))
vi.mock('@/composables/useWorkspaceMigration', () => ({ useWorkspaceMigration: () => ({
  available: ref(false), bundledAvailable: ref(false), bundledVerified: ref(false), busy: ref(false), progress: ref(''),
}) }))
vi.mock('@/composables/useFocusTrap', () => ({ useFocusTrap: () => ({ returnFocus: ref(null) }) }))

it('only emits the newest blueprint file and expires its signal on cached navigation', async () => {
  const active = ref(true), loaded = vi.fn(), flash = vi.fn(), blueprint = ref({ story: 'draft', updatedAt: 1 })
  const wrapper = mount(defineComponent({ setup: () => () => h(KeepAlive, null, {
    default: () => active.value ? h(PromptDataTools, { blueprintData: blueprint.value, onLoadBlueprint: loaded, onFlash: flash }) : null,
  }) }), { global: { stubs: { StudioPopover: true, StudioTooltip: true, FluidTransition: true, ArchiveIcon: true } } })
  const input = wrapper.find<HTMLInputElement>('.pb-blueprint-file-input')
  const pick = async () => {
    let finish!: (text: string) => void
    Object.defineProperty(input.element, 'files', { configurable: true, value: [{ text: () => new Promise<string>(resolve => { finish = resolve }) }] })
    await input.trigger('change')
    return finish
  }
  const first = await pick(), second = await pick()
  blueprint.value = { story: 'draft', updatedAt: 2 }; await nextTick()
  second('{"story":"second"}'); await flushPromises()
  first('{"story":"first"}'); await flushPromises()
  expect(loaded).toHaveBeenCalledTimes(1)
  expect(loaded.mock.calls[0][0]).toEqual({ story: 'second' })
  const signal = loaded.mock.calls[0][1] as AbortSignal
  const late = await pick()
  expect(signal.aborted).toBe(true)
  active.value = false; await nextTick()
  active.value = true; await nextTick()
  late('{"story":"detached"}'); await flushPromises()
  expect(loaded).toHaveBeenCalledTimes(1)
  expect(flash).not.toHaveBeenCalled()
  wrapper.unmount()
})

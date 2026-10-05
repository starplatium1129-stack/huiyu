import { expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, KeepAlive, nextTick, ref } from 'vue'
import ShotScriptDialog from './ShotScriptDialog.vue'

it('closes the cached script portal without clearing the parent story', async () => {
  const active = ref(true), open = ref(true), story = ref('保留故事草稿')
  const page = defineComponent({ setup: () => () => h(ShotScriptDialog, {
    open: open.value, story: story.value, busy: false, count: null, total: null,
    countOptions: [], totalOptions: [], referenceLabels: [], onClose: () => { open.value = false },
    'onUpdate:story': value => { story.value = value },
  }) })
  const wrapper = mount(defineComponent({ setup: () => () => h(KeepAlive, null, {
    default: () => active.value ? h(page) : null,
  }) }), { attachTo: document.body, global: { stubs: { FluidTransition: { template: '<slot />' } } } })
  try {
    expect(document.querySelector('.shot-script-panel')).not.toBeNull()
    active.value = false; await nextTick(); await nextTick()
    expect(open.value).toBe(false)
    expect(document.querySelector('.shot-script-panel')).toBeNull()
    expect(story.value).toBe('保留故事草稿')
    active.value = true; await nextTick()
    expect(document.querySelector('.shot-script-panel')).toBeNull()
  } finally { wrapper.unmount() }
})

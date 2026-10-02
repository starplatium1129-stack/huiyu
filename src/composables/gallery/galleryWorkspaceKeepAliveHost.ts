import { defineComponent, h, KeepAlive, type Component, type Ref } from 'vue'

/** Separate the lifecycle-test host from its cached gallery child. */
export function createGalleryKeepAliveHost(active: Ref<boolean>, child: Component) {
  return defineComponent({
    setup: () => () => h(KeepAlive, null, { default: () => active.value ? h(child) : null }),
  })
}

<script setup lang="ts">
import { onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, shallowRef, type Component, type ShallowRef } from 'vue'
import StudioOrbitSpinner from './StudioOrbitSpinner.vue'

const props = defineProps<{ loader: () => Promise<{ default: Component }>; label: string }>()
const panel: ShallowRef<Component | null> = shallowRef(null)
const host = ref<HTMLElement | null>(null)
const loading = ref(false), failed = ref(false)
let available: Component | null = null, active = true, disposed = false

async function load() {
  if (loading.value || panel.value || !active || disposed) return
  loading.value = true; failed.value = false
  try {
    const result = await props.loader()
    if (disposed) return
    available = result.default
    if (active) panel.value = available
  } catch { if (!disposed) failed.value = true }
  finally { if (!disposed) loading.value = false }
}
function retry() {
  // Keep a keyboard retry on this region as its button becomes loading feedback.
  host.value?.focus({ preventScroll: true })
  void load()
}
onMounted(() => { void load() })
onActivated(() => {
  active = true
  if (available) panel.value = available
  else if (!failed.value) void load()
})
onDeactivated(() => { active = false })
onBeforeUnmount(() => { disposed = true })
</script>

<template>
  <div ref="host" class="async-panel" role="region" :aria-label="label" :aria-busy="loading" tabindex="-1">
    <slot v-if="panel" :component="panel" />
    <div v-else class="async-panel-feedback">
      <p v-if="failed" role="alert">{{ label }}暂未加载，请重新读取。</p>
      <p v-else class="async-panel-loading" role="status"><StudioOrbitSpinner />正在打开{{ label }}…</p>
      <button v-if="failed" class="btn btn-ghost btn-sm" type="button" @click="retry">重新读取</button>
    </div>
  </div>
</template>

<style scoped>
.async-panel { min-width:0; }
.async-panel:focus-visible { outline:none; box-shadow:var(--focus-shadow); border-radius:var(--r-md); }
.async-panel-feedback { display:grid; justify-items:start; gap:var(--s-3); padding:var(--s-4); border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-surface); color:var(--text-primary); }
.async-panel-feedback p { margin:0; line-height:var(--lh-body); }
.async-panel-loading { display:flex; align-items:center; gap:var(--s-3); }
@media (forced-colors:active) { .async-panel:focus-visible { outline:2px solid Highlight; outline-offset:2px; box-shadow:none; } }
</style>

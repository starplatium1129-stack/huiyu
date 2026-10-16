<!-- Lucian UX/UI Prompt #008 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#008 -->
<script setup lang="ts">
import { computed, onActivated, onDeactivated, onScopeDispose, ref, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { useMotionPreference } from '@/composables/useMotionPreference'

const props = defineProps<{ action: () => Promise<boolean>; label: string; contentKey: string; disabled?: boolean }>()
const reduced = useMotionPreference()
const state = ref<'idle' | 'pending' | 'copied' | 'error'>('idle')
const feedback = computed(() => state.value === 'pending' ? '正在复制' : state.value === 'copied' ? '已复制' : state.value === 'error' ? '重试复制' : props.label)
const notice = ref('')
let timer: ReturnType<typeof setTimeout> | undefined
let revision = 0, active = true
function reset() { revision++; clearTimeout(timer); state.value = 'idle'; notice.value = '' }
watch(() => props.contentKey, reset)
onActivated(() => { active = true })
onDeactivated(() => { active = false; reset() })
onScopeDispose(() => { active = false; reset() })
async function copy() {
  if (state.value === 'pending' || props.disabled) return
  const request = ++revision
  clearTimeout(timer)
  state.value = 'pending'; notice.value = ''
  try {
    const success = await props.action()
    if (!active || request !== revision) return
    state.value = success ? 'copied' : 'error'
    notice.value = success ? '已复制' : '复制未完成，请重试'
    if (success) timer = setTimeout(() => { state.value = 'idle'; notice.value = '' }, 1800)
  } catch {
    if (active && request === revision) { state.value = 'error'; notice.value = '复制未完成，请重试' }
  }
}
</script>

<template>
  <button class="u008" :class="{ 'btn-copied-success': state === 'copied' }" type="button" :data-state="state" :data-reduced-motion="reduced" :disabled="disabled || state === 'pending'" :aria-label="state === 'idle' ? label : `${feedback}：${label}`" :aria-busy="state === 'pending'" @click="copy">
    <span class="u008-icons" aria-hidden="true">
      <ArchiveIcon class="u008-cp" name="copy" /><ArchiveIcon class="u008-ok" name="success" />
      <ArchiveIcon class="u008-wait" name="refresh" /><ArchiveIcon class="u008-error" name="warning" />
    </span>
    <span class="u008-label" aria-hidden="true">
      <span class="u008-measure">{{ label }}</span><span class="u008-measure">正在复制</span><span class="u008-measure">重试复制</span><span class="u008-measure">已复制</span>
      <span :key="state" class="u008-feedback">{{ feedback }}</span>
    </span>
    <span class="u008-live" role="status">{{ notice }}</span>
  </button>
</template>

<style scoped>
.u008 { position:relative; isolation:isolate; }
.u008-icons { position:relative; display:inline-grid; place-items:center; width:20px; height:20px; flex:none; }
.u008-icons .archive-icon { position:absolute; width:20px; height:20px; opacity:0; transform:scale(.85); transition:opacity var(--motion-hover) var(--ease-out),transform var(--motion-control) var(--ease-out); }
.u008[data-state='idle'] .u008-cp,
.u008[data-state='copied'] .u008-ok,
.u008[data-state='pending'] .u008-wait,
.u008[data-state='error'] .u008-error { opacity:1; transform:none; }
.u008[data-state='copied'] { background:var(--success); color:var(--text-inverse); border-color:transparent; }
.u008[data-state='error'] { background:var(--bg-surface); color:var(--danger-text); border-color:var(--danger-text); }
.u008-label { display:inline-grid; text-align:center; }
.u008-label > span { grid-area:1/1; white-space:nowrap; }
.u008-measure { visibility:hidden; }
.u008-feedback { animation:u008-label-in var(--motion-hover) var(--ease-out); }
.u008-live { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
.u008:disabled { color:var(--text-disabled); background:var(--bg-elevated); opacity:1; }
.u008:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.u008[data-state='pending'] .u008-wait { animation:u008-spin 1s linear infinite; }
@keyframes u008-label-in { from { opacity:0; transform:translateY(3px); } }
@keyframes u008-spin { to { transform:rotate(360deg); } }
.u008[data-reduced-motion='true'] * { animation:none !important; transition:none !important; }
@media (forced-colors:active) { .u008[data-state='copied'],.u008[data-state='error'] { background:ButtonFace; color:ButtonText; border-color:ButtonText; } .u008:focus-visible { outline:2px solid Highlight; outline-offset:2px; } }
</style>

<!-- Lucian UX/UI Prompt #008 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#008 -->
<script setup lang="ts">
import { onActivated, onDeactivated, onScopeDispose, ref, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { useMotionPreference } from '@/composables/useMotionPreference'

const props = defineProps<{ action: () => Promise<boolean>; label: string; contentKey: string; disabled?: boolean }>()
const reduced = useMotionPreference()
const copied = ref(false), pending = ref(false), notice = ref('')
let timer: ReturnType<typeof setTimeout> | undefined
let revision = 0, active = true
function reset() { revision++; clearTimeout(timer); copied.value = false; pending.value = false; notice.value = '' }
watch(() => props.contentKey, reset)
onActivated(() => { active = true })
onDeactivated(() => { active = false; reset() })
onScopeDispose(() => { active = false; reset() })
async function copy() {
  if (pending.value || props.disabled) return
  const request = ++revision
  clearTimeout(timer)
  copied.value = false; notice.value = ''
  pending.value = true
  try {
    const success = await props.action()
    if (!active || request !== revision) return
    copied.value = success
    notice.value = success ? '已复制' : '复制未完成'
    timer = setTimeout(() => { copied.value = false; notice.value = '' }, 1800)
  } catch {
    if (active && request === revision) { copied.value = false; notice.value = '复制未完成，请重试' }
  } finally { if (request === revision) pending.value = false }
}
</script>

<template>
  <button class="u008" :class="{ 'btn-copied-success': copied }" type="button" :data-copied="copied" :data-reduced-motion="reduced" :disabled="disabled || pending" :aria-label="label" :aria-busy="pending" @click="copy">
    <span class="u008-icons" aria-hidden="true"><ArchiveIcon class="u008-cp" name="copy" /><ArchiveIcon class="u008-ok" name="success" /></span>
    <span class="u008-label">{{ copied ? '已复制' : label }}</span>
    <span class="u008-tip" role="status">{{ notice }}</span>
  </button>
</template>

<style scoped>
.u008 { --ux-ease:cubic-bezier(.2,.8,.2,1); --ux-spring:cubic-bezier(.34,1.45,.64,1); position:relative; isolation:isolate; }
.u008-icons { position:relative; display:inline-grid; place-items:center; width:21px; height:21px; flex:none; }
.u008-icons .archive-icon { position:absolute; width:21px; height:21px; transition:opacity .25s var(--ux-ease),transform .5s var(--ux-spring); }
.u008-ok { opacity:0; transform:scale(.4) rotate(-30deg); }
.u008-ok :deep(path) { stroke-dasharray:24; stroke-dashoffset:24; transition:stroke-dashoffset .4s var(--ux-ease) .1s; }
.u008[data-copied='true'] { background:var(--success); color:var(--text-inverse); }
.u008[data-copied='true'] .u008-cp { opacity:0; transform:scale(.4) rotate(30deg); }
.u008[data-copied='true'] .u008-ok { opacity:1; transform:none; }
.u008[data-copied='true'] .u008-ok :deep(path) { stroke-dashoffset:0; }
.u008-label { position:relative; }
.u008-label::after { content:''; position:absolute; inset:auto 0 -3px; height:2px; background:var(--success); opacity:0; transform:scaleX(0); transform-origin:left; }
.u008[data-copied='true'] .u008-label::after { animation:u008-sweep .7s var(--ux-ease); }
.u008-tip { position:absolute; right:0; bottom:calc(100% + 8px); padding:7px 12px; border-radius:var(--r-md); background:var(--text-primary); color:var(--bg-base); font-size:var(--fs-label-sm); font-weight:600; white-space:nowrap; pointer-events:none; opacity:0; transform:translateY(8px) scale(.8); transform-origin:80% 100%; transition:opacity .25s var(--ux-ease),transform .5s var(--ux-spring); }
.u008-tip:not(:empty) { opacity:1; transform:none; }
.u008-tip::after { content:''; position:absolute; right:18px; bottom:-4px; width:8px; height:8px; background:inherit; transform:rotate(45deg); }
.u008:disabled { color:var(--text-disabled); background:var(--bg-elevated); opacity:1; }
.u008:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
@keyframes u008-sweep { 0% { opacity:0; transform:scaleX(0); } 50% { opacity:1; } 100% { opacity:0; transform:scaleX(1); } }
.u008[data-reduced-motion='true'] *, .u008[data-reduced-motion='true'] :deep(path), .u008[data-reduced-motion='true'] *::after { animation:none !important; transition:none !important; }
</style>

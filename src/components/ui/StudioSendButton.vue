<!-- Lucian UX/UI Prompt #005 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#005 -->
<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { useSendButtonMotion } from '@/composables/chat/useSendButtonMotion'
const props = defineProps<{ busy: boolean; disabled: boolean; turnId: string; completed: boolean; context: string; messageHost?: HTMLElement | null }>()
const emit = defineEmits<{ send: []; stop: [] }>()
const { plane, flying, feedback, reduced } = useSendButtonMotion({
  busy:() => props.busy, turnId:() => props.turnId, completed:() => props.completed,
  context:() => props.context, messageHost:() => props.messageHost,
})
</script>

<template>
  <button class="u005" type="button" :data-busy="busy" :data-flying="flying" :data-feedback="feedback" :data-reduced-motion="reduced" :disabled="!busy && disabled" :aria-label="busy ? '停止回复或语音' : '发送'" :aria-busy="busy" @click="busy ? emit('stop') : emit('send')">
    <span class="u005-idle" aria-hidden="true"><ArchiveIcon name="send" /></span>
    <span class="u005-ring" aria-hidden="true" />
    <ArchiveIcon v-if="busy" class="u005-stop" name="stop" />
    <ArchiveIcon class="u005-check" name="success" />
    <svg class="u005-trail" viewBox="0 0 340 340" aria-hidden="true"><path d="M200 330 C170 270 50 260 50 190 C50 125 130 115 140 165 C150 210 75 220 80 160 C85 95 190 50 290 0" /></svg>
    <span ref="plane" class="u005-plane" aria-hidden="true"><ArchiveIcon name="send" /></span>
  </button>
</template>

<style scoped>
.u005 { position:relative; display:grid; place-items:center; flex:none; width:42px; height:42px; border:0; padding:0; border-radius:50%; background:linear-gradient(140deg,var(--accent-violet),var(--accent)); color:var(--text-inverse); cursor:pointer; isolation:isolate; transition:transform .35s cubic-bezier(.34,1.45,.64,1); }
.u005 .archive-icon { width:22px; height:22px; }
.u005-idle { display:grid; place-items:center; transform:translate(-1px,1px) rotate(-18deg); transition:transform .45s cubic-bezier(.34,1.45,.64,1),opacity .2s; }
.u005[data-busy='true'] { background:var(--bg-elevated); color:var(--text-primary); }
.u005[data-busy='true'] .u005-idle { opacity:0; transform:translate(10px,-10px) rotate(-30deg) scale(.6); }
.u005-stop,.u005-check { position:absolute; }
.u005-ring { position:absolute; inset:-4px; border:2px solid transparent; border-top-color:var(--accent); border-right-color:var(--accent); border-radius:50%; opacity:0; pointer-events:none; }
.u005[data-busy='true'] .u005-ring { opacity:1; animation:u005-ring 1.4s linear infinite; }
.u005-check { opacity:0; }
.u005-check :deep(path) { stroke-dasharray:24; stroke-dashoffset:24; transition:stroke-dashoffset .35s .05s; }
.u005[data-feedback='done']:not([data-busy='true']) { background:var(--success); color:var(--text-inverse); }
.u005[data-feedback='done']:not([data-busy='true']) .u005-check { opacity:1; }
.u005[data-feedback='done'] .u005-check :deep(path) { stroke-dashoffset:0; }
.u005[data-feedback='done'] .u005-idle { opacity:0; }
.u005[data-feedback='back'] .u005-idle { animation:u005-back .6s cubic-bezier(.2,1.2,.4,1) both; }
.u005-plane { position:absolute; left:calc(50% - 17px); top:calc(50% - 15px); width:34px; height:30px; opacity:0; color:var(--accent); pointer-events:none; }
.u005-plane .archive-icon { width:100%; height:100%; }
.u005-trail { position:absolute; right:calc(50% - 140px); bottom:calc(50% - 10px); width:340px; height:340px; overflow:visible; opacity:0; pointer-events:none; transition:opacity .6s; }
.u005-trail path { fill:none; stroke:var(--accent); stroke-width:1.6; stroke-linecap:round; stroke-dasharray:1.5 6; }
.u005[data-flying='true'] .u005-trail { opacity:.7; }
.u005:active:not(:disabled) { transform:scale(.9); }
.u005:disabled { color:var(--text-disabled); background:var(--bg-elevated); cursor:not-allowed; }
.u005:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
@media (pointer:coarse) { .u005 { width:44px; height:44px; } }
@keyframes u005-ring { to { transform:rotate(360deg); } }
@keyframes u005-back { from { opacity:0; transform:translate(-26px,14px) rotate(10deg) scale(.7); } }
.u005[data-reduced-motion='true'],.u005[data-reduced-motion='true'] *,.u005[data-reduced-motion='true'] :deep(path) { animation:none !important; transition:none !important; }
</style>

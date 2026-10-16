<!-- Lucian UX/UI Prompt #004 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#004 -->
<script setup lang="ts">
import { computed, onActivated, onDeactivated, onMounted, onScopeDispose, ref, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { listenMotionChanges, prefersReducedMotion } from '@/utils/motionPreference'

const props = defineProps<{
  label: string
  size: string
  busy: boolean
  phaseLabel: string
  progress: number
  complete: boolean
  disabled: boolean
  retry: boolean
}>()
const emit = defineEmits<{ download: []; cancel: [] }>()
const state = ref<'idle' | 'run' | 'fold' | 'done'>('idle')
const reducedMotion = ref(prefersReducedMotion())
const percent = computed(() => Math.max(0, Math.min(100, Math.floor(props.progress))))
const successful = computed(() => state.value === 'fold' || state.value === 'done')
const accessibleLabel = computed(() => props.busy
  ? `取消${props.label}的下载；${props.phaseLabel}，${percent.value}%`
  : `${successful.value ? '已保存并校验；重新下载' : props.retry ? '重试下载' : '下载'} ${props.label}（${props.size}）`)
let foldTimer: ReturnType<typeof setTimeout> | undefined
let resetTimer: ReturnType<typeof setTimeout> | undefined
let stopListening: (() => void) | undefined

function clearTimers() {
  clearTimeout(foldTimer)
  clearTimeout(resetTimer)
  foldTimer = resetTimer = undefined
}
function settle() {
  clearTimers()
  if (state.value === 'fold') state.value = 'done'
}
function startListening() {
  reducedMotion.value = prefersReducedMotion()
  if (reducedMotion.value) settle()
  stopListening ??= listenMotionChanges(() => {
    reducedMotion.value = prefersReducedMotion()
    if (reducedMotion.value) settle()
  }, () => { if (document.hidden) settle() })
}
function stopMotion() {
  settle()
  stopListening?.()
  stopListening = undefined
}
watch([() => props.busy, () => props.complete], ([busy, complete]) => {
  clearTimers()
  if (busy) state.value = 'run'
  else if (!complete) state.value = 'idle'
  else if (prefersReducedMotion() || document.hidden) state.value = 'done'
  else {
    state.value = 'fold'
    foldTimer = setTimeout(() => { state.value = 'done' }, 650)
    resetTimer = setTimeout(() => { state.value = 'idle' }, 3400)
  }
}, { immediate: true })
onMounted(startListening)
onActivated(startListening)
onDeactivated(stopMotion)
onScopeDispose(stopMotion)
</script>

<template>
  <div class="u004" :data-state="state" :data-reduced-motion="reducedMotion">
    <button
      class="u004-btn"
      type="button"
      :disabled="disabled"
      :aria-label="accessibleLabel"
      :aria-busy="busy"
      @click="busy ? emit('cancel') : emit('download')"
    >
      <span class="u004-shape" aria-hidden="true">
        <span class="u004-middle" />
        <span class="u004-cap u004-cap-left" />
        <span class="u004-cap u004-cap-right" />
      </span>
      <span class="u004-track" aria-hidden="true"><span class="u004-bar" :style="{ transform: `scaleX(${percent / 100})` }" /></span>
      <span class="u004-idle" aria-hidden="true">
        <span class="u004-arw"><ArchiveIcon name="download" /></span>
        <b>{{ retry ? '重试下载' : '下载' }}</b><small>{{ size }}</small>
      </span>
      <span class="u004-run" aria-hidden="true">
        <b>{{ percent }}%</b><small><span>{{ phaseLabel }}</span><span>点击取消</span></small>
      </span>
      <span class="u004-ok" aria-hidden="true">
        <i><ArchiveIcon name="success" /></i><span>已保存并校验</span>
      </span>
    </button>
    <span v-if="busy" class="u004-live" role="progressbar" :aria-label="`${label}：${phaseLabel}`" :aria-valuenow="percent" :aria-valuemin="0" :aria-valuemax="100" />
  </div>
</template>

<style scoped>
.u004 {
  --ux-page: var(--text-inverse);
  --ux-ink: var(--accent);
  --ux-accent: var(--accent);
  --ux-accent-ink: var(--text-inverse);
  --ux-mint: var(--success);
  --ux-ease: var(--ease-out);
  --ux-spring: var(--ease-out);
  --bar: var(--accent);
  width: 240px;
  max-width: 100%;
  min-width: 0;
  height: 48px;
  flex-shrink: 0;
}
.u004-btn {
  position: relative;
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  padding: 0;
  border-radius: var(--r-md);
  background: transparent;
  color: var(--ux-page);
  font: inherit;
  cursor: pointer;
  isolation: isolate;
  transition: transform var(--motion-press) var(--ux-spring);
}
.u004-btn:focus-visible { outline: 2px solid var(--ux-accent); outline-offset: 4px; }
.u004-btn:active:not(:disabled) { transform: scale(.97); }
.u004-shape, .u004-track, .u004-idle, .u004-run, .u004-ok { position: absolute; inset: 0; pointer-events: none; }
/* Translate the round ends and scale only the bridge, keeping text and the hit area stable. */
.u004-middle, .u004-cap::before { position: absolute; top: 0; bottom: 0; background: var(--ux-ink); transition: background-color var(--motion-hover) var(--ux-ease); }
.u004-middle { left: 24px; right: 24px; transition: transform var(--motion-surface) var(--ux-ease), background-color var(--motion-hover) var(--ux-ease); }
.u004-cap { position: absolute; inset: 0; transition: transform var(--motion-surface) var(--ux-ease); }
.u004-cap::before { content: ''; width: 48px; border-radius: var(--r-md); }
.u004-cap-left::before { left: 0; }
.u004-cap-right::before { right: 0; }
.u004-idle, .u004-run, .u004-ok { display: flex; align-items: center; transition: opacity var(--motion-hover) var(--ux-ease), transform var(--motion-press) var(--ux-ease); }
.u004-idle { gap: var(--s-2); padding: 0 var(--s-3); }
.u004-arw { width: 30px; height: 30px; flex-shrink: 0; border-radius: var(--r-sm); display: grid; place-items: center; background: color-mix(in srgb, var(--ux-page) 14%, transparent); overflow: hidden; }
.u004-arw .archive-icon { width: 22px; height: 22px; }
.u004-arw :deep(path:first-child) { transition: transform var(--motion-press) var(--ux-ease); }
.u004-idle b { font-size: var(--fs-label); font-weight: 700; white-space: nowrap; }
.u004-idle small { margin-left: auto; font-size: 13px; font-weight: 600; white-space: nowrap; }
.u004-track { border-radius: inherit; overflow: hidden; opacity: 0; background: color-mix(in srgb,var(--accent) 75%,var(--bg-deep)); transition: opacity var(--motion-hover) var(--ux-ease); }
.u004-bar { position: absolute; inset: 0; background: var(--bar); transform-origin: 0 50%; }
.u004-bar::after { content: ''; position: absolute; inset: auto 0 0; height: 8px; background: linear-gradient(100deg, transparent 30%, var(--on-art-sheen) 50%, transparent 70%); transform: translateX(-100%); }
.u004-run { justify-content: space-between; gap: var(--s-2); padding: 0 var(--s-3); opacity: 0; transform: translateY(12px); color: var(--ux-accent-ink); }
.u004-run b { font-size: var(--fs-label); font-weight: 760; font-variant-numeric: tabular-nums; }
.u004-run small { display: grid; gap: 2px; font-size: 13px; font-weight: 600; text-align: right; }
.u004-run :is(b,small) { padding:2px 6px; border-radius:var(--r-sm); background:var(--bg-surface); color:var(--text-primary); }
.u004-ok { justify-content: center; gap: 10px; opacity: 0; transform: scale(.6); color: var(--ux-accent-ink); }
.u004-ok i { position: absolute; left: calc(50% - 15px); width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; background: color-mix(in srgb, currentColor 18%, transparent); transition: transform var(--motion-surface) var(--ux-ease); }
.u004-ok .archive-icon { width: 20px; height: 20px; }
.u004-ok :deep(path) { stroke-dasharray: 24; stroke-dashoffset: 24; transition: stroke-dashoffset .45s var(--ux-ease) .25s; }
.u004-ok > span { position: absolute; left: calc(50% - 28px); font-size: 16px; font-weight: 700; white-space: nowrap; opacity: 0; transform: translateX(-8px); transition: transform var(--motion-surface) var(--ux-ease), opacity var(--motion-hover) var(--ux-ease); }
.u004[data-state='run'] .u004-idle { opacity: 0; transform: translateY(-12px); }
.u004[data-state='run'] .u004-arw :deep(path:first-child) { transform: translateY(26px); }
.u004[data-state='run'] .u004-track { opacity: 1; }
.u004[data-state='run'] .u004-bar::after { animation: u004-shine 1.3s linear infinite; }
.u004[data-state='run'] .u004-run { opacity: 1; transform: none; }
.u004[data-state='fold'] .u004-cap-left { transform: translateX(calc(50% - 24px)); }
.u004[data-state='fold'] .u004-cap-right { transform: translateX(calc(24px - 50%)); }
.u004[data-state='fold'] .u004-middle { transform: scaleX(0); }
.u004:is([data-state='fold'], [data-state='done']) .u004-idle { opacity: 0; }
.u004:is([data-state='fold'], [data-state='done']) .u004-middle,
.u004:is([data-state='fold'], [data-state='done']) .u004-cap::before { background: var(--ux-mint); }
.u004:is([data-state='fold'], [data-state='done']) .u004-ok { opacity: 1; transform: none; }
.u004:is([data-state='fold'], [data-state='done']) .u004-ok :deep(path) { stroke-dashoffset: 0; }
.u004[data-state='done'] :is(.u004-middle, .u004-cap) { transition-timing-function: var(--ux-spring); }
.u004[data-state='done'] .u004-ok i { transform: translateX(-53px); }
.u004[data-state='done'] .u004-ok > span { opacity: 1; transform: none; }
.u004-btn:disabled { color: var(--text-disabled); cursor: not-allowed; }
.u004-btn:disabled .u004-middle,
.u004-btn:disabled .u004-cap::before { background: var(--bg-elevated); }
.u004-btn:disabled .u004-ok { color: var(--text-disabled); }
.u004-live { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (hover: hover) and (pointer: fine) {
  .u004-btn:hover:not(:disabled) { transform: translateY(-2px); }
  .u004[data-state='idle'] .u004-btn:hover:not(:disabled) .u004-arw :deep(path:first-child) { animation: u004-bob 1s var(--ux-ease) infinite; }
}
@keyframes u004-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(3px); } }
@keyframes u004-shine { from { transform: translateX(100%); } to { transform: translateX(-100%); } }
.u004[data-reduced-motion='true'] *,
.u004[data-reduced-motion='true'] :deep(path),
.u004[data-reduced-motion='true'] *::before,
.u004[data-reduced-motion='true'] *::after { animation: none !important; transition: none !important; }
</style>

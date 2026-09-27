<template>
  <section class="workspace-archive-bar tw:flex tw:items-center tw:gap-s-4 tw:min-h-[44px] tw:mb-s-5 tw:py-s-3 tw:px-0 tw:[border-bottom:1px_solid_var(--border-soft)]" :data-state="state" :data-shape="shape" :aria-label="`${title}状态`">
    <div class="workspace-code tw:flex-none tw:[color:var(--character-accent)] tw:[font:500_var(--fs-label)/var(--lh-label)_var(--font-mono)]" aria-hidden="true">
      <span>{{ chapter }}</span>
    </div>
    <div class="workspace-copy tw:flex tw:items-baseline tw:flex-wrap tw:gap-s-3 tw:flex-1 tw:min-w-0">
      <strong class="tw:text-secondary tw:[font:500_var(--fs-label-xs)/var(--lh-label)_var(--font-sans)] tw:tracking-[.1em]">{{ title }}</strong>
      <span class="tw:text-muted tw:text-label-xs tw:[overflow-wrap:anywhere]">{{ subtitle }}</span>
    </div>
    <div class="workspace-state tw:flex tw:items-center tw:gap-s-2 tw:text-secondary tw:[font:500_var(--fs-label-xs)/var(--lh-label)_var(--font-sans)]" role="status" aria-live="polite">
      <span class="workspace-state-dot tw:w-[5px] tw:h-[5px] tw:shrink-0 tw:rounded-full tw:[background:var(--text-muted)]" aria-hidden="true"></span>
      {{ status }}
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, watch } from 'vue'
import type { ParticleShapeId } from '@/utils/particleShapes'
import { emitParticleSignal, type ParticleSignalState } from '@/utils/particleSignal'

const props = withDefaults(defineProps<{
  chapter: string
  title: string
  subtitle: string
  status: string
  state?: ParticleSignalState
  shape?: ParticleShapeId
}>(), {
  state: 'idle',
  shape: 'atelier',
})

function signal() {
  emitParticleSignal({
    state: props.state,
    shape: props.shape,
    label: props.status,
    duration: props.state === 'active' ? 1800 : 1050,
  })
}

onMounted(signal)
watch(() => [props.state, props.shape, props.status], signal)
</script>

<style scoped>
[data-state="active"] .workspace-state-dot { background: var(--character-accent); }
[data-state="success"] .workspace-state-dot { background: var(--success); }
[data-state="warning"] .workspace-state-dot { background: var(--warning); }
@media(max-width: 480px) { .workspace-archive-bar { flex-wrap: wrap; gap: var(--s-2); } .workspace-state { margin-left: auto; } }
</style>

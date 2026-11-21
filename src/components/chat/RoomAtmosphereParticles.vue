<template>
  <div
    v-if="enabled && !suspended"
    class="room-atmosphere-particles"
    :data-motif="motif"
    aria-hidden="true"
  >
    <span
      v-for="particle in particles"
      :key="particle.id"
      class="room-particle"
      :style="particle.style"
    >
      <svg
        v-if="motif === 'petals'"
        class="room-petal-svg"
        viewBox="0 0 18 14"
        focusable="false"
      >
        <path d="M2 7 C5 1.5 13 1.2 16.5 6.8 C13 12.6 5.2 12.4 2 7 Z" />
      </svg>
      <span v-else class="room-mote-orb" />
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed, type CSSProperties } from 'vue'

const props = withDefaults(defineProps<{
  characterId: string
  enabled?: boolean
  suspended?: boolean
}>(), {
  enabled: true,
  suspended: false,
})

const motif = computed<'petals' | 'amber' | 'motes'>(() => {
  if (props.characterId === 'nene') return 'petals'
  if (props.characterId === 'natsume') return 'amber'
  return 'motes'
})

interface ParticleSpec {
  id: number
  style: CSSProperties
}

const PETAL_SPECS: readonly ParticleSpec[] = [
  { id: 1, style: { '--p-x': '8%', '--p-drift': '42px', '--p-size': '14px', '--p-dur': '11.5s', '--p-delay': '-1.8s', '--p-rot': '135deg', '--p-alpha': '0.52' } as CSSProperties },
  { id: 2, style: { '--p-x': '20%', '--p-drift': '56px', '--p-size': '11px', '--p-dur': '13.2s', '--p-delay': '-6.4s', '--p-rot': '-110deg', '--p-alpha': '0.44' } as CSSProperties },
  { id: 3, style: { '--p-x': '76%', '--p-drift': '-36px', '--p-size': '15px', '--p-dur': '12.4s', '--p-delay': '-3.5s', '--p-rot': '160deg', '--p-alpha': '0.48' } as CSSProperties },
  { id: 4, style: { '--p-x': '88%', '--p-drift': '-48px', '--p-size': '12px', '--p-dur': '14.6s', '--p-delay': '-9.1s', '--p-rot': '-145deg', '--p-alpha': '0.42' } as CSSProperties },
  { id: 5, style: { '--p-x': '14%', '--p-drift': '34px', '--p-size': '10px', '--p-dur': '15.4s', '--p-delay': '-11.2s', '--p-rot': '95deg', '--p-alpha': '0.38' } as CSSProperties },
  { id: 6, style: { '--p-x': '66%', '--p-drift': '28px', '--p-size': '13px', '--p-dur': '13.8s', '--p-delay': '-4.7s', '--p-rot': '-125deg', '--p-alpha': '0.40' } as CSSProperties },
  { id: 7, style: { '--p-x': '92%', '--p-drift': '-26px', '--p-size': '11px', '--p-dur': '12.0s', '--p-delay': '-7.8s', '--p-rot': '120deg', '--p-alpha': '0.46' } as CSSProperties },
]

const MOTE_SPECS: readonly ParticleSpec[] = [
  { id: 1, style: { '--p-x': '12%', '--p-drift': '18px', '--p-size': '7px', '--p-dur': '9.8s', '--p-delay': '-1.2s', '--p-alpha': '0.58' } as CSSProperties },
  { id: 2, style: { '--p-x': '24%', '--p-drift': '-16px', '--p-size': '5px', '--p-dur': '11.4s', '--p-delay': '-4.6s', '--p-alpha': '0.46' } as CSSProperties },
  { id: 3, style: { '--p-x': '74%', '--p-drift': '-20px', '--p-size': '8px', '--p-dur': '10.6s', '--p-delay': '-2.9s', '--p-alpha': '0.54' } as CSSProperties },
  { id: 4, style: { '--p-x': '86%', '--p-drift': '14px', '--p-size': '6px', '--p-dur': '12.8s', '--p-delay': '-7.1s', '--p-alpha': '0.48' } as CSSProperties },
  { id: 5, style: { '--p-x': '18%', '--p-drift': '22px', '--p-size': '4px', '--p-dur': '13.6s', '--p-delay': '-8.8s', '--p-alpha': '0.40' } as CSSProperties },
  { id: 6, style: { '--p-x': '62%', '--p-drift': '16px', '--p-size': '5px', '--p-dur': '11.9s', '--p-delay': '-5.4s', '--p-alpha': '0.44' } as CSSProperties },
  { id: 7, style: { '--p-x': '90%', '--p-drift': '-14px', '--p-size': '7px', '--p-dur': '10.2s', '--p-delay': '-3.7s', '--p-alpha': '0.50' } as CSSProperties },
  { id: 8, style: { '--p-x': '34%', '--p-drift': '-12px', '--p-size': '4px', '--p-dur': '14.2s', '--p-delay': '-10.5s', '--p-alpha': '0.38' } as CSSProperties },
]

const particles = computed(() => (motif.value === 'petals' ? PETAL_SPECS : MOTE_SPECS))
</script>

<style scoped>
.room-atmosphere-particles {
  position: absolute;
  inset: 0;
  z-index: var(--z-raised);
  overflow: hidden;
  pointer-events: none;
  container-type: size;
}

.room-particle {
  position: absolute;
  left: var(--p-x, 12%);
  top: 0;
  width: var(--p-size, 12px);
  height: var(--p-size, 12px);
  opacity: 0;
  pointer-events: none;
}

.room-petal-svg {
  display: block;
  width: 100%;
  height: 100%;
  fill: color-mix(in srgb, var(--nene-violet) 58%, var(--on-art-primary));
}

:global(:root[data-theme="light"]) .room-petal-svg {
  fill: color-mix(in srgb, var(--nene-violet) 56%, var(--bg-surface));
}

.room-mote-orb {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  background: radial-gradient(
    circle at 38% 38%,
    color-mix(in srgb, var(--on-art-primary) 88%, var(--character-accent, var(--natsume-amber))) 0%,
    color-mix(in srgb, var(--character-accent, var(--natsume-amber)) 82%, transparent) 55%,
    transparent 100%
  );
}

:global(:root[data-theme="light"]) .room-mote-orb {
  background: radial-gradient(
    circle at 38% 38%,
    color-mix(in srgb, var(--character-accent, var(--natsume-amber)) 78%, var(--bg-surface)) 0%,
    color-mix(in srgb, var(--character-accent, var(--natsume-amber)) 42%, transparent) 60%,
    transparent 100%
  );
}

.room-atmosphere-particles[data-motif="amber"] .room-mote-orb {
  background: radial-gradient(
    circle at 38% 38%,
    color-mix(in srgb, var(--editorial-gold) 88%, var(--on-art-primary)) 0%,
    color-mix(in srgb, var(--natsume-amber) 76%, transparent) 56%,
    transparent 100%
  );
}

:global(:root[data-theme="light"]) .room-atmosphere-particles[data-motif="amber"] .room-mote-orb {
  background: radial-gradient(
    circle at 38% 38%,
    color-mix(in srgb, var(--natsume-amber) 76%, var(--bg-surface)) 0%,
    color-mix(in srgb, var(--editorial-gold) 44%, transparent) 62%,
    transparent 100%
  );
}

/* Opt in to ambient particle motion when motion is allowed; pure transform/opacity only. */
@media (prefers-reduced-motion: no-preference) {
  .room-atmosphere-particles[data-motif="petals"] .room-particle {
    animation: room-petal-fall var(--p-dur, 12s) var(--ease-in-out) var(--p-delay, 0s) infinite;
  }
  .room-atmosphere-particles:not([data-motif="petals"]) .room-particle {
    top: 100%;
    animation: room-mote-rise var(--p-dur, 11s) var(--ease-in-out) var(--p-delay, 0s) infinite;
  }
}

:global(:root[data-motion="full"]) .room-atmosphere-particles[data-motif="petals"] .room-particle {
  animation: room-petal-fall var(--p-dur, 12s) var(--ease-in-out) var(--p-delay, 0s) infinite;
}

:global(:root[data-motion="full"]) .room-atmosphere-particles:not([data-motif="petals"]) .room-particle {
  top: 100%;
  animation: room-mote-rise var(--p-dur, 11s) var(--ease-in-out) var(--p-delay, 0s) infinite;
}

@keyframes room-petal-fall {
  0% {
    opacity: 0;
    transform: translate3d(0, -18px, 0) rotate(0deg) scale(0.86);
  }
  14% {
    opacity: var(--p-alpha, 0.45);
  }
  52% {
    opacity: var(--p-alpha, 0.45);
    transform: translate3d(calc(var(--p-drift, 36px) * 0.55), 48cqh, 0) rotate(calc(var(--p-rot, 120deg) * 0.55)) scale(1);
  }
  86% {
    opacity: calc(var(--p-alpha, 0.45) * 0.65);
  }
  100% {
    opacity: 0;
    transform: translate3d(var(--p-drift, 36px), 98cqh, 0) rotate(var(--p-rot, 120deg)) scale(0.82);
  }
}

@keyframes room-mote-rise {
  0% {
    opacity: 0;
    transform: translate3d(0, 12px, 0) scale(0.7);
  }
  20% {
    opacity: var(--p-alpha, 0.48);
  }
  55% {
    opacity: calc(var(--p-alpha, 0.48) * 0.92);
    transform: translate3d(calc(var(--p-drift, 16px) * 0.6), -46cqh, 0) scale(1.06);
  }
  85% {
    opacity: calc(var(--p-alpha, 0.48) * 0.45);
  }
  100% {
    opacity: 0;
    transform: translate3d(var(--p-drift, 16px), -94cqh, 0) scale(0.75);
  }
}

:global(:root:is([data-motion="reduce"], [data-motion="reduced"], [data-reduced-motion="true"])) .room-atmosphere-particles,
:global(:root[data-theme-style="terraria"]) .room-atmosphere-particles {
  display: none;
}

@media (prefers-reduced-motion: reduce) {
  :global(:root:not([data-motion="full"])) .room-atmosphere-particles {
    display: none;
  }
}

@media (forced-colors: active) {
  .room-atmosphere-particles {
    display: none;
  }
}
</style>

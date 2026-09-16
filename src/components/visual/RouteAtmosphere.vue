<template><div class="route-atmosphere" aria-hidden="true"><i></i><i></i></div></template>
<style scoped>
/* Character aura tokens are synchronized on documentElement by the active
   workspace; non-character routes fall back to the global accent tokens. */
.route-atmosphere { position: fixed; inset: 0; z-index: var(--z-below); overflow: hidden; pointer-events: none; contain: strict; }
.route-atmosphere i { position: absolute; border-radius: 50%; opacity: .25; }
.route-atmosphere i:first-child { width: 70vw; height: 70vw; inset: -35vw auto auto -20vw; background: radial-gradient(circle, var(--character-aura, var(--accent-soft)), transparent 68%); }
.route-atmosphere i:last-child { width: 65vw; height: 65vw; inset: auto -30vw -35vw auto; background: radial-gradient(circle, var(--character-aura-secondary, var(--accent-glow)), transparent 68%); }
@media (prefers-reduced-transparency: reduce) { .route-atmosphere { display: none; } }
</style>

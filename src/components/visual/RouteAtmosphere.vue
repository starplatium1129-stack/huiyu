<template><div class="route-atmosphere tw:fixed tw:inset-x-0 tw:top-0 tw:[z-index:var(--z-below)] tw:pointer-events-none tw:[contain:strict]" aria-hidden="true"></div></template>
<style scoped>
/* Character aura tokens are synchronized on documentElement by the active
   workspace; non-character routes fall back to the global accent tokens. */
/* One static painted surface: no blur, perpetual promotion or viewport-sized
   child textures. The color areas stay bounded on 2K/4K windows. */
.route-atmosphere {
  height: min(72vh, 52rem);
  background:
    radial-gradient(ellipse min(45vw, 44rem) min(36vh, 28rem) at 5% 0%, color-mix(in srgb, var(--character-aura, var(--accent-glow)) 35%, transparent), transparent 75%),
    radial-gradient(ellipse min(36vw, 32rem) min(32vh, 24rem) at 98% 8%, color-mix(in srgb, var(--character-aura-secondary, var(--archive-blue-soft)) 26%, transparent), transparent 75%);
}
@media (prefers-reduced-transparency: reduce) { .route-atmosphere { display: none; } }
:global(:root:is([data-fluid-effects="low"], [data-reduced-glass="true"]) .route-atmosphere) { display: none; }
</style>

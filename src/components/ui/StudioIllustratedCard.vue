<script setup lang="ts">
// Layered feature composition inspired by Inspira UI BentoGridCard / 3D Card
// at 04c57ab62b9713872ebbf68988dff1836ed3d764 and Magic UI Bento Grid.
// Notices: assets/licenses/inspira-ui.txt and assets/licenses/magicui.txt.
import { shallowRef } from 'vue'
import type { RouteLocationRaw } from 'vue-router'
import ArchiveIcon, { type ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'
import CardEdgeLight from '@/components/visual/CardEdgeLight.vue'
import { useArtworkTilt } from '@/composables/useArtworkTilt'

defineProps<{ to: RouteLocationRaw; title: string; label?: string; description?: string; action?: string; icon?: ArchiveIconName; lead?: boolean; compact?: boolean }>()
const plane = shallowRef<HTMLElement | null>(null)
const tilt = useArtworkTilt(plane)
</script>

<template>
  <RouterLink :to="to" class="illustrated-card" :class="{ 'is-lead': lead, 'is-compact': compact }" draggable="false"
    @pointerenter="tilt.enter" @pointermove="tilt.move" @pointerleave="tilt.reset" @pointercancel="tilt.reset" @focus="tilt.reset">
    <span class="illustrated-card-art" aria-hidden="true"><span class="illustrated-card-orbit" /><span ref="plane" class="illustrated-card-plane"><slot name="art" /></span></span>
    <span class="illustrated-card-copy">
      <span v-if="label" class="illustrated-card-label">{{ label }}</span>
      <strong class="illustrated-card-title"><ArchiveIcon v-if="icon" :name="icon" />{{ title }}</strong>
      <span v-if="description" class="illustrated-card-description">{{ description }}</span>
      <span v-if="action" class="illustrated-card-action">{{ action }}</span>
    </span>
    <span class="illustrated-card-arrow" aria-hidden="true"><ArchiveIcon name="chevron-down" /><ArchiveIcon name="chevron-down" /></span>
    <CardEdgeLight />
  </RouterLink>
</template>

<style scoped>
.illustrated-card { --card-color:var(--accent); position:relative; isolation:isolate; display:grid; grid-template-rows:minmax(150px,1fr) auto; min-width:0; padding:var(--s-4); border:1px solid var(--border-soft); border-radius:var(--r-xl); background:var(--bg-surface); color:var(--text-primary); text-decoration:none; overflow:hidden; user-select:none; box-shadow:inset 0 1px 0 var(--glass-highlight); }
.illustrated-card:nth-child(3n+2) { --card-color:var(--nene-violet); }
.illustrated-card:nth-child(3n) { --card-color:var(--natsume-amber); }
.illustrated-card::before { content:''; position:absolute; inset:0; z-index:-1; border-radius:inherit; background:linear-gradient(145deg,color-mix(in srgb,var(--card-color) 9%,transparent),transparent 65%); opacity:0; transition:opacity var(--motion-route) var(--ease-out); }
.illustrated-card-art { position:relative; display:grid; place-items:center; min-width:0; padding:var(--s-2); }
.illustrated-card-art::before { content:''; position:absolute; width:66%; aspect-ratio:1; max-height:92%; border-radius:50%; background:radial-gradient(ellipse,color-mix(in srgb,var(--card-color) 12%,transparent),transparent 70%); }
.illustrated-card-orbit { position:absolute; width:66%; aspect-ratio:1.7; border:1px solid color-mix(in srgb,var(--card-color) 22%,var(--border-soft)); border-radius:50%; transform:rotate(-18deg); transition:transform var(--motion-route-cut) var(--spring-soft); }
.illustrated-card-plane { display:grid; place-items:center; position:relative; width:100%; height:100%; min-height:0; transform:perspective(900px); transition:transform var(--motion-route) var(--spring-soft); }
.illustrated-card-plane :deep(img) { display:block; width:100%; height:100%; max-height:200px; object-fit:contain; }
.illustrated-card-copy { position:relative; display:grid; align-content:start; gap:var(--s-2); padding:var(--s-3) var(--s-2) var(--s-1); padding-right:44px; transition:transform var(--motion-route) var(--spring-soft); }
.illustrated-card-label { color:var(--text-muted); font:500 var(--fs-mono-xs)/var(--lh-label) var(--font-mono); letter-spacing:.12em; }
.illustrated-card-title { display:flex; align-items:center; gap:var(--s-2); color:var(--text-primary); font:500 var(--fs-title-xs)/var(--lh-label) var(--font-serif); }
.illustrated-card-title .archive-icon { flex:none; width:18px; height:18px; color:var(--accent); }
.illustrated-card-description { color:var(--text-secondary); font-size:var(--fs-label-sm); line-height:var(--lh-body); }
.illustrated-card-action { color:var(--accent); font:500 var(--fs-label-sm)/var(--lh-label) var(--font-sans); min-height:24px; padding-top:var(--s-1); }
.illustrated-card-arrow { position:absolute; right:var(--s-4); bottom:var(--s-4); display:grid; place-items:center; width:32px; height:32px; overflow:hidden; border:1px solid var(--border-soft); border-radius:50%; background:var(--bg-elevated); color:var(--accent); }
.illustrated-card-arrow .archive-icon { position:absolute; width:16px; height:16px; transform:rotate(-90deg); transition:transform var(--motion-route) var(--spring-soft),opacity var(--motion-control) var(--ease-out); }
.illustrated-card-arrow .archive-icon + .archive-icon { transform:translateX(-28px) rotate(-90deg); opacity:0; }
.illustrated-card.is-lead { grid-row:span 2; padding:var(--s-5); }
.is-lead .illustrated-card-plane :deep(img) { max-height:380px; }
.is-lead .illustrated-card-title { font-size:var(--fs-title); }
.is-lead .illustrated-card-copy { gap:var(--s-3); padding-top:var(--s-5); }
.illustrated-card.is-compact { grid-template-columns:80px minmax(0,1fr); grid-template-rows:auto; align-items:center; padding:var(--s-3); }
.is-compact .illustrated-card-art { min-height:88px; padding:0; }
.is-compact .illustrated-card-copy { padding:var(--s-2) 24px var(--s-2) var(--s-2); }
.is-compact .illustrated-card-title { font:600 var(--fs-body-sm)/var(--lh-label) var(--font-sans); }
.is-compact .illustrated-card-arrow { width:24px; height:24px; right:var(--s-3); bottom:var(--s-3); }
.illustrated-card:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.illustrated-card:focus-visible :is(.illustrated-card-plane,.illustrated-card-copy,.illustrated-card-orbit) { transform:none; transition:none; }
@media (hover:hover) and (pointer:fine) {
  .illustrated-card:hover::before { opacity:1; }
  .illustrated-card:hover:not(:focus-visible) .illustrated-card-orbit { transform:rotate(12deg) scale(1.08); }
  .illustrated-card:hover:not(:focus-visible) .illustrated-card-copy { transform:translateY(-4px); }
  .illustrated-card:hover:not(:focus-visible) .illustrated-card-arrow .archive-icon:first-child { transform:translateX(28px) rotate(-90deg); opacity:0; }
  .illustrated-card:hover:not(:focus-visible) .illustrated-card-arrow .archive-icon + .archive-icon { transform:rotate(-90deg); opacity:1; }
}
@media (max-width:1000px) {
  .illustrated-card.is-lead { grid-row:auto; grid-column:1/-1; grid-template-columns:1fr 1fr; grid-template-rows:auto; align-items:center; }
  .is-lead .illustrated-card-copy { padding-top:var(--s-3); }
}
@media (prefers-reduced-motion:reduce) {
  :root:not([data-motion='full']) .illustrated-card :is(.illustrated-card-plane,.illustrated-card-orbit,.illustrated-card-copy,.archive-icon),:root:not([data-motion='full']) .illustrated-card::before { transition:none; transform:none; }
  :root:not([data-motion='full']) .illustrated-card-arrow .archive-icon { transform:rotate(-90deg); }
}
:root:is([data-motion='reduce'],[data-motion='reduced']) .illustrated-card :is(.illustrated-card-plane,.illustrated-card-orbit,.illustrated-card-copy,.archive-icon),:root:is([data-motion='reduce'],[data-motion='reduced']) .illustrated-card::before { transition:none; transform:none; }
:root:is([data-motion='reduce'],[data-motion='reduced']) .illustrated-card-arrow .archive-icon { transform:rotate(-90deg); }
@media (forced-colors:active) { .illustrated-card { border-color:ButtonText; } .illustrated-card-art::before,.illustrated-card-orbit,.illustrated-card::before { display:none; } .illustrated-card:focus-visible { outline:2px solid Highlight; } }
</style>

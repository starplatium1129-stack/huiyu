<template>
  <section :class="albums ? 'artwork-albums-track showcase-loading-albums' : 'showcase-grid'" role="status" aria-busy="true" aria-label="正在读取参考画册">
    <span class="sr-only">正在读取参考画册…</span>
    <div v-for="(ratio, index) in ratios" :key="index" class="showcase-skeleton-card" :style="{ '--sample-grow': ratio }" aria-hidden="true">
      <div class="showcase-skeleton-image" :style="{ aspectRatio: albums ? '1.12' : String(ratio) }"></div>
      <div class="showcase-skeleton-caption"><span></span><span></span></div>
    </div>
  </section>
</template>

<script setup lang="ts">
defineProps<{ albums?: boolean }>()
const ratios = [.75, .75, 1.5, .75, .75, 1, .75, 1.5, .75, .75, 1, .75]
</script>

<style scoped>
.showcase-loading-albums { padding-block:var(--s-4); }
.showcase-skeleton-card { min-width:0; overflow:hidden; border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-surface); }
.showcase-skeleton-image { background:linear-gradient(135deg,var(--bg-elevated),var(--bg-base)); }
.showcase-skeleton-caption { display:grid; gap:var(--s-2); padding:var(--s-3); border-top:1px solid var(--border-soft); }
.showcase-skeleton-caption span { height:var(--fs-label-xs); width:38%; border-radius:var(--r-sm); background:var(--bg-elevated); }
.showcase-skeleton-caption span + span { height:var(--fs-body-sm); width:72%; }
.showcase-loading-albums .showcase-skeleton-card { border:0; background:transparent; }
.showcase-loading-albums .showcase-skeleton-image { border-radius:var(--r-md); }
.showcase-loading-albums .showcase-skeleton-caption { padding-inline:var(--s-2); border:0; }
@media (forced-colors:active) { .showcase-skeleton-card { border-color:CanvasText; } .showcase-skeleton-image,.showcase-skeleton-caption span { background:Canvas; outline:1px solid GrayText; outline-offset:-1px; } }
</style>

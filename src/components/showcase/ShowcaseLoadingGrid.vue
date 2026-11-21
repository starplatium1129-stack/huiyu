<template>
  <section :class="albums ? 'artwork-albums-track showcase-loading-albums' : 'showcase-grid'" role="status" aria-busy="true" aria-label="正在读取参考画册">
    <span class="sr-only">正在读取参考画册…</span>
    <StudioSkeleton
      v-for="(ratio, index) in ratios"
      :key="index"
      variant="card"
      class="showcase-skeleton-card"
      :style="{ '--sample-grow': ratio }"
    >
      <StudioSkeleton variant="media" class="showcase-skeleton-image" :aspect-ratio="albums ? '1.12' : String(ratio)" />
      <div class="showcase-skeleton-caption">
        <StudioSkeleton variant="line" width="38%" height="12px" />
        <StudioSkeleton variant="line" width="72%" height="15px" />
      </div>
    </StudioSkeleton>
  </section>
</template>

<script setup lang="ts">
import StudioSkeleton from '@/components/ui/StudioSkeleton.vue'

defineProps<{ albums?: boolean }>()
const ratios = [.75, .75, 1.5, .75, .75, 1, .75, 1.5, .75, .75, 1, .75]
</script>

<style scoped>
.showcase-loading-albums { padding-block:var(--s-4); }
.showcase-skeleton-card { min-width:0; padding:0; gap:0; overflow:hidden; border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-surface); }
.showcase-skeleton-image { border:0; border-radius:0; min-height:0; }
.showcase-skeleton-caption { display:grid; gap:var(--s-2); padding:var(--s-3); border-top:1px solid var(--border-soft); }
.showcase-loading-albums .showcase-skeleton-card { border:0; background:transparent; box-shadow:none; }
.showcase-loading-albums .showcase-skeleton-image { border:1px solid var(--border-soft); border-radius:var(--r-md); }
.showcase-loading-albums .showcase-skeleton-caption { padding-inline:var(--s-2); border:0; }
</style>

<template>
  <figure class="inspiration-artwork" :class="{ ready: loaded }" :aria-busy="Boolean(src && !loaded && !failed)">
    <img v-if="src && !failed" v-bind="image" :alt="scene?.title + '，完整场景构图'" decoding="async" draggable="false" />
    <div v-if="!loaded" class="inspiration-artwork-fallback" :role="failed ? 'status' : undefined">
      <ArchiveIcon :name="icon" />
      <span>{{ failed ? '预览未能加载' : !scene ? '场景预览待收录' : !src ? '图片服务未连接' : '加载画面…' }}</span>
    </div>
  </figure>
</template>

<script setup lang="ts">
import ArchiveIcon, { type ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'
import { useRuntimeImage } from '@/composables/useRuntimeImage'
import type { ExplorerScene } from '@/composables/scene/sceneExplorerPresentation'
const props = defineProps<{ scene?: ExplorerScene; icon: ArchiveIconName }>()
const { image, src, loaded, failed } = useRuntimeImage(() => props.scene
  ? `/scene-showcase/thumbs/${props.scene.id.toLowerCase().replace(/[^a-z0-9_-]/g, '')}.jpg` : '')
</script>

<style scoped>
.inspiration-artwork { position:relative; display:flex; align-items:center; height:clamp(192px,30vh,320px); min-width:0; margin:0; padding:0; background:transparent; overflow:hidden; }
.inspiration-artwork img { display:block; width:auto; max-width:100%; height:100%; min-height:0; object-fit:contain; opacity:0; transition:opacity 160ms var(--ease-out); }
.inspiration-artwork.ready img { opacity:1; }
.inspiration-artwork-fallback { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:var(--s-2); padding:var(--s-3); color:var(--text-secondary); font-size:var(--fs-label-sm); text-align:center; }
.inspiration-artwork-fallback .archive-icon { width:40px; height:40px; color:var(--card-accent,var(--accent)); }
@media (max-width:1100px) { .inspiration-artwork { height:clamp(176px,28vh,240px); } }
@media (prefers-reduced-motion:reduce) { .inspiration-artwork img { transition:none; } }
:global(:root:is([data-motion='reduce'],[data-motion='reduced'])) .inspiration-artwork img { transition:none; }
</style>

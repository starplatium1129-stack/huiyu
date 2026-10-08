<template>
  <figure class="inspiration-artwork" :class="{ ready: loaded, 'inspiration-artwork-full': full }" :aria-busy="Boolean(src && !loaded && !failed)">
    <img v-if="src && !failed" v-bind="image" :alt="artwork?.alt || scene?.title + '，完整场景构图'" decoding="async" draggable="false" />
    <div v-if="!loaded" class="inspiration-artwork-fallback" :role="failed ? 'status' : undefined">
      <ArchiveIcon :name="icon" />
      <span>{{ failed ? '预览未能加载' : !scene && !artwork ? '场景预览待收录' : !src ? '图片服务未连接' : '加载画面…' }}</span>
    </div>
  </figure>
</template>

<script setup lang="ts">
import ArchiveIcon, { type ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'
import { useRuntimeImage } from '@/composables/useRuntimeImage'
import type { ExplorerScene } from '@/composables/scene/sceneExplorerPresentation'
const props = defineProps<{ scene?: ExplorerScene; artwork?: { src: string; alt: string }; icon: ArchiveIconName; full?: boolean }>()
const { image, src, loaded, failed } = useRuntimeImage(() => props.artwork?.src || (props.scene?.rating === 'All' && props.scene.mature !== true
  ? `/scene-showcase/${props.full ? 'images' : 'thumbs'}/${props.scene.id.toLowerCase().replace(/[^a-z0-9_-]/g, '')}.jpg` : ''))
</script>

<style scoped>
.inspiration-artwork { position:relative; display:flex; align-items:center; justify-content:center; height:var(--inspiration-art-height,96px); min-width:0; min-height:0; margin:0; padding:0; border:1px solid var(--art-frame-line); border-radius:var(--r-sm); background:var(--art-stage); overflow:hidden; }
.inspiration-artwork-full { width:100%; height:100%; border:0; background:transparent; }
.inspiration-artwork img { display:block; width:auto; max-width:100%; height:auto; max-height:100%; min-height:0; object-fit:contain; opacity:0; transition:opacity 160ms var(--ease-out),transform var(--motion-route) var(--ease-out); }
.inspiration-artwork::after { content:''; position:absolute; inset:0; pointer-events:none; background:radial-gradient(circle at 50% 50%,color-mix(in srgb,var(--on-art-primary) 18%,transparent),transparent 35%); opacity:0; transition:opacity var(--motion-route) var(--ease-out); }
.inspiration-artwork-full img { box-shadow:var(--art-frame-shadow); }
.inspiration-artwork.ready img { opacity:1; }
.inspiration-artwork-fallback { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:var(--s-1); padding:var(--s-1); color:var(--on-art-primary); font-size:var(--fs-label-xs); text-align:center; }
.inspiration-artwork-fallback .archive-icon { width:24px; height:24px; color:var(--on-art-primary); }
@media (prefers-reduced-motion:reduce) { :global(:root:not([data-motion='full']) .inspiration-artwork img),:global(:root:not([data-motion='full']) .inspiration-artwork::after) { transition:none; } }
:global(:root:is([data-motion='reduce'],[data-motion='reduced']) .inspiration-artwork img),
:global(:root:is([data-motion='reduce'],[data-motion='reduced']) .inspiration-artwork::after) { transition:none; }
</style>

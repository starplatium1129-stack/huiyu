<template>
  <article class="page notfound-page tw:flex tw:min-h-[60vh] tw:flex-col tw:items-center tw:justify-center tw:gap-s-3 tw:text-center">
    <div class="notfound-art-frame">
      <RuntimeImage :src="lostNatsume" v-slot="{ image, loaded, failed }">
        <img v-if="image.src && !failed" v-bind="image" class="notfound-chibi" :class="{ ready: loaded }" alt="寻找方向的地图插画" width="1774" height="887" loading="eager" decoding="async" />
        <div v-if="!loaded" class="notfound-chibi-fallback" role="status">
          <ArchiveIcon name="image" />
          <span class="notfound-fallback-text tw:text-label-sm tw:tracking-[.1em]">{{ failed ? '插图暂未加载' : '正在展开地图…' }}</span>
        </div>
      </RuntimeImage>
    </div>
    <h1 class="title">页面走丢了</h1>
    <p class="subtitle">这个地址暂时没有对应的页面。</p>
    <p class="notfound-address tw:text-label-sm tw:text-secondary">地址 <code class="notfound-path tw:break-all">{{ path }}</code></p>

    <div class="notfound-actions tw:mt-s-4 tw:flex tw:flex-wrap tw:justify-center tw:gap-s-3">
      <RouterLink class="btn btn-primary" to="/">回到首页</RouterLink>
      <RouterLink class="btn btn-ghost" to="/scene-explorer">去场景库</RouterLink>
      <RouterLink class="btn btn-ghost" to="/prompt-builder">去工作台</RouterLink>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import RuntimeImage from '@/components/visual/RuntimeImage.vue'
import lostOriginal from '@/assets/illustrations/natsume-lost.png'
import { useThemeIllustration } from '@/composables/useThemeIllustration'
const lostNatsume = useThemeIllustration(lostOriginal, 'scene')

const route = useRoute()
const path = computed(() => route.fullPath)
</script>

<style scoped>
@reference "../assets/css/tailwind.css";

.notfound-art-frame { position:relative; width:min(700px,82vw); height:min(350px,44vh); flex:none; }
.notfound-chibi {
  display:block; width:100%; height:100%; object-fit:contain; opacity:0;
  transition:opacity var(--motion-surface) var(--ease-out);
  border:0; background:transparent; box-shadow:none;
}
.notfound-chibi.ready { opacity:1; }
.notfound-page .title { margin:0; font:600 clamp(28px,2.5vw,42px)/var(--lh-tight) var(--font-serif); }
.notfound-page .subtitle,.notfound-address { margin:0; }

/* Missing illustration keeps the reserved space; recovery links remain available. */
.notfound-chibi-fallback {
  position:absolute; inset:0; pointer-events:none;
  @apply tw:grid tw:place-content-center tw:justify-items-center tw:gap-s-2 tw:border-dashed;
  border:1px dashed var(--border-soft);
  border-color: color-mix(in srgb, var(--border-strong) 46%, transparent);
  @apply tw:bg-elevated tw:text-muted;
  box-shadow: none;
}

.notfound-chibi-fallback .archive-icon {
  @apply tw:h-[40px] tw:w-[40px];
}
@media (prefers-reduced-motion:reduce) { :root:not([data-motion='full']) .notfound-chibi { transition:none; } }
:root:is([data-motion='reduce'],[data-motion='reduced']) .notfound-chibi { transition:none; }
</style>

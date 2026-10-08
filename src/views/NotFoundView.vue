<template>
  <article class="page notfound-page tw:flex tw:min-h-[60vh] tw:flex-col tw:items-center tw:justify-center tw:gap-s-3 tw:text-center">
    <img v-if="!chibiFailed" class="notfound-chibi" :src="lostNatsume" alt="寻找方向的地图插画" width="1774" height="887" loading="eager" decoding="async" @error="chibiFailed = true" />
    <div v-else class="notfound-chibi notfound-chibi-fallback" role="status">
      <ArchiveIcon name="image" />
      <span class="notfound-fallback-text tw:text-label-sm tw:tracking-[.1em]">插图暂未加载</span>
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
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import lostOriginal from '@/assets/illustrations/natsume-lost.png'
import { useThemeIllustration } from '@/composables/useThemeIllustration'
const lostNatsume = useThemeIllustration(lostOriginal, 'scene')

const route = useRoute()
const path = computed(() => route.fullPath)

// 插图失败即换占位；本页没有可驱动的切换入口，恢复路径是资源修复后的重载，不做自动重试。
const chibiFailed = ref(false)
</script>

<style scoped>
@reference "../assets/css/tailwind.css";

.notfound-chibi {
  width:min(700px,82vw); height:auto; max-height:44vh; object-fit:contain;
  border:0; background:transparent; box-shadow:none;
}
.notfound-page .title { margin:0; font:600 clamp(28px,2.5vw,42px)/var(--lh-tight) var(--font-serif); }
.notfound-page .subtitle,.notfound-address { margin:0; }

/* Missing illustration keeps the reserved space; recovery links remain available. */
.notfound-chibi-fallback {
  @apply tw:grid tw:place-content-center tw:justify-items-center tw:gap-s-2 tw:border-dashed;
  aspect-ratio:2/1; border:1px dashed var(--border-soft);
  border-color: color-mix(in srgb, var(--border-strong) 46%, transparent);
  @apply tw:bg-elevated tw:text-muted;
  box-shadow: none;
}

.notfound-chibi-fallback .archive-icon {
  @apply tw:h-[40px] tw:w-[40px];
}
</style>

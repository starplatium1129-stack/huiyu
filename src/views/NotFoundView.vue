<template>
  <article class="page notfound-page tw:flex tw:min-h-[60vh] tw:flex-col tw:items-center tw:justify-center tw:gap-s-3 tw:text-center">
    <img v-if="!chibiFailed" class="notfound-chibi" src="/assets/chibi/natsume-coffee.webp" alt="四季夏目 Q 版：页面迷路时也要从容地接一杯咖啡" width="480" height="288" loading="eager" decoding="async" @error="chibiFailed = true" />
    <div v-else class="notfound-chibi notfound-chibi-fallback" role="status">
      <ArchiveIcon name="image" />
      <span class="notfound-fallback-text tw:text-label-sm tw:tracking-[.1em]">插图暂未加载</span>
    </div>
    <h1 class="title">页面走丢了</h1>
    <p class="subtitle">地址 <code class="notfound-path tw:break-all tw:text-secondary">{{ path }}</code> 不存在。</p>

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

const route = useRoute()
const path = computed(() => route.fullPath)

// 插图失败即换占位；本页没有可驱动的切换入口，恢复路径是资源修复后的重载，不做自动重试。
const chibiFailed = ref(false)
</script>

<style scoped>
@reference "../assets/css/tailwind.css";

.notfound-chibi {
  @apply tw:w-[min(420px,78vw)] tw:aspect-[5/3] tw:object-cover tw:rounded-2xl;
  border: 1px solid var(--border-soft);
  box-shadow: 0 18px 44px -18px color-mix(in srgb, var(--accent) 40%, transparent);
}

/* 缺图占位：复用 .notfound-chibi 的外框尺寸避免布局跳动；虚线空态语言，标题/路径/返回链接不受影响 */
.notfound-chibi-fallback {
  @apply tw:grid tw:place-content-center tw:justify-items-center tw:gap-s-2 tw:border-dashed;
  border-color: color-mix(in srgb, var(--border-strong) 46%, transparent);
  @apply tw:bg-elevated tw:text-muted;
  box-shadow: none;
}

.notfound-chibi-fallback .archive-icon {
  @apply tw:h-[40px] tw:w-[40px];
}
</style>

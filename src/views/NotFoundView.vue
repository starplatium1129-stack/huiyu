<template>
  <article class="page notfound-page">
    <img v-if="!chibiFailed" class="notfound-chibi" src="/assets/chibi/natsume-coffee.webp" alt="四季夏目 Q 版：页面迷路时也要从容地接一杯咖啡" width="480" height="288" loading="eager" decoding="async" @error="chibiFailed = true" />
    <div v-else class="notfound-chibi notfound-chibi-fallback" role="status">
      <ArchiveIcon name="image" />
      <span class="notfound-fallback-text">插图暂未加载</span>
    </div>
    <h1 class="title">页面走丢了</h1>
    <p class="subtitle">地址 <code class="notfound-path">{{ path }}</code> 不存在。</p>

    <div class="notfound-actions">
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
.notfound-page {
  min-height: 60vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: var(--s-3);
}

.notfound-path {
  color: var(--text-secondary);
  word-break: break-all;
}

.notfound-chibi {
  width: min(420px, 78vw);
  aspect-ratio: 5/3;
  object-fit: cover;
  border-radius: var(--r-2xl);
  border: 1px solid var(--border-soft);
  box-shadow: 0 18px 44px -18px color-mix(in srgb, var(--accent) 40%, transparent);
}

/* 缺图占位：复用 .notfound-chibi 的外框尺寸避免布局跳动；虚线空态语言，标题/路径/返回链接不受影响 */
.notfound-chibi-fallback {
  display: grid;
  place-content: center;
  justify-items: center;
  gap: var(--s-2);
  border-style: dashed;
  border-color: color-mix(in srgb, var(--border-strong) 46%, transparent);
  background: var(--bg-elevated);
  color: var(--text-muted);
  box-shadow: none;
}

.notfound-chibi-fallback .archive-icon {
  width: 40px;
  height: 40px;
}

.notfound-fallback-text {
  font-size: var(--fs-label-sm);
  letter-spacing: .1em;
}

.notfound-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s-3);
  justify-content: center;
  margin-top: var(--s-4);
}
</style>

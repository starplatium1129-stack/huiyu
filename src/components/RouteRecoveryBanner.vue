<template>
  <section v-if="routeRecovery" class="route-recovery tw:sticky tw:top-0 tw:flex tw:gap-s-3 tw:m-s-4 tw:p-s-4 tw:rounded-lg tw:text-primary" role="alert" :aria-label="panelFailure ? '面板加载恢复' : '页面加载恢复'">
    <ArchiveIcon name="warning" />
    <div><h2>{{ panelFailure ? '部分面板暂未打开' : '这个页面暂时没能打开' }}</h2><p>{{ panelFailure ? '当前内容仍然保留。可以继续当前页面，或重新载入后再试。' : '连接中断或更新后，页面文件可能需要重新读取。当前页面仍然保留。' }}</p>
      <div class="route-recovery-actions tw:flex tw:flex-wrap tw:gap-s-2"><button v-if="panelFailure" class="btn btn-primary" type="button" @click="reloadCurrent">重新载入当前页面</button><a v-else class="btn btn-primary" :href="targetHref">重新打开目标页面</a><button class="btn btn-ghost" type="button" @click="continueCurrent">继续当前页面</button><a class="btn btn-ghost" :href="homeHref">返回首页</a></div>
    </div>
  </section>
</template>
<script setup lang="ts">
import { computed, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { routeRecovery } from '@/composables/useRouteRecovery'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
const router = useRouter()
const panelFailure = computed(() => routeRecovery.value?.kind === 'panel')
const targetHref = computed(() => router.resolve(routeRecovery.value?.target || '/').href)
const homeHref = router.resolve('/').href
function reloadCurrent() {
  // Native beforeunload listeners retain ownership of task and unsaved-data protection.
  window.location.reload()
}
function continueCurrent() {
  routeRecovery.value = null
  void nextTick(() => document.getElementById('main')?.focus({ preventScroll: true }))
}
</script>
<style scoped>
@reference "../assets/css/tailwind.css";
.route-recovery { z-index: var(--z-overlay); border: 1px solid var(--border-strong); background: var(--bg-surface); }
.route-recovery > .archive-icon { @apply tw:shrink-0 tw:text-warning-text; }
.route-recovery > div { @apply tw:min-w-0; }
.route-recovery h2 { @apply tw:m-0 tw:text-body tw:leading-body; }
.route-recovery p { margin: var(--s-2) 0; @apply tw:text-secondary tw:text-label tw:leading-body; }
</style>

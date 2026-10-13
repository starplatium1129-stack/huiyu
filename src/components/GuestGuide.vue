<template>
  <FluidTransition appear panel=".guest-guide-card">
  <aside
    v-if="visible"
    ref="guideEl"
    class="guest-guide tw:fixed tw:grid tw:p-s-5"
    role="dialog"
    aria-modal="true"
    aria-describedby="guest-guide-description"
    aria-label="访客导览"
    @click.self="dismiss"
  >
    <div class="guest-guide-card">
      <div class="guest-guide-body">
        <span class="guest-guide-kicker tw:text-accent">初次见面 · {{ isLocalHost ? '一次导览' : '访客导览' }}</span>
        <h2 id="guest-guide-title">欢迎来到 绘遇</h2>

        <!-- 本机主人：讲的是「怎么上手」，不是「这是谁的电脑」 -->
        <template v-if="isLocalHost">
          <p id="guest-guide-description">
            可以先配置模型，也可以从喜欢的角色与场景开始逛。
          </p>
          <ul>
            <li><strong>选场景</strong>：找到喜欢的角色与故事。</li>
            <li><strong>去绘制</strong>：调整画面，生成第一张作品。</li>
            <li><strong>回看作品</strong>：收藏、整理或继续创作。</li>
          </ul>
        </template>

        <!-- 远程访客：原有的访客视角文案 -->
        <template v-else>
          <p id="guest-guide-description">
            欢迎来逛朋友的创作间，看看场景与作品，或去角色房间聊聊天。
          </p>
          <ul>
            <li>生成任务在分享者的电脑上执行。</li>
            <li>聊天配音可在角色房间随时关闭。</li>
          </ul>
        </template>
      </div>
      <div class="guest-guide-actions tw:flex tw:items-center tw:justify-between tw:gap-s-3 tw:flex-wrap">
        <!-- docs/ 由网关静态托管（server.js /docs），42 份文档此前在应用内零入口 -->
        <a class="guest-guide-doc tw:text-secondary tw:text-label-sm" href="/docs/getting-started.html" target="_blank" rel="noopener">翻开使用指南</a>
        <button v-if="isLocalHost" ref="setupButton" class="btn btn-primary" type="button" @click="beginSetup">开始配置</button>
        <button ref="dismissButton" class="btn" :class="isLocalHost ? 'btn-ghost' : 'btn-primary'" type="button" @click="dismiss">
          {{ isLocalHost ? '先浏览' : '开始浏览' }}
        </button>
      </div>
    </div>
  </aside>
  </FluidTransition>
</template>

<script setup lang="ts">
import FluidTransition from '@/components/visual/FluidTransition.vue'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useFocusTrap } from '@/composables/useFocusTrap'
import { settingsRepository, GUEST_GUIDE_DISMISSED_SETTING } from '@/storage/settingsRepository.ts'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'
import { useRouter } from 'vue-router'

const isLocalHost = isLocalStudioHost()
const forcedGuest = new URLSearchParams(window.location.search).get('guest') === '1'
const router = useRouter()

/**
 * 首次访问一律展示，文案按本机 / 访客分流（2026-08-30 UX 审计 P1）。
 *
 * 原先这里要求 isNonLocal，而本项目是单人本机部署，条件恒为假——主人自己
 * 反而永远看不到引导。`?guest=1` 保留作「强制再看一次」的开关。
 */
const shouldShow = forcedGuest || (isLocalHost && !settingsRepository.get(GUEST_GUIDE_DISMISSED_SETTING))
const visible = ref(false)
const guideEl = ref<HTMLElement | null>(null)
const dismissButton = ref<HTMLElement | null>(null)
const setupButton = ref<HTMLElement | null>(null)

useFocusTrap(guideEl, () => visible.value, {
  onEscape: dismiss,
  initialFocus: computed(()=>setupButton.value||dismissButton.value),
})

function openGuide() { visible.value = true }
function beginSetup() { dismiss(); void router.push('/control#control-setup') }
onMounted(() => {
  if (shouldShow) visible.value = true
  window.addEventListener('atelier:welcome', openGuide)
})
onUnmounted(() => window.removeEventListener('atelier:welcome', openGuide))

function dismiss() {
  visible.value = false
  settingsRepository.set(GUEST_GUIDE_DISMISSED_SETTING, true)
}
</script>

<style scoped>
@reference "../assets/css/tailwind.css";
.guest-guide {
  z-index: var(--z-overlay);
  inset: 0;
  place-items: center;
  background: color-mix(in srgb, var(--bg-deep) 72%, transparent);
  backdrop-filter: blur(10px);
}
.guest-guide-card {
  width: min(520px, 100%);
  @apply tw:grid tw:gap-s-4 tw:p-s-6;
  border: 1px solid var(--border-soft);
  @apply tw:rounded-xl;
  background: var(--bg-surface);
  box-shadow: var(--shadow-lg);
}
.guest-guide-kicker {
  font: 700 var(--fs-mono-xs) var(--font-mono);
  letter-spacing: .14em;
}
.guest-guide-body h2 { margin: var(--s-1) 0 var(--s-2); }
.guest-guide-body p { margin: 0 0 var(--s-3); @apply tw:text-secondary tw:leading-loose; }
.guest-guide-body ul { @apply tw:m-0 tw:pl-s-4 tw:grid tw:gap-s-2 tw:text-secondary; }
.guest-guide-body strong { @apply tw:text-primary; }
.guest-guide-doc {
  text-decoration: underline; text-underline-offset: 3px;
}
.guest-guide-doc:hover { @apply tw:text-accent; }
.guest-guide-doc:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) {
  .guest-guide { backdrop-filter: none; animation: none; }
  .guest-guide-card { animation: none; }
}
@media (max-width: 600px) {
  .guest-guide-card { @apply tw:p-s-4; }
}
</style>

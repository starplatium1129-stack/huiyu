<template>
  <FluidTransition appear>
  <aside
    v-if="visible"
    ref="guideEl"
    class="guest-guide"
    role="dialog"
    aria-modal="true"
    aria-describedby="guest-guide-description"
    aria-label="访客导览"
    @click.self="dismiss"
  >
    <div class="guest-guide-card">
      <div class="guest-guide-body">
        <span class="guest-guide-kicker">初次见面 · {{ isLocalHost ? '一次导览' : '访客导览' }}</span>
        <h2 id="guest-guide-title">欢迎来到 绘遇</h2>

        <!-- 本机主人：讲的是「怎么上手」，不是「这是谁的电脑」 -->
        <template v-if="isLocalHost">
          <p id="guest-guide-description">
            从一个场景开始，留下你的第一张作品。
          </p>
          <ul>
            <li><strong>灵感</strong>：挑一个场景，或去「热门角色场景」找你推的那位。</li>
            <li><strong>绘制</strong>：场景带过去，调词条与参数，点「生成图片」。</li>
            <li><strong>我的作品</strong>：出图会自动收进来，可收藏、批量清理，误删有 30 天回收站。</li>
            <li><strong>找东西</strong>：顶栏的搜索（或 <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>K</kbd>）
              能一次搜到页面、场景和旧作。</li>
          </ul>
        </template>

        <!-- 远程访客：原有的访客视角文案 -->
        <template v-else>
          <p id="guest-guide-description">
            这里是你朋友的本地创作间：浏览场景图鉴、带着场景去工作台出图、或去角色房间
            和 <strong>宁宁 / 夏目</strong> 聊天。
          </p>
          <ul>
            <li><strong>角色是谁</strong>：宁宁是银发紫瞳的魔女系女孩，夏目是琥珀色眼睛的可靠同伴。</li>
            <li><strong>能做什么</strong>：查看场景样张、直接生成图片；生成在你朋友的电脑上完成。</li>
            <li><strong>聊天配音</strong>：角色房间右上角打开「对话归档」旁的新对话即可开聊；
              语音默认跟随回复自动播放，也可在房间内单独开关。</li>
          </ul>
        </template>
      </div>
      <div class="guest-guide-actions">
        <!-- docs/ 由网关静态托管（server.js /docs），42 份文档此前在应用内零入口 -->
        <a class="guest-guide-doc" href="/docs/getting-started.html" target="_blank" rel="noopener">翻开使用指南</a>
        <button ref="dismissButton" class="btn btn-primary" type="button" @click="dismiss">
          {{ isLocalHost ? '开始创作' : '知道了，开始浏览' }}
        </button>
      </div>
    </div>
  </aside>
  </FluidTransition>
</template>

<script setup lang="ts">
import FluidTransition from '@/components/visual/FluidTransition.vue'
import { onMounted, onUnmounted, ref } from 'vue'
import { useFocusTrap } from '@/composables/useFocusTrap'
import { settingsRepository, GUEST_GUIDE_DISMISSED_SETTING } from '@/storage/settingsRepository.ts'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'

const isLocalHost = isLocalStudioHost()
const forcedGuest = new URLSearchParams(window.location.search).get('guest') === '1'

/**
 * 首次访问一律展示，文案按本机 / 访客分流（2026-08-30 UX 审计 P1）。
 *
 * 原先这里要求 isNonLocal，而本项目是单人本机部署，条件恒为假——主人自己
 * 反而永远看不到引导。`?guest=1` 保留作「强制再看一次」的开关。
 */
const shouldShow = forcedGuest
const visible = ref(false)
const guideEl = ref<HTMLElement | null>(null)
const dismissButton = ref<HTMLElement | null>(null)

useFocusTrap(guideEl, () => visible.value, {
  onEscape: dismiss,
  initialFocus: dismissButton,
})

function openGuide() { visible.value = true }
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
.guest-guide {
  position: fixed;
  z-index: var(--z-overlay);
  inset: 0;
  display: grid;
  place-items: center;
  padding: var(--s-5);
  background: color-mix(in srgb, var(--bg-deep) 72%, transparent);
  backdrop-filter: blur(10px);
  animation: guest-guide-in .3s var(--ease-out) both;
}
.guest-guide-card {
  width: min(520px, 100%);
  display: grid;
  gap: var(--s-4);
  padding: var(--s-6);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-xl);
  background: var(--bg-surface);
  box-shadow: var(--shadow-lg);
  animation: guest-guide-card-in .34s var(--ease-out) .06s both;
}
@keyframes guest-guide-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes guest-guide-card-in {
  from { opacity: 0; transform: translateY(10px) scale(.98); }
  to { opacity: 1; transform: none; }
}
.guest-guide-kicker {
  color: var(--accent);
  font: 700 var(--fs-mono-xs) var(--font-mono);
  letter-spacing: .14em;
}
.guest-guide-body h2 { margin: var(--s-1) 0 var(--s-2); }
.guest-guide-body p { margin: 0 0 var(--s-3); color: var(--text-secondary); line-height: var(--lh-loose); }
.guest-guide-body ul { margin: 0; padding-left: var(--s-4); display: grid; gap: var(--s-2); color: var(--text-secondary); }
.guest-guide-body strong { color: var(--text-primary); }
.guest-guide-body kbd {
  padding: 1px 5px;
  border: 1px solid var(--border-soft);
  border-radius: var(--r-sm);
  background: var(--bg-deep);
  font: 650 var(--fs-mono-xs) var(--font-mono);
}
.guest-guide-actions { display: flex; align-items: center; justify-content: space-between; gap: var(--s-3); flex-wrap: wrap; }
.guest-guide-doc {
  color: var(--text-secondary); font-size: var(--fs-label-sm);
  text-decoration: underline; text-underline-offset: 3px;
}
.guest-guide-doc:hover { color: var(--accent); }
.guest-guide-doc:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) {
  .guest-guide { backdrop-filter: none; animation: none; }
  .guest-guide-card { animation: none; }
}
@media (max-width: 600px) {
  .guest-guide-card { padding: var(--s-4); }
}
</style>

<template>
  <FluidTransition appear panel=".guest-guide-card">
  <aside
    v-if="visible"
    ref="guideEl"
    class="guest-guide"
    role="dialog"
    aria-modal="true"
    :aria-describedby="isLocalHost ? undefined : 'guest-guide-description'"
    aria-labelledby="guest-guide-title"
    @click.self="dismiss"
  >
    <div class="guest-guide-card">
      <header class="guest-guide-heading">
        <h2 id="guest-guide-title">欢迎来到 绘遇</h2>
        <button class="btn btn-quiet btn-icon" type="button" aria-label="关闭使用引导" @click="dismiss"><ArchiveIcon name="close" /></button>
      </header>
      <div class="guest-guide-body">
        <nav class="guest-guide-destinations" aria-label="开始创作">
          <RouterLink to="/scene-explorer" data-control-motion @click="dismiss"><ArchiveIcon name="scene" /><strong class="studio-control-label">选场景</strong></RouterLink>
          <RouterLink to="/prompt-builder" data-control-motion @click="dismiss"><ArchiveIcon name="palette" /><strong class="studio-control-label">绘制</strong></RouterLink>
          <RouterLink to="/gallery" data-control-motion @click="dismiss"><ArchiveIcon name="gallery" /><strong class="studio-control-label">我的作品</strong></RouterLink>
        </nav>
        <p v-if="!isLocalHost" id="guest-guide-description">生成任务在分享者的电脑上执行。</p>
      </div>
      <footer class="guest-guide-actions">
        <RouterLink class="btn btn-quiet" to="/guide" @click="dismiss"><span class="studio-control-label">使用指南</span></RouterLink>
        <button v-if="isLocalHost" ref="setupButton" class="btn btn-primary" type="button" @click="beginSetup">开始配置</button>
        <button ref="dismissButton" class="btn" :class="isLocalHost ? 'btn-ghost' : 'btn-primary'" type="button" @click="dismiss">
          {{ isLocalHost ? '先浏览' : '开始浏览' }}
        </button>
      </footer>
    </div>
  </aside>
  </FluidTransition>
</template>

<script setup lang="ts">
import FluidTransition from '@/components/visual/FluidTransition.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useFocusTrap } from '@/composables/useFocusTrap'
import { appearanceFocusOrigin } from '@/composables/useDesktopInteraction'
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

const { returnFocus } = useFocusTrap(guideEl, () => visible.value, {
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

async function dismiss() {
  const origin = returnFocus.value
  const closingGuide = guideEl.value
  visible.value = false
  settingsRepository.set(GUEST_GUIDE_DISMISSED_SETTING, true)
  await nextTick()
  const focus = document.activeElement
  if (!visible.value && (focus === document.body || closingGuide?.contains(focus))) {
    appearanceFocusOrigin(origin)?.focus({ preventScroll:true })
  }
}
</script>

<style scoped>
@reference "../assets/css/tailwind.css";
.guest-guide {
  position:fixed;
  display:grid;
  z-index: var(--z-overlay);
  inset:var(--desktop-chrome-height,0px) 0 0;
  grid-template-rows:minmax(0,1fr);
  place-items: center;
  padding:var(--s-4);
  overflow:hidden;
  background: color-mix(in srgb, var(--bg-deep) 72%, transparent);
  backdrop-filter: blur(10px);
}
.guest-guide-card {
  width: min(520px, 100%);
  max-height:100%;
  display:grid;
  grid-template-rows:auto minmax(0,1fr) auto;
  overflow:hidden;
  border: 1px solid var(--border-soft);
  @apply tw:rounded-xl;
  background: var(--bg-surface);
  box-shadow: var(--shadow-lg);
}
.guest-guide-heading { display:flex; align-items:center; justify-content:space-between; gap:var(--s-3); padding:var(--s-3) var(--s-4); border-bottom:1px solid var(--border-soft); }
.guest-guide-heading h2 { margin:0; color:var(--text-primary); font-size:var(--fs-title-sm); font-weight:600; }
.guest-guide-body { min-height:0; padding:var(--s-4); overflow:auto; overscroll-behavior:contain; scroll-padding-block:var(--s-2); }
.guest-guide-body p { margin:var(--s-3) 0 0; color:var(--text-secondary); font-size:var(--fs-label); line-height:var(--lh-body); }
.guest-guide-destinations { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:var(--s-3); }
.guest-guide-destinations a { display:grid; justify-items:center; gap:var(--s-2); min-width:0; padding:var(--s-2); border:1px solid var(--border-soft); border-radius:var(--r-lg); color:var(--accent); background:var(--bg-base); text-decoration:none; overflow-wrap:anywhere; }
@media (hover:hover) and (pointer:fine) { .guest-guide-destinations a:hover { border-color:var(--border-strong); } }
.guest-guide-destinations a:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.guest-guide-destinations .archive-icon { width:20px; height:20px; }
.guest-guide-destinations strong { color:var(--text-primary); font:600 var(--fs-label)/var(--lh-label) var(--font-sans); }
.guest-guide-actions { display:flex; flex-wrap:wrap; align-items:center; justify-content:flex-end; gap:var(--s-2); padding:var(--s-3) var(--s-4); border-top:1px solid var(--border-soft); }
.guest-guide-actions > a { margin-inline-end:auto; }
@media (prefers-reduced-motion: reduce) {
  :root:not([data-motion='full']) .guest-guide { backdrop-filter: none; animation: none; }
  :root:not([data-motion='full']) .guest-guide-card { animation: none; }
}
</style>

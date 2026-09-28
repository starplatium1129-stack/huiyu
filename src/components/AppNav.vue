<template>
  <nav class="nav" aria-label="主导航">
    <div class="nav-inner">
      <!-- 用真 RouterLink:role="link" 的 div 没有 href,没有右键菜单、
           中键新标签页,而 Space 激活链接也不是标准行为 -->
      <RouterLink to="/" class="nav-brand">
        <BrandLogo class="nav-logo" />
      </RouterLink>

      <div id="primary-navigation" ref="linksEl" class="nav-links" :class="{ open: menuOpen }" @keydown="onNavigationKey">
        <AnimatedSelection target=":scope > a.active" />
        <!-- 主导航。aria-current 让读屏也能知道当前页,不只靠 class 上色 -->
        <RouterLink
          v-for="item in primaryNav"
          :key="item.id"
          :to="item.to"
          :target="openBesideTask(item.to) ? '_blank' : undefined"
          :rel="openBesideTask(item.to) ? 'noopener' : undefined"
          :class="{ active: activeId === item.id }"
          :aria-current="activeId === item.id ? 'page' : undefined"
          :data-pending="pendingPath === item.to || undefined"
          :data-intent="intentRoutePath === item.to || undefined"
          :tabindex="activeId === item.id || (!primaryNav.some(entry => entry.id === activeId) && item === primaryNav[0]) ? 0 : -1"
          @click="closeMenu"
        >
          <ArchiveIcon :name="item.icon" />
          <span>{{ item.label }}</span>
        </RouterLink>

        <!-- The richer menu is loaded on first use, outside the initial navigation bundle. -->
        <div ref="moreEl" class="nav-more" :data-open="moreOpen || undefined" :data-active="secondaryActive || undefined"
          :data-pending="secondaryNav.some(item => item.to === pendingPath) || undefined"
          :data-intent="secondaryNav.some(item => item.to === intentRoutePath) || undefined">
          <StudioTooltip v-if="!moreLoaded" anchor :content="moreError ? '菜单未能载入，请刷新页面后重试' : undefined">
            <button type="button" class="nav-more-trigger" :disabled="moreReady"
              :aria-expanded="moreOpen" :aria-busy="moreReady"
              @click="openMore">更多<ArchiveIcon name="chevron-down" class="nav-more-chevron" /></button>
          </StudioTooltip>
          <component :is="AppMoreMenu" v-if="AppMoreMenu" v-model:open="moreOpen" :groups="archiveGroups" :active-id="route.path === '/popular-scenes' ? 'popular-scenes' : activeId"
            :pending-path="pendingPath" :intent-path="intentRoutePath" :open-beside-task="openBesideTask"
            @ready="moreLoaded = true" @navigate="closeMenu" @guide="openGuide" @appearance="closeMenu"
            @close-auto-focus="onMoreCloseAutoFocus" />
        </div>


        <!-- 工具保留独立 Tab 焦点；搜索快捷键同时在悬停提示中可见。 -->
        <div class="nav-utilities" role="group" aria-label="工作台工具">
          <StudioTooltip content="搜索页面、场景与作品（Ctrl/⌘ + K）">
            <button
              type="button"
              class="nav-search tw:cursor-pointer"
              aria-label="搜索页面、场景与作品"
              @click="openSearch"
            ><ArchiveIcon name="search" /></button>
          </StudioTooltip>
          <TaskCenterButton />
          <span class="nav-utility-divider" aria-hidden="true"></span>
          <AppThemeToggle />
          <AppSoundToggle />
        </div>
      </div>

      <!-- 移动端汉堡 -->
      <button
        ref="menuToggleEl"
        type="button"
        class="nav-menu-toggle"
        aria-controls="primary-navigation"
        :aria-expanded="menuOpen ? 'true' : 'false'"
        :aria-label="menuOpen ? '关闭导航菜单' : '打开导航菜单'"
        @click="toggleMenu"
      ><ArchiveIcon :name="menuOpen ? 'close' : 'menu'" /></button>
    </div>
  </nav>
</template>

<script setup lang="ts">
import BrandLogo from '@/components/BrandLogo.vue'
import { ref, computed, shallowRef, watch, onMounted, onUnmounted, nextTick, type Component } from 'vue'
import { useRoute } from 'vue-router'
import AppSoundToggle from './AppSoundToggle.vue'
import AppThemeToggle from './AppThemeToggle.vue'
import TaskCenterButton from './tasks/TaskCenterButton.vue'
import { useTaskCenter } from '@/composables/useTaskCenter'
import { useNavigationFeedback } from '@/composables/useNavigationFeedback'
import { needsDocumentReload } from '@/router'
import AnimatedSelection from './visual/AnimatedSelection.vue'
import { openGlobalSearch } from '@/composables/useGlobalSearch'
import { useToast } from '@/composables/useToast'
import ArchiveIcon, { type ArchiveIconName } from './visual/ArchiveIcon.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'

const route = useRoute()
const { show: showToast } = useToast()
const AppMoreMenu = shallowRef<Component | null>(null)
const { activeCount } = useTaskCenter()
const { pendingPath, intentRoutePath } = useNavigationFeedback()
function openBesideTask(path: string) { return activeCount.value > 0 && needsDocumentReload(route.path, path) && !location.hostname.includes('tauri') }
const menuOpen = ref(false)
const linksEl = ref<HTMLElement | null>(null)
const moreEl = ref<HTMLDivElement | null>(null)
const moreOpen = ref(false)
const moreReady = ref(false)
const moreLoaded = ref(false)
const moreError = ref(false)
let moreHandoff = false
watch(moreOpen, open => { if (open) moreHandoff = false }, { flush:'sync' })
const menuToggleEl = ref<HTMLButtonElement | null>(null)

interface NavItem {
  id: string
  label: string
  to: string
  icon: ArchiveIconName
}

const primaryNav: NavItem[] = [
  { id: 'showcase', label: '参考画册', to: '/showcase', icon: 'image' },
  { id: 'character', label: '角色', to: '/character', icon: 'character' },
  { id: 'scene',    label: '灵感',   to: '/scene-explorer', icon: 'scene' },
  { id: 'director', label: '绘制',   to: '/prompt-builder', icon: 'spark' },
  { id: 'chat',     label: '房间',   to: '/chat',           icon: 'chat' },
]
const archiveGroups: Array<{ heading: string; items: NavItem[] }> = [
  {
    heading: '发现',
    items: [
      { id: 'gallery', label: '我的作品', to: '/gallery', icon: 'gallery' },
      { id: 'video', label: '故事短片', to: '/video-studio', icon: 'play' },
      { id: 'popular-scenes', label: '角色场景', to: '/popular-scenes', icon: 'character' },
    ],
  },
  {
    heading: '美学',
    items: [
      { id: 'style',     label: '画风',     to: '/style',        icon: 'palette' },
      { id: 'scenario',  label: '剧本',     to: '/scenario',     icon: 'scene' },
      // 与页面 h1 统一叫「色彩情绪」（2026-08-30 UX 审计 P1）：此前导航「色调脚本」、
      // h1「色彩情绪」、hero「色彩剧本」三个中文名并存，搜哪个都可能对不上。
      { id: 'color-script', label: '色彩情绪', to: '/color-script', icon: 'palette' },
    ],
  },
  {
    heading: '工坊',
    items: [
      { id: 'lora',      label: '模型',     to: '/lora',         icon: 'model' },
      { id: 'manager',   label: '场景管理', to: '/scene-manager', icon: 'manager' },
      { id: 'control',   label: '控制面板', to: '/control',       icon: 'gear' },
    ],
  },
]
const secondaryNav: NavItem[] = archiveGroups.flatMap(g => g.items)

const activeId = computed(() => {
  const p = route.path.replace(/^\//, '')
  if (!p) return 'home'
  if (p === 'popular-scenes' || (p === 'scene-explorer' && ['nene', 'natsume'].includes(String(route.query.character)))) return 'character'
  const all = [...primaryNav, ...secondaryNav]
  const match = all.find(n => n.to.replace(/^\//, '') === p || p.startsWith(n.to.replace(/^\//, '')))
  return match?.id ?? ''
})

const secondaryActive = computed(() => secondaryNav.some(n => n.id === activeId.value))

function closeMenu() {
  if (moreOpen.value) moreHandoff = true
  menuOpen.value = false
  moreOpen.value = false
}
async function openMore() {
  moreReady.value = true; moreOpen.value = true; moreError.value = false
  try { AppMoreMenu.value = (await import('./AppMoreMenu.vue')).default }
  catch {
    moreReady.value = false; moreOpen.value = false; moreError.value = true
    showToast('菜单暂未加载，请刷新页面后重试。其余导航仍可使用。', 'error', 6000)
  }
}
function onMoreCloseAutoFocus(event: Event) {
  // Route navigation and settings dialogs own focus after selecting an entry.
  if (moreHandoff) event.preventDefault()
  moreHandoff = false
}
async function toggleMenu() {
  menuOpen.value = !menuOpen.value
  if (menuOpen.value) {
    await nextTick()
    linksEl.value?.querySelector<HTMLAnchorElement>(':scope > a')?.focus()
  }
}

/**
 * 唤起全局搜索。面板由 App.vue 挂在路由之外，与导航没有父子关系，
 * 走 useGlobalSearch 单例通道；传 'pointer' 是为了让面板按鼠标来源定位焦点。
 */
async function openGuide() {
  const mobile = menuOpen.value
  closeMenu()
  await nextTick()
  ;(mobile ? menuToggleEl.value : moreEl.value?.querySelector<HTMLElement>('.nav-more-trigger'))?.focus()
  window.dispatchEvent(new Event('atelier:welcome'))
}

function openSearch() {
  if (menuOpen.value) { closeMenu(); menuToggleEl.value?.focus() }
  openGlobalSearch('pointer')
}

function onDocClick(e: MouseEvent) {
  const inMore = e.target instanceof Element && e.target.closest('.nav-more-menu')
  if (menuOpen.value && !inMore && !linksEl.value?.contains(e.target as Node) && !menuToggleEl.value?.contains(e.target as Node)) closeMenu()
}
function onDocKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return
  if (moreOpen.value) {
    moreOpen.value = false
    moreEl.value?.querySelector<HTMLElement>('.nav-more-trigger')?.focus()
    e.preventDefault()
  } else if (menuOpen.value) {
    closeMenu()
    menuToggleEl.value?.focus()
    e.preventDefault()
  }
}

function onNavigationKey(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return
  const links = [...(linksEl.value?.querySelectorAll<HTMLAnchorElement>(':scope > a') ?? [])]
  const index = links.indexOf(event.target as HTMLAnchorElement)
  if (index < 0) return
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? links.length - 1
    : event.key === 'ArrowRight' ? (index + 1) % links.length : event.key === 'ArrowLeft' ? (index - 1 + links.length) % links.length : -1
  if (next >= 0) { event.preventDefault(); links[next]?.focus() }
}

onMounted(() => {
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onDocKey)
})
onUnmounted(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onDocKey)
})
</script>

<style scoped>
@reference "../assets/css/tailwind.css";

.nav-links a[data-pending="true"], .nav-links a[data-intent="true"],
.nav-more[data-pending="true"] .nav-more-trigger, .nav-more[data-intent="true"] .nav-more-trigger {
  outline: 1px solid var(--border-strong);
  outline-offset: -1px;
  background: var(--accent-soft);
  @apply tw:text-primary;
}

/* logo.svg 是 132×48 的完整字标（图形 + 绘遇），
   只能按高度缩放，不能塞进方框裁切，也不要再叠一份文字。 */
.nav-logo {
  @apply tw:block tw:w-auto; height: 2.15rem; max-width: 12.7rem;
}
.nav-brand { @apply tw:gap-s-2; }
@media (max-width: 480px) {
  .nav-logo { @apply tw:h-[28px] tw:max-w-[150px]; }
}

/* 轻量工具组：统一点击区，用淡色任务签与细分隔区分工作和偏好。 */
.nav-utilities {
  @apply tw:flex tw:items-center tw:gap-s-1 tw:shrink-0;
  margin-left: var(--s-2);
  padding-left: var(--s-2);
  border-left: 1px solid var(--border-soft);
}
.nav-utilities :deep(button) {
  @apply tw:inline-flex tw:items-center tw:justify-center tw:shrink-0 tw:rounded-md tw:text-secondary;
  height: 2.4rem; min-height: 2.4rem;
  border: 1px solid transparent;
  background: transparent;
  transition: transform var(--motion-hover) var(--ease-out);
}
.nav-utilities :deep(.nav-search),
.nav-utilities :deep(.app-theme-toggle),
.nav-utilities :deep(.sound-toggle) { width: 2.4rem; @apply tw:p-0; }
.nav-utilities :deep(.archive-icon) { width: 1.15rem; height: 1.15rem; }
.nav-utilities :deep(.task-center-button) {
  padding: 0 var(--s-3);
  background: var(--accent-soft);
  @apply tw:text-accent tw:text-label-sm;
}
.nav-utilities :deep(button:hover),
.nav-utilities :deep(.sound-toggle.active) {
  background: var(--accent-soft);
  border-color: var(--border-soft);
  @apply tw:text-accent;
}
.nav-utilities :deep(button:active) { transform: scale(.96); }
.nav-utilities :deep(button:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; box-shadow: none; }
.nav-utility-divider { width: 1px; height: 16px; margin: 0 var(--s-1); background: var(--border-soft); }

@media (max-width: 900px) {
  /* The compact menu is a two-column surface, including the sixth “more” entry. */
  .nav-links {
    --selection-radius: var(--r-md);
    padding: var(--s-3);
    border-radius: var(--r-lg);
    background: var(--bg-surface);
  }
  .nav-links > a { min-height: 44px; border-radius: var(--r-md); }
  .nav-more { min-width: 0; grid-column: auto; }
  .nav-more > :deep(.studio-tooltip-anchor[data-anchor]) { width: 100%; }
  .nav-more :deep(.nav-more-trigger) {
    justify-content: space-between;
    width: 100%;
    min-height: 44px;
    border-radius: var(--r-md);
  }
  .nav-utilities {
    grid-column: 1 / -1;
    flex-wrap: wrap;
    margin: 0;
    padding: var(--s-2) 0 0;
    border-left: 0;
    border-top: 1px solid var(--border-soft);
  }
  .nav-utilities :deep(button) { min-width: 44px; min-height: 44px; }
}
</style>

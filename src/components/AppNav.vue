<!-- Lucian UX/UI Prompt #212 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#212 -->
<template>
  <nav ref="navEl" class="nav u212" aria-label="主导航" :data-scroll-hidden="headerHidden" :data-scrolled="headerScrolled" :data-reduced-motion="headerReduced" @focusin="revealHeader">
    <div class="nav-inner">
      <!-- 用真 RouterLink:role="link" 的 div 没有 href,没有右键菜单、
           中键新标签页,而 Space 激活链接也不是标准行为 -->
      <RouterLink to="/" class="nav-brand">
        <BrandLogo class="nav-logo" />
        <span class="nav-brand-note" aria-hidden="true">创作工作室</span>
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
          @click="closeMenu"
        >
          <ArchiveIcon :name="item.icon" />
          <span class="nav-item-label">{{ item.label }}</span>
        </RouterLink>

        <!-- The richer menu is loaded on first use, outside the initial navigation bundle. -->
        <div ref="moreEl" class="nav-more" :data-open="moreOpen || undefined" :data-active="secondaryActive || undefined" @pointerenter="prepareMore" @focusin="prepareMore"
          :data-pending="secondaryNav.some(item => item.to === pendingPath) || undefined"
          :data-intent="secondaryNav.some(item => item.to === intentRoutePath) || undefined">
          <StudioTooltip v-if="!moreLoaded" anchor :content="moreError ? '菜单未能载入，请刷新页面后重试' : undefined">
            <button type="button" class="nav-more-trigger"
              :aria-expanded="moreOpen" :aria-busy="moreReady"
              @click="openMore"><span class="nav-more-label">更多</span><StudioToggleIcon :active="moreOpen" class="nav-more-chevron" /></button>
          </StudioTooltip>
          <component :is="AppMoreMenu" v-if="AppMoreMenu" v-model:open="moreOpen" :groups="archiveGroups" :active-id="route.path === '/popular-scenes' ? 'popular-scenes' : activeId"
            :pending-path="pendingPath" :intent-path="intentRoutePath" :open-beside-task="openBesideTask"
            @ready="moreLoaded = true" @navigate="closeMenu" @guide="openGuide" @appearance="closeMenu"
            @close-auto-focus="onMoreCloseAutoFocus" />
        </div>
      </div>

      <!-- 高频工具在紧凑窗口中也保持可达。 -->
      <div class="nav-utilities" role="group" aria-label="工作台工具">
        <button
          type="button"
          class="nav-search tw:cursor-pointer" data-spring-button
          aria-label="搜索页面、角色、场景与作品"
          aria-haspopup="dialog" aria-keyshortcuts="Control+k Meta+k"
          @click="openSearch"
        ><span class="nav-search-content" data-press-content><ArchiveIcon name="search" /><span class="nav-search-label">搜索</span><kbd aria-hidden="true">{{ searchShortcut }}</kbd></span></button>
        <TaskCenterButton />
        <span class="nav-utility-divider" aria-hidden="true"></span>
        <AppThemeToggle />
        <AppSoundToggle />
      </div>
      <!-- 较窄桌面窗口导航 -->
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
    <span ref="readingProgress" class="u212-progress" aria-hidden="true" />
  </nav>
</template>

<script setup lang="ts">
import BrandLogo from '@/components/BrandLogo.vue'
import { ref, computed, shallowRef, watch, onActivated, onDeactivated, onMounted, onUnmounted, nextTick, type Component } from 'vue'
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
import StudioToggleIcon from '@/components/ui/StudioToggleIcon.vue'
import { useScrollHeader } from '@/composables/useScrollHeader'

const route = useRoute()
const searchShortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ K' : 'Ctrl K'
const { show: showToast } = useToast()
const AppMoreMenu = shallowRef<Component | null>(null)
const { activeCount } = useTaskCenter()
const { pendingPath, intentRoutePath } = useNavigationFeedback()
function openBesideTask(path: string) { return activeCount.value > 0 && needsDocumentReload(route.path, path) && !location.hostname.includes('tauri') }
const menuOpen = ref(false)
const linksEl = ref<HTMLElement | null>(null)
const moreEl = ref<HTMLDivElement | null>(null)
const moreOpen = ref(false)
const navEl = ref<HTMLElement | null>(null)
const menuToggleEl = ref<HTMLButtonElement | null>(null)
const { hidden: headerHidden, scrolled: headerScrolled, progress: readingProgress, reduced: headerReduced, reveal: revealHeader } = useScrollHeader(navEl, () => route.path, () => menuOpen.value || moreOpen.value)
const moreReady = ref(false)
const moreLoaded = ref(false)
const moreError = ref(false)
let moreHandoff = false
let menuDownload: Promise<{ default: Component }> | null = null
let navigationActive = false
let lastNavigationFocus: HTMLElement | null = null
const compactNavigation = matchMedia('(max-width:1000px)')
// Match the shared navigation breakpoint: hidden anchors must release their menus and focus.
async function onNavigationLayoutChange(event: MediaQueryListEvent) {
  if (!navigationActive) return
  const compact = event.matches
  const active = document.activeElement
  const origin = active instanceof HTMLElement && isNavigationTarget(active) ? active
    : active === document.body && lastNavigationFocus?.isConnected && !lastNavigationFocus.getClientRects().length ? lastNavigationFocus : null
  const moreWasOpen = moreOpen.value
  closeMenu()
  if (!origin) return
  await nextTick()
  if (!navigationActive || compactNavigation.matches !== compact) return
  const current = document.activeElement
  if (current === document.body ? lastNavigationFocus !== origin : current !== active && current !== origin) return
  const target = compact ? menuToggleEl.value
    : moreWasOpen ? moreEl.value?.querySelector<HTMLElement>('.nav-more-trigger')
      : origin && linksEl.value?.contains(origin) ? origin
        : linksEl.value?.querySelector<HTMLElement>('a[aria-current="page"]') ?? linksEl.value?.querySelector<HTMLElement>('a[href]')
  if (target?.isConnected && target.getClientRects().length) target.focus({ preventScroll:true })
}
function downloadMore() {
  return menuDownload ??= import('./AppMoreMenu.vue').catch(error => { menuDownload = null; throw error })
}
function prepareMore() { if (!AppMoreMenu.value) void downloadMore().catch(() => {}) }
watch(moreOpen, open => { if (open) moreHandoff = false }, { flush:'sync' })

interface NavItem {
  id: string
  label: string
  to: string
  icon: ArchiveIconName
}

const primaryNav: NavItem[] = [
  { id: 'home', label: '首页', to: '/', icon: 'gallery' },
  { id: 'director', label: '绘制', to: '/prompt-builder', icon: 'spark' },
  { id: 'character', label: '角色', to: '/character', icon: 'character' },
  { id: 'scene',    label: '灵感',   to: '/scene-explorer', icon: 'scene' },
  { id: 'showcase', label: '参考画册', to: '/showcase', icon: 'image' },
  { id: 'gallery', label: '我的作品', to: '/gallery', icon: 'gallery' },
  { id: 'chat',     label: '房间',   to: '/chat',           icon: 'chat' },
]
const archiveGroups: Array<{ heading: string; items: NavItem[] }> = [
  {
    heading: '发现',
    items: [
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
      { id: 'manager',   label: '内容维护', to: '/scene-manager', icon: 'manager' },
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
  const match = all.find(n => n.to !== '/' && (n.to.replace(/^\//, '') === p || p.startsWith(n.to.replace(/^\//, ''))))
  return match?.id ?? ''
})

const secondaryActive = computed(() => secondaryNav.some(n => n.id === activeId.value))

function closeMenu() {
  if (moreOpen.value) moreHandoff = true
  menuOpen.value = false
  moreOpen.value = false
}
async function openMore() {
  if (moreReady.value) { moreOpen.value = !moreOpen.value; return }
  moreReady.value = true; moreOpen.value = true; moreError.value = false
  const trigger = moreEl.value?.querySelector<HTMLElement>('.nav-more-trigger')
  try {
    const menu = await downloadMore()
    if (!navigationActive) return
    const restoreTrigger = !moreOpen.value && document.activeElement === trigger
    AppMoreMenu.value = menu.default
    await nextTick()
    if (restoreTrigger && document.activeElement === document.body) moreEl.value?.querySelector<HTMLElement>('.nav-more-trigger')?.focus({ preventScroll:true })
  }
  catch {
    if (!navigationActive) return
    const requested = moreOpen.value
    moreOpen.value = false; moreError.value = true
    if (requested) showToast('菜单暂未加载，请刷新页面后重试。其余导航仍可使用。', 'error', 6000)
  }
  finally { moreReady.value = false }
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

function openSearch(event: MouseEvent) {
  if (menuOpen.value) { closeMenu(); menuToggleEl.value?.focus() }
  openGlobalSearch(event.detail ? 'pointer' : 'keyboard')
}

function onDocClick(e: MouseEvent) {
  // Lazy loading can replace the trigger before this click reaches document.
  const path = e.composedPath()
  const inLinks = Boolean(linksEl.value && path.includes(linksEl.value))
  const inToggle = Boolean(menuToggleEl.value && path.includes(menuToggleEl.value))
  const inMore = path.some(node => node instanceof Element && node.classList.contains('nav-more-menu'))
  if (!inLinks && !inToggle && !inMore) lastNavigationFocus = null
  dismissPendingMore(e)
  if (menuOpen.value && !inMore && !inLinks && !inToggle) closeMenu()
}
function isNavigationTarget(target: EventTarget | null) {
  return target instanceof Node && Boolean(linksEl.value?.contains(target) || menuToggleEl.value?.contains(target)
    || target instanceof Element && target.closest('.nav-more-menu'))
}
function onDocFocus(event: FocusEvent) {
  dismissPendingMore(event)
  // CSS hiding a focused link can fall back to body before the media query callback.
  if (event.target instanceof HTMLElement && event.target !== document.body) {
    lastNavigationFocus = isNavigationTarget(event.target) ? event.target : null
  }
}
function dismissPendingMore(event: Event) {
  if (!moreReady.value || !moreOpen.value) return
  const path = event.composedPath()
  const inTrigger = Boolean(moreEl.value && path.includes(moreEl.value))
  const inContent = path.some(node => node instanceof Element && node.classList.contains('nav-more-menu'))
  if (!inTrigger && !inContent) moreOpen.value = false
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
  const vertical = document.documentElement.dataset.themeStyle === 'terraria' && matchMedia('(min-width:1440px)').matches
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? links.length - 1
    : event.key === 'ArrowRight' || vertical && event.key === 'ArrowDown' ? (index + 1) % links.length
      : event.key === 'ArrowLeft' || vertical && event.key === 'ArrowUp' ? (index - 1 + links.length) % links.length : -1
  if (next >= 0) { event.preventDefault(); links[next]?.focus() }
}

function activateNavigation() {
  if (navigationActive) return
  navigationActive = true
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onDocKey)
  document.addEventListener('focusin', onDocFocus)
  compactNavigation.addEventListener('change', onNavigationLayoutChange)
}
function deactivateNavigation() {
  navigationActive = false
  lastNavigationFocus = null
  closeMenu()
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onDocKey)
  document.removeEventListener('focusin', onDocFocus)
  compactNavigation.removeEventListener('change', onNavigationLayoutChange)
}
onMounted(activateNavigation)
onActivated(activateNavigation)
onDeactivated(deactivateNavigation)
onUnmounted(deactivateNavigation)
</script>

<style scoped>
@reference "../assets/css/tailwind.css";
.u212 { top:var(--desktop-chrome-height,0px); transition:transform var(--motion-surface) var(--ease-out); }
.u212[data-scroll-hidden='true'] { transform:translateY(calc(-100% - var(--desktop-chrome-height,0px))); pointer-events:none; }
.u212-progress { position:absolute; inset:auto 0 -1px; height:2px; background:var(--accent); transform:scaleX(0); transform-origin:left; opacity:0; pointer-events:none; transition:opacity .3s; }
.u212[data-scrolled='true'] .u212-progress { opacity:1; }
.u212[data-reduced-motion='true'], .u212[data-reduced-motion='true'] .u212-progress { transition:none; }

.nav-links a[data-pending="true"], .nav-links a[data-intent="true"],
.nav-more[data-pending="true"] .nav-more-trigger, .nav-more[data-intent="true"] .nav-more-trigger {
  outline: none;
  box-shadow: var(--focus-shadow);
  background: var(--accent-soft);
  @apply tw:text-primary;
}
.nav-links a:focus-visible, .nav-more .nav-more-trigger:focus-visible {
  outline: none;
  box-shadow: var(--focus-shadow);
}

/* logo.svg 是 132×48 的完整字标（图形 + 绘遇），
   只能按高度缩放，不能塞进方框裁切，也不要再叠一份文字。 */
.nav-logo {
  @apply tw:block tw:w-auto; height: 2.2rem; max-width: 12.7rem;
}
.nav-brand { @apply tw:gap-s-3 tw:shrink-0; }
.nav-brand-note { display: none; color: var(--text-muted); font-size: var(--fs-label-xs); font-weight: 400; padding-left: var(--s-3); border-left: 1px solid var(--border-soft); }
.nav-links { --selection-radius: var(--r-md); --selection-shadow: none; border-color:transparent; background:transparent; box-shadow:none; }
.nav-links :deep(.animated-selection) { background:var(--bg-elevated); border-color:transparent; }
.nav-links > a { white-space:nowrap; isolation:isolate; }
/* Shared paper feedback keeps navigation still; a small dot motif marks the chapter. */
.nav-brand:active,.nav-links > a:active,.nav-more :deep(.nav-more-trigger:active),.nav-utilities :deep(button:active:not(.app-theme-toggle)),.nav-menu-toggle:active { transform:none; }
.nav-logo,.nav-item-label,.nav-more :deep(.nav-more-label),.nav-links > a > .archive-icon,.nav-utilities :deep(button > .archive-icon),.nav-utilities :deep(.task-center-button > span),.nav-menu-toggle > .archive-icon { transition:transform var(--motion-hover) var(--ease-out); }
.nav-links > a::after { content:''; position:absolute; inset:auto 0 3px; width:22px; height:4px; margin-inline:auto; background:radial-gradient(circle,var(--text-secondary) 1px,transparent 1.5px) left center / 7px 4px repeat-x; opacity:0; pointer-events:none; transition:opacity var(--motion-hover) var(--ease-out); }
.nav-links > a.active::after { opacity:.8; }
.nav-links > a:hover { background:transparent; }
.nav-links > a:focus-visible > :is(.archive-icon,.nav-item-label),.nav-brand:focus-visible .nav-logo,.nav-more :deep(.nav-more-trigger:focus-visible > span),.nav-utilities :deep(button:focus-visible > .archive-icon),.nav-menu-toggle:focus-visible > .archive-icon { transform:none; transition:none; }
.nav-links > a:focus-visible::before { transition:none; }
@media (hover:hover) and (pointer:fine) {
  .nav-brand:where(:hover:not(:focus-visible)) .nav-logo { transform:translateY(-2px) scale(1.025); }
  .nav-links > a:where(:hover:not(:focus-visible))::after { opacity:.65; }
}
.nav-brand:where(:active:not(:focus-visible)) .nav-logo { transform:scale(.97); }
.nav-links > a:where(:active:not(:focus-visible)) > :is(.archive-icon,.nav-item-label),.nav-more :deep(.nav-more-trigger:where(:active:not(:focus-visible)) > .nav-more-label),.nav-utilities :deep(button:where(:active:not(:focus-visible):not(.app-theme-toggle):not([data-spring-button])) > :is(.archive-icon,span)),.nav-menu-toggle:where(:active:not(:focus-visible)) > .archive-icon { transform:scale(.98); transition-duration:var(--motion-press); }
.u212[data-reduced-motion='true'] :is(.nav-logo,.nav-item-label),.u212[data-reduced-motion='true'] .nav-links > a > .archive-icon,.u212[data-reduced-motion='true'] .nav-more :deep(.nav-more-label),.u212[data-reduced-motion='true'] .nav-utilities :deep(button > :is(.archive-icon,span)),.u212[data-reduced-motion='true'] .nav-menu-toggle > .archive-icon { transform:none; transition:none; }
.u212[data-reduced-motion='true'] .nav-links > a::before,.u212[data-reduced-motion='true'] .nav-links > a::after { transform:none; transition:none; }
@media (forced-colors:active) { .nav-links > a::before { display:none; } .nav-links > a:hover { outline:1px solid Highlight; outline-offset:-1px; } }
@media (min-width:1600px) { .nav-brand-note { display: block; } }
@media (min-width:1001px) and (max-width:1200px) {
  .nav-inner { gap:var(--s-2); }
  .nav-links { gap: 0; }
  .nav-links > a { padding-inline:var(--s-2); gap:var(--s-1); font-size:var(--fs-label-sm); }
  .nav-links > a .archive-icon { display: none; }
  .nav-logo { height:1.9rem; }
  .nav-utilities { gap: 0; margin-left: 0; padding-left: var(--s-1); }
}

/* 轻量工具组：统一点击区，用淡色任务签与细分隔区分工作和偏好。 */
.nav-utilities {
  @apply tw:flex tw:items-center tw:gap-s-1 tw:shrink-0;
  margin-left: auto;
  padding-left: var(--s-3);
  border-left: 1px solid var(--border-soft);
}
.nav-utilities :deep(button:where(:not(.app-theme-toggle))) {
  @apply tw:inline-flex tw:items-center tw:justify-center tw:shrink-0 tw:rounded-md tw:text-secondary;
  height: 40px; min-height: 40px;
  border: 1px solid transparent;
  background: transparent;
  transition: transform var(--motion-press) var(--ease-out);
}
.nav-utilities :deep(.sound-toggle) { width: 40px; @apply tw:p-0; }
.nav-utilities .nav-search { padding:0 var(--s-3); border-color:var(--border-soft); background:var(--bg-surface); font:500 var(--fs-label-sm)/var(--lh-label) var(--font-sans); }
.nav-search-content { display:inline-flex; align-items:center; gap:var(--s-2); min-width:0; }
.nav-search kbd { display:none; padding:2px var(--s-1); border:1px solid var(--border-soft); border-radius:var(--r-xs); background:var(--bg-elevated); color:var(--text-secondary); font:400 var(--fs-label-xs)/1.2 var(--font-mono); white-space:nowrap; }
/* Share the wide-header threshold with the brand note; compact headers keep the search label. */
@media (min-width:1600px) { .nav-search kbd { display:inline-block; } }
.nav-utilities :deep(.app-theme-toggle) { width:56px; padding:0; }
.nav-utilities :deep(.archive-icon) { width: 1.15rem; height: 1.15rem; }
.nav-utilities :deep(.task-center-button) {
  padding: 0 var(--s-3);
  background: var(--accent-soft);
  @apply tw:text-accent tw:text-label-sm;
}
.nav-utilities :deep(button:hover:where(:not(.app-theme-toggle))),
.nav-utilities :deep(.sound-toggle.active) {
  background: transparent;
  border-color: var(--border-soft);
  @apply tw:text-primary;
}
.nav-utilities :deep(button:focus-visible) { outline: none; box-shadow: var(--focus-shadow); transition: none; }
.nav-utility-divider { width: 1px; height: 16px; margin: 0 var(--s-1); background: var(--border-soft); }

@media (max-width: 1000px) {
  /* Keep compact desktop windows on the existing two-column navigation surface. */
  .nav-links {
    --selection-radius: var(--r-md);
    padding: var(--s-3);
    border-radius: var(--r-xl);
    border-color: var(--border-soft);
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
    padding-left: 0;
    border: 0;
  }
  .nav-menu-toggle { width: 40px; height: 40px; flex: none; background: var(--album-surface); }
  .nav-menu-toggle:hover { background: transparent; color: var(--text-primary); border-color: var(--border-strong); }
}
@media (max-width:600px) {
  .nav-inner { gap:var(--s-1); padding-inline:var(--s-3); }
  .nav-utilities { gap:0; }
  .nav-utility-divider { display:none; }
  .nav-utilities .nav-search { width:40px; padding:0; }
  .nav-search-label { display:none; }
}
</style>

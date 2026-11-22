<script setup lang="ts">
import { nextTick, onDeactivated, ref, useId, watch } from 'vue'
import { createReusableTemplate, useResizeObserver } from '@vueuse/core'
import StudioPopover from '@/components/ui/StudioPopover.vue'
import AppearanceLaunchers from './AppearanceLaunchers.vue'
import ArchiveIcon, { type ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'

defineProps<{
  compact: boolean
  groups: readonly { heading: string; items: readonly { id: string; label: string; to: string; icon: ArchiveIconName }[] }[]
  activeId: string
  pendingPath: string
  intentPath: string
  openBesideTask: (path: string) => boolean
}>()
const open = defineModel<boolean>('open', { default:false })
const [DefineLinks, MenuLinks] = createReusableTemplate()
const emit = defineEmits<{ navigate: []; guide: []; appearance: []; closeAutoFocus:[event:Event] }>()
const menuContent = ref<HTMLElement | null>(null)
const inlineContent = ref<HTMLElement | null>(null)
const inlineTrigger = ref<HTMLButtonElement | null>(null)
const inlineId = useId()
watch(inlineContent, panel => {
  if (panel) panel.querySelector<HTMLElement>('.nav-back-button')?.focus({ preventScroll:true })
}, { flush:'post' })
async function back() {
  open.value = false
  await nextTick()
  inlineTrigger.value?.focus({ preventScroll:true })
}
useResizeObserver(menuContent, () => {
  const panel = menuContent.value
  const active = document.activeElement
  if (!open.value || !panel || !(active instanceof HTMLElement) || !panel.contains(active)
    || panel.scrollHeight <= panel.clientHeight) return
  // A short window can clip keyboard focus. Scroll only the menu and only as far as needed.
  const top = panel.getBoundingClientRect().top + panel.clientTop
  const item = active.getBoundingClientRect()
  const before = item.top - top
  const after = item.bottom - (top + panel.clientHeight)
  if (before < 0 || after > 0) panel.scrollBy({ top: before < 0 ? before : after, behavior: 'instant' })
}, { box:'border-box' })
onDeactivated(() => { menuContent.value = null })
function onCloseAutoFocus(event: Event) {
  if (event.target === menuContent.value) menuContent.value = null
  emit('closeAutoFocus', event)
}
function focusFirstPage(event: Event) {
  menuContent.value = event.target instanceof HTMLElement ? event.target : null
  const firstPage = menuContent.value?.querySelector<HTMLAnchorElement>('.nav-more-group a[href]')
  if (!firstPage) return
  event.preventDefault()
  firstPage.focus({ preventScroll: true })
}
</script>

<template>
  <DefineLinks>
    <section v-for="group in groups" :key="group.heading" class="nav-more-group" :aria-label="group.heading">
      <h3 class="nav-more-group-label">{{ group.heading }}</h3>
      <RouterLink v-for="item in group.items" :key="item.id" :to="item.to"
        :target="openBesideTask(item.to) ? '_blank' : undefined"
        :rel="openBesideTask(item.to) ? 'noopener' : undefined"
        :class="{ active:activeId === item.id }" :aria-current="activeId === item.id ? 'page' : undefined"
        :data-pending="pendingPath === item.to || undefined" :data-intent="intentPath === item.to || undefined"
        @click="emit('navigate')">
        <ArchiveIcon :name="item.icon" /><span>{{ item.label }}</span>
        <small v-if="activeId === item.id" class="nav-current-label">当前</small>
        <small v-if="openBesideTask(item.to)" class="nav-current-label">新窗口<span class="sr-only">，当前创作任务继续运行</span></small>
      </RouterLink>
    </section>
    <div class="nav-more-utilities">
      <button class="nav-help" type="button" @click="emit('guide')"><ArchiveIcon name="book" />新手引导</button>
      <AppearanceLaunchers @open="emit('appearance')" />
    </div>
  </DefineLinks>
  <template v-if="compact">
    <button v-show="!open" ref="inlineTrigger" type="button" class="nav-more-trigger" :aria-expanded="open" :aria-controls="open ? inlineId : undefined" @click="open = true">
      <span class="nav-more-label">更多</span><ArchiveIcon name="chevron-down" class="nav-more-chevron" />
    </button>
    <section v-if="open" :id="inlineId" ref="inlineContent" class="nav-more-menu nav-more-inline" aria-label="更多页面">
      <header class="nav-more-heading">
        <strong>更多页面</strong>
        <button class="btn btn-quiet btn-sm nav-back-button" type="button" @click="back">返回主菜单</button>
      </header>
      <MenuLinks />
    </section>
  </template>
  <StudioPopover v-else v-model:open="open" instant label="更多页面" content-class="nav-more-menu" @open-auto-focus="focusFirstPage" @close-auto-focus="onCloseAutoFocus">
    <template #trigger><button type="button" class="nav-more-trigger"><span class="nav-more-label">更多</span><ArchiveIcon name="chevron-down" class="nav-more-chevron" /></button></template>
    <header class="nav-more-heading"><strong>更多页面</strong><button class="btn btn-quiet btn-icon" type="button" aria-label="关闭更多页面" @click="open = false"><ArchiveIcon name="close" /></button></header>
    <MenuLinks />
  </StudioPopover>
</template>

<style>
@reference "../assets/css/tailwind.css";
.nav-more-trigger > .nav-more-chevron { transition: transform var(--motion-control) var(--ease-out); }
.nav-more-trigger[aria-expanded='true'] > .nav-more-chevron { transform: rotate(180deg); }
/* Focus and hit targets are ready immediately, including on the compact menu. */
.nav-more-menu { animation:nav-more-arrive var(--motion-hover) var(--ease-out); }
@keyframes nav-more-arrive { from { opacity:.55; } to { opacity:1; } }
/* This surface is portalled, so its links cannot inherit .nav-links rules. */
.studio-popover.nav-more-menu { @apply tw:grid tw:gap-s-3 tw:p-s-3; grid-template-columns:repeat(3,minmax(0,1fr)); width:min(580px,calc(100vw - 32px)); scroll-padding-block:var(--s-2); }
/* The optional liquid material owns its tint and rim; painted mode stays opaque. */
.studio-popover.nav-more-menu { background:var(--bg-surface); }
.nav-more-group { @apply tw:grid tw:content-start tw:gap-s-1 tw:min-w-0; }
.nav-more-menu .nav-more-group-label { @apply tw:m-0 tw:py-s-2 tw:px-s-2 tw:text-muted; font:600 var(--fs-label-xs)/var(--lh-label) var(--font-sans); }
.nav-more-menu a { @apply tw:flex tw:items-center tw:gap-s-2 tw:min-w-0 tw:min-h-[44px] tw:rounded-md tw:text-secondary; padding:var(--s-2) var(--s-3); font:500 var(--fs-label)/var(--lh-body) var(--font-sans); text-decoration:none; white-space:normal; }
.nav-more-menu a > span { min-width:0; overflow-wrap:anywhere; }
.nav-more-menu a { position:relative; isolation:isolate; transform:none; transition:none; }
.nav-more-menu :is(a,.nav-more-utilities > button)::before { content:''; position:absolute; z-index:-1; inset:0; border:1px solid var(--control-hover-edge); border-radius:inherit; background:var(--control-hover-surface); opacity:0; transform:scale(.985); transition:opacity var(--motion-hover) var(--ease-out),transform var(--motion-hover) var(--ease-out); pointer-events:none; }
.nav-more-menu a > :is(span,.archive-icon),.nav-more-menu .appearance-entry > .archive-icon { transition:transform var(--motion-hover) var(--ease-out); }
.nav-more-menu a:hover,.nav-more-menu a.active { @apply tw:text-primary; background:transparent; }
.nav-more-menu a.active::before { opacity:1; transform:none; }
.nav-more-menu a[data-pending='true'],.nav-more-menu a[data-intent='true'] { outline:none; box-shadow:var(--focus-shadow); background:var(--bg-hover); @apply tw:text-primary; }
.nav-more-menu .archive-icon { @apply tw:shrink-0 tw:w-[16px] tw:h-[16px]; }
.nav-more-heading { grid-column:1 / -1; @apply tw:flex tw:justify-between tw:items-center tw:gap-s-3 tw:text-primary tw:text-body-sm tw:pb-s-2; border-bottom:1px solid var(--border-soft); }
.nav-more-menu .nav-current-label { @apply tw:ml-auto tw:shrink-0 tw:text-primary tw:text-label-xs; }
.nav-more-menu :is(a,button):focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.nav-more-utilities { grid-column:1 / -1; @apply tw:flex tw:flex-wrap tw:gap-s-1 tw:pt-s-2; border-top:1px solid var(--border-soft); }
.nav-more-utilities > button { flex:1 1 auto; }
.nav-more-menu .nav-help { display:flex; align-items:center; gap:var(--s-2); }
.nav-more-menu .nav-help { @apply tw:min-h-[44px] tw:p-s-3; border:0; @apply tw:rounded-md; background:transparent; @apply tw:text-secondary tw:text-left; font:500 var(--fs-label)/var(--lh-body) var(--font-sans); @apply tw:cursor-pointer; }
.nav-more-utilities .appearance-entry { @apply tw:min-w-0 tw:min-h-[44px]; font:500 var(--fs-label)/var(--lh-body) var(--font-sans); }
.nav-more-menu .nav-more-utilities > button { position:relative; isolation:isolate; transform:none; }
.nav-more-menu .nav-more-utilities > button:hover { background:transparent; }
@media (hover:hover) and (pointer:fine) {
  .nav-more-menu :is(a,.nav-more-utilities > button):where(:hover:not(:focus-visible))::before { opacity:1; transform:none; }
}
.nav-more-menu a:active { transform:none; }
.nav-more-menu a:where(:active:not(:focus-visible)) > :is(span,.archive-icon) { transform:scale(.98); transition-duration:var(--motion-press); }
.nav-more-menu a:focus-visible > :is(span,.archive-icon),.nav-more-menu button:focus-visible > .archive-icon { transform:none; transition:none; }
.nav-more-menu :is(a,button):focus-visible::before { transition:none; }
@media (prefers-reduced-motion:reduce) {
  :root:not([data-motion='full']) .nav-more-menu { animation:none; }
  :root:not([data-motion='full']) .nav-more-trigger > .nav-more-chevron { transition:none; }
  :root:not([data-motion='full']) .nav-more-menu :is(a,button)::before,:root:not([data-motion='full']) .nav-more-menu a > :is(span,.archive-icon),:root:not([data-motion='full']) .nav-more-menu button > .archive-icon { transform:none; transition:none; }
}
:root:is([data-motion='reduce'],[data-motion='reduced'],[data-reduced-motion='true']) .nav-more-menu { animation:none; }
:root:is([data-motion='reduce'],[data-motion='reduced'],[data-reduced-motion='true']) .nav-more-trigger > .nav-more-chevron { transition:none; }
:root:is([data-motion='reduce'],[data-motion='reduced'],[data-reduced-motion='true']) .nav-more-menu :is(a,button)::before,:root:is([data-motion='reduce'],[data-motion='reduced'],[data-reduced-motion='true']) .nav-more-menu a > :is(span,.archive-icon),:root:is([data-motion='reduce'],[data-motion='reduced'],[data-reduced-motion='true']) .nav-more-menu button > .archive-icon { transform:none; transition:none; }
@media (forced-colors:active) { .nav-more-menu :is(a,button)::before { display:none; } .nav-more-menu :is(a,button):is(:hover,.active) { outline:1px solid Highlight; } }
.nav-more-inline { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr)); gap:var(--s-3); }
.nav-more-inline .nav-more-heading { padding-inline:var(--s-2); }
.nav-more-inline .nav-more-group { grid-template-columns:repeat(auto-fit,minmax(min(100%,120px),1fr)); }
.nav-more-inline .nav-more-group-label { grid-column:1 / -1; }
.nav-more-inline .nav-more-group a { background:var(--bg-base); padding:var(--s-2); }
</style>

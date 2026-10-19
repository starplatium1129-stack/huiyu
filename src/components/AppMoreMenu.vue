<script setup lang="ts">
import { onDeactivated, onMounted, ref } from 'vue'
import { useResizeObserver } from '@vueuse/core'
import StudioPopover from '@/components/ui/StudioPopover.vue'
import AppearancePreferences from '@/components/AppearancePreferences.vue'
import ArchiveIcon, { type ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'

defineProps<{
  groups: readonly { heading: string; items: readonly { id: string; label: string; to: string; icon: ArchiveIconName }[] }[]
  activeId: string
  pendingPath: string
  intentPath: string
  openBesideTask: (path: string) => boolean
}>()
const open = defineModel<boolean>('open', { default:false })
const emit = defineEmits<{ ready: []; navigate: []; guide: []; appearance: []; closeAutoFocus:[event:Event] }>()
const menuContent = ref<HTMLElement | null>(null)
useResizeObserver(menuContent, () => {
  const active = document.activeElement
  if (open.value && active instanceof HTMLElement && menuContent.value?.contains(active)) {
    active.scrollIntoView({ block:'nearest', inline:'nearest', behavior:'instant' })
  }
}, { box:'border-box' })
onMounted(() => emit('ready'))
onDeactivated(() => { menuContent.value = null })
function onCloseAutoFocus(event: Event) {
  menuContent.value = null
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
  <StudioPopover v-model:open="open" label="更多页面" content-class="nav-more-menu" @open-auto-focus="focusFirstPage" @close-auto-focus="onCloseAutoFocus">
    <template #trigger><button type="button" class="nav-more-trigger"><span class="nav-more-label">更多</span><ArchiveIcon name="chevron-down" class="nav-more-chevron" /></button></template>
    <header class="nav-more-heading"><strong>画室导航</strong><button class="btn btn-quiet btn-icon" type="button" aria-label="关闭更多页面" @click="open = false"><ArchiveIcon name="close" /></button></header>
    <section v-for="group in groups" :key="group.heading" class="nav-more-group" :aria-label="group.heading">
      <h3 class="nav-more-group-label">{{ group.heading }}</h3>
      <StudioTooltip
        v-for="item in group.items"
        :key="item.id"
        :content="openBesideTask(item.to) ? '在新窗口打开，当前创作任务继续运行' : undefined"
      >
        <RouterLink :to="item.to"
          :target="openBesideTask(item.to) ? '_blank' : undefined"
          :rel="openBesideTask(item.to) ? 'noopener' : undefined"
          :class="{ active:activeId === item.id }" :aria-current="activeId === item.id ? 'page' : undefined"
          :data-pending="pendingPath === item.to || undefined" :data-intent="intentPath === item.to || undefined"
          @click="emit('navigate')">
          <ArchiveIcon :name="item.icon" /><span>{{ item.label }}</span>
          <small v-if="activeId === item.id" class="nav-current-label">当前</small>
        </RouterLink>
      </StudioTooltip>
    </section>
    <div class="nav-more-utilities">
      <button class="nav-help" type="button" @click="emit('guide')">初次来访 · 使用指南</button>
      <AppearancePreferences launcher-only @open="emit('appearance')" />
    </div>
  </StudioPopover>
</template>

<style>
@reference "../assets/css/tailwind.css";
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
.nav-more-utilities { grid-column:1 / -1; @apply tw:grid tw:gap-s-1 tw:pt-s-2; border-top:1px solid var(--border-soft); }
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
  :root:not([data-motion='full']) .nav-more-menu :is(a,button)::before,:root:not([data-motion='full']) .nav-more-menu a > :is(span,.archive-icon),:root:not([data-motion='full']) .nav-more-menu button > .archive-icon { transform:none; transition:none; }
}
:root:is([data-motion='reduce'],[data-motion='reduced'],[data-reduced-motion='true']) .nav-more-menu :is(a,button)::before,:root:is([data-motion='reduce'],[data-motion='reduced'],[data-reduced-motion='true']) .nav-more-menu a > :is(span,.archive-icon),:root:is([data-motion='reduce'],[data-motion='reduced'],[data-reduced-motion='true']) .nav-more-menu button > .archive-icon { transform:none; transition:none; }
@media (forced-colors:active) { .nav-more-menu :is(a,button)::before { display:none; } .nav-more-menu :is(a,button):is(:hover,.active) { outline:1px solid Highlight; } }
@media(max-width:600px) {
  .studio-popover.nav-more-menu { grid-template-columns:minmax(0,1fr); @apply tw:gap-s-2; }
  .nav-more-group { grid-template-columns:minmax(0,1fr); }
  .nav-more-group + .nav-more-group { @apply tw:pt-s-1; border-top:1px solid var(--border-soft); }
}
</style>

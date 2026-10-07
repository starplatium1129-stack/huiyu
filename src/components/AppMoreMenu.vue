<script setup lang="ts">
import { onMounted } from 'vue'
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
onMounted(() => emit('ready'))
function focusFirstPage(event: Event) {
  const firstPage = event.target instanceof HTMLElement
    ? event.target.querySelector<HTMLAnchorElement>('.nav-more-group a[href]') : null
  if (!firstPage) return
  event.preventDefault()
  firstPage.focus({ preventScroll: true })
}
</script>

<template>
  <StudioPopover v-model:open="open" label="更多页面" content-class="nav-more-menu" @open-auto-focus="focusFirstPage" @close-auto-focus="emit('closeAutoFocus', $event)">
    <template #trigger><button type="button" class="nav-more-trigger">更多<ArchiveIcon name="chevron-down" class="nav-more-chevron" /></button></template>
    <header class="nav-more-heading"><strong>画室导航</strong><button type="button" aria-label="关闭更多页面" @click="open = false"><ArchiveIcon name="close" /></button></header>
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
.studio-popover.nav-more-menu { @apply tw:grid tw:gap-s-3; grid-template-columns:repeat(3,minmax(0,1fr)); width:min(580px,calc(100vw - 32px)); }
/* Dense navigation needs an opaque reading surface even when material styles load later.
   Keep their rim and shadow; accessibility material overrides retain priority. */
.studio-popover.nav-more-menu,
:root[data-glass-material] body .studio-popover.nav-more-menu[data-state] { background:var(--bg-surface); }
.nav-more-group { @apply tw:grid tw:content-start tw:gap-s-1 tw:min-w-0; }
.nav-more-menu .nav-more-group-label { @apply tw:m-0 tw:py-s-2 tw:px-s-2 tw:text-muted; font-size:var(--fs-label-xs); letter-spacing:0; border:0; }
.nav-more-menu a { @apply tw:min-w-0 tw:min-h-[44px] tw:text-secondary; font:500 var(--fs-label)/var(--lh-body) var(--font-sans); text-decoration:none; white-space:normal; }
.nav-more-menu a > span { min-width:0; overflow-wrap:anywhere; }
.nav-more-menu a:hover,.nav-more-menu a.active { @apply tw:text-accent; background:var(--accent-soft); }
.nav-more-menu a[data-pending='true'],.nav-more-menu a[data-intent='true'] { outline:1px solid var(--border-strong); outline-offset:-1px; background:var(--accent-soft); @apply tw:text-primary; }
.nav-more-menu .archive-icon { @apply tw:shrink-0 tw:w-[16px] tw:h-[16px]; }
.nav-more-trigger .nav-more-chevron { transition:none; }
.nav-more-heading { grid-column:1 / -1; @apply tw:flex tw:justify-between tw:items-center tw:gap-s-3 tw:text-primary tw:text-body-sm tw:pb-s-2; border-bottom:1px solid var(--border-soft); }
.nav-more-heading button { @apply tw:grid; place-items:center; @apply tw:min-w-[40px] tw:min-h-[40px]; border:0; @apply tw:rounded-md; background:var(--bg-base); @apply tw:text-secondary tw:cursor-pointer; }
.nav-more-heading button:hover { background:var(--accent-soft); color:var(--accent); }
.nav-more-menu .nav-current-label { @apply tw:ml-auto tw:shrink-0 tw:text-accent tw:text-label-xs; }
.nav-more-menu :is(a,button):focus-visible { outline:2px solid var(--accent); outline-offset:-2px; }
.nav-more-utilities { grid-column:1 / -1; @apply tw:grid tw:gap-s-1 tw:pt-s-2; border-top:1px solid var(--border-soft); }
.nav-more-menu .nav-help { @apply tw:min-h-[44px] tw:p-s-3; border:0; @apply tw:rounded-md; background:transparent; @apply tw:text-secondary tw:text-left; font:500 var(--fs-label)/var(--lh-body) var(--font-sans); @apply tw:cursor-pointer; }
.nav-more-utilities .appearance-entry { @apply tw:min-w-0 tw:min-h-[44px]; font:500 var(--fs-label)/var(--lh-body) var(--font-sans); }
.nav-more-menu .nav-help:hover { background:var(--bg-hover); }
@media(max-width:600px) {
  .studio-popover.nav-more-menu { grid-template-columns:minmax(0,1fr); @apply tw:gap-s-2; }
  .nav-more-group { grid-template-columns:minmax(0,1fr); }
  .nav-more-group + .nav-more-group { @apply tw:pt-s-1; border-top:1px solid var(--border-soft); }
}
</style>

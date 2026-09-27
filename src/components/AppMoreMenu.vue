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
</script>

<template>
  <StudioPopover v-model:open="open" label="更多页面" content-class="nav-more-menu" @close-auto-focus="emit('closeAutoFocus', $event)">
    <template #trigger><button type="button" class="nav-more-trigger">更多<ArchiveIcon name="chevron-down" class="nav-more-chevron" /></button></template>
    <header class="nav-more-heading"><strong>画室导航</strong><button type="button" aria-label="关闭更多页面" @click="open = false"><ArchiveIcon name="close" /></button></header>
    <template v-for="group in groups" :key="group.heading">
      <div class="nav-more-group-label">{{ group.heading }}</div>
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
    </template>
    <button class="nav-help" type="button" @click="emit('guide')">初次来访 · 使用指南</button>
    <AppearancePreferences launcher-only @open="emit('appearance')" />
  </StudioPopover>
</template>

<style>
@reference "../assets/css/tailwind.css";
/* This surface is portalled, so its links cannot inherit .nav-links rules. */
.studio-popover.nav-more-menu { @apply tw:grid; grid-template-columns:repeat(2,minmax(0,1fr)); @apply tw:gap-s-1; width:min(360px,calc(100vw - 32px)); }
.nav-more-menu a { @apply tw:min-h-[44px] tw:text-secondary; font:500 var(--fs-label)/var(--lh-body) var(--font-sans); text-decoration:none; }
.nav-more-menu a:hover,.nav-more-menu a.active { @apply tw:text-accent; background:var(--accent-soft); }
.nav-more-menu a[data-pending='true'],.nav-more-menu a[data-intent='true'] { outline:1px solid var(--border-strong); outline-offset:-1px; background:var(--accent-soft); @apply tw:text-primary; }
.nav-more-menu .archive-icon { @apply tw:shrink-0 tw:w-[16px] tw:h-[16px]; }
.nav-more-heading { grid-column:1 / -1; @apply tw:flex tw:justify-between tw:items-center tw:gap-s-3 tw:text-primary tw:text-body-sm tw:pb-s-2; border-bottom:1px solid var(--border-soft); }
.nav-more-heading button { @apply tw:grid; place-items:center; @apply tw:min-w-[40px] tw:min-h-[40px]; border:1px solid var(--border-soft); @apply tw:rounded-pill; background:var(--bg-base); @apply tw:text-secondary tw:cursor-pointer; }
.nav-more-menu .nav-current-label { @apply tw:ml-auto tw:text-accent tw:text-label-xs; }
.nav-more-menu :is(a,button):focus-visible { outline:2px solid var(--accent); outline-offset:-2px; }
.nav-more-menu .nav-help { grid-column:1 / -1; @apply tw:min-h-[44px] tw:p-s-3 tw:mt-s-2; border:0; border-top:1px solid var(--border-soft); @apply tw:rounded-md; background:transparent; @apply tw:text-secondary tw:text-left; font:500 var(--fs-label)/var(--lh-body) var(--font-sans); @apply tw:cursor-pointer; }
.nav-more-menu .nav-help:hover { background:var(--bg-hover); }
</style>

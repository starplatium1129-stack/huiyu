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
        </RouterLink>
      </StudioTooltip>
    </template>
    <button class="nav-help" type="button" @click="emit('guide')">初次来访 · 使用指南</button>
    <AppearancePreferences launcher-only @open="emit('appearance')" />
  </StudioPopover>
</template>

<style>
/* This surface is portalled, so its links cannot inherit .nav-links rules. */
.studio-popover.nav-more-menu { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--s-1); width:min(360px,calc(100vw - 32px)); }
.nav-more-menu a { min-height:44px; color:var(--text-secondary); font:500 var(--fs-label)/var(--lh-body) var(--font-sans); text-decoration:none; }
.nav-more-menu a:hover,.nav-more-menu a.active { color:var(--accent); background:var(--accent-soft); }
.nav-more-menu a[data-pending='true'],.nav-more-menu a[data-intent='true'] { outline:1px solid var(--border-strong); outline-offset:-1px; background:var(--accent-soft); color:var(--text-primary); }
.nav-more-menu .archive-icon { flex-shrink:0; width:16px; height:16px; }
.nav-more-menu :is(a,button):focus-visible { outline:2px solid var(--accent); outline-offset:-2px; }
.nav-more-menu .nav-help { grid-column:1 / -1; min-height:44px; padding:var(--s-3); margin-top:var(--s-2); border:0; border-top:1px solid var(--border-soft); border-radius:var(--r-md); background:transparent; color:var(--text-secondary); text-align:left; font:500 var(--fs-label)/var(--lh-body) var(--font-sans); cursor:pointer; }
.nav-more-menu .nav-help:hover { background:var(--bg-hover); }
</style>

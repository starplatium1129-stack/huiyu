<template>
  <section ref="drawerEl" class="material-drawer" aria-label="创作素材">
    <div class="material-heading"><span>创作素材</span><small>YOUR MATERIALS</small></div>
    <div class="material-switch" role="group" aria-label="素材分类">
      <AnimatedSelection />
      <button v-for="item in sections" :key="item.id" type="button"
        :aria-pressed="active === item.id" :aria-controls="`material-${item.id}`"
        @click="active = item.id">
        <ArchiveIcon :name="item.icon" /><span>{{ item.label }}</span>
      </button>
    </div>
    <!-- 首次选中才加载，之后保留输入、搜索与选中状态。 -->
    <div v-for="item in sections" v-show="active === item.id" v-content-motion="active === item.id" :id="`material-${item.id}`"
      :key="item.id" class="material-content" :aria-label="item.label">
      <DeferredPanel :active="active === item.id"><slot :name="item.id" /></DeferredPanel>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import DeferredPanel from './DeferredPanel.vue'
import AnimatedSelection from '../visual/AnimatedSelection.vue'
import ArchiveIcon, { type ArchiveIconName } from '../visual/ArchiveIcon.vue'

const props = defineProps<{ expert: boolean; sceneContext?: string }>()
const drawerEl = ref<HTMLElement | null>(null)
const active = ref(props.sceneContext ? 'scenes' : 'character')
async function selectSection(section: string) {
  if (!sections.value.some(item => item.id === section)) return
  active.value = section
  await nextTick()
  drawerEl.value?.querySelector<HTMLButtonElement>('[aria-controls="material-' + section + '"]')?.focus({ preventScroll: true })
  const rect = drawerEl.value?.getBoundingClientRect()
  if (rect && (rect.top < 0 || rect.top > innerHeight - 100)) drawerEl.value?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
}
watch(() => props.sceneContext, value => { if (value) active.value = 'scenes' })
defineExpose({ selectSection })
const sections = computed(() => {
  const items: Array<{ id: string; label: string; icon: ArchiveIconName }> = [
    { id: 'character', label: '角色', icon: 'character' },
    { id: 'scenes', label: '场景', icon: 'scene' },
    { id: 'story', label: '描述', icon: 'spark' },
  ]
  if (props.expert) items.push({ id: 'history', label: '历史', icon: 'gallery' })
  return items
})
watch(() => props.expert, value => {
  if (!value && active.value === 'history') active.value = 'character'
})
</script>

<style scoped>
@reference "../../assets/css/tailwind.css";
.material-drawer { @apply tw:min-w-0; container-type: inline-size; border: 1px solid var(--border-soft); @apply tw:rounded-xl; background: var(--bg-surface); @apply tw:overflow-clip; }
.material-heading { @apply tw:flex tw:justify-between tw:items-center tw:gap-s-2; padding: var(--s-3) var(--s-4); @apply tw:text-primary tw:text-body tw:font-semibold; }
.material-heading small { @apply tw:text-muted; font: 400 var(--fs-label-sm) var(--font-sans); letter-spacing: normal; }
.material-switch { @apply tw:relative tw:isolate tw:flex tw:gap-s-1; padding: 0 var(--s-3) var(--s-2); }
.material-switch button { @apply tw:relative; z-index: var(--z-raised); flex: 1; @apply tw:min-w-0 tw:min-h-[44px] tw:flex tw:items-center tw:justify-center tw:gap-s-1; border: 1px solid transparent; @apply tw:rounded-md; background: transparent; @apply tw:text-secondary; font: 500 var(--fs-body) var(--font-sans); @apply tw:cursor-pointer; }
.material-switch button[aria-pressed="true"] { background: transparent; @apply tw:text-accent; border-color: transparent; }
.material-switch button:hover { @apply tw:text-accent; }
.material-switch button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.material-switch .archive-icon { @apply tw:w-[16px] tw:h-[16px]; }
.material-content { @apply tw:p-s-3; }
.material-content :deep(.panel) { border: 0; box-shadow: none; background: transparent; @apply tw:p-s-1 tw:m-0; }
.material-content :deep(.panel::before), .material-content :deep(.panel::after) { @apply tw:hidden; }
@media (min-width:1024px) {
  .material-drawer { display:grid; grid-template-columns:48px minmax(0,1fr); grid-template-rows:auto minmax(0,1fr); }
  .material-heading { grid-column:1 / -1; }
  .material-switch { grid-column:1; grid-row:2; display:flex; flex-direction:column; align-self:start; margin:0 0 var(--s-2) var(--s-1); padding:var(--s-1); }
  .material-switch button { flex:none; flex-direction:column; gap:var(--s-1); min-height:58px; padding:var(--s-1); font-size:var(--fs-label-xs); }
  .material-content { grid-column:2; grid-row:2; padding:var(--s-2); border-left:1px solid var(--border-soft); }
}
</style>

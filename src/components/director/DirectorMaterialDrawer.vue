<template>
  <TabsRoot v-model="active" as-child :unmount-on-hide="false"><section ref="drawerEl" class="material-drawer" aria-label="创作素材">
    <div class="material-heading"><span><i class="workbench-heading-icon" aria-hidden="true"><ArchiveIcon name="scene" /></i>创作素材</span><small>YOUR MATERIALS</small></div>
    <TabsList class="material-switch" aria-label="素材分类">
      <AnimatedSelection variant="underline" />
      <TabsTrigger v-for="item in sections" :key="item.id" :value="item.id" as-child><button type="button"
        :id="`material-tab-${item.id}`" :aria-controls="`material-${item.id}`">
        <ArchiveIcon :name="item.icon" /><span class="studio-control-label">{{ item.label }}</span>
      </button></TabsTrigger>
    </TabsList>
    <!-- 首次选中才加载，之后保留输入、搜索与选中状态。 -->
    <TabsContent v-for="item in sections" :key="item.id" :value="item.id" force-mount as-child><div v-show="active === item.id" :id="`material-${item.id}`"
      v-content-motion:up="active === item.id" class="material-content" :aria-labelledby="`material-tab-${item.id}`">
      <DeferredPanel :active="active === item.id"><slot :name="item.id" :active="active === item.id" /></DeferredPanel>
    </div></TabsContent>
    <div class="material-footer"><slot name="footer" /></div>
  </section></TabsRoot>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import DeferredPanel from './DeferredPanel.vue'
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from 'reka-ui'
import ArchiveIcon, { type ArchiveIconName } from '../visual/ArchiveIcon.vue'
import AnimatedSelection from '../visual/AnimatedSelection.vue'
import { scrollBehavior } from '@/utils/motionPreference'

const props = defineProps<{ expert: boolean; sceneContext?: string }>()
const drawerEl = ref<HTMLElement | null>(null)
const active = ref(props.sceneContext ? 'scenes' : 'character')
async function selectSection(section: string) {
  if (!sections.value.some(item => item.id === section)) return
  active.value = section
  await nextTick()
  drawerEl.value?.querySelector<HTMLButtonElement>('[aria-controls="material-' + section + '"]')?.focus({ preventScroll: true })
  const rect = drawerEl.value?.getBoundingClientRect()
  if (rect && (rect.top < 0 || rect.top > innerHeight - 100)) drawerEl.value?.scrollIntoView({ block: 'start', behavior: scrollBehavior() })
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
.material-drawer { min-width:0; container-type:inline-size; border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-surface); overflow:clip; }
.material-heading { display:flex; justify-content:space-between; align-items:center; gap:8px; }
.material-switch { position:relative; display:flex; gap:4px; margin:0 20px; border-bottom:1px solid var(--border-soft); }
.material-switch button { display:flex; flex:1; min-width:0; min-height:42px; align-items:center; justify-content:center; gap:6px; padding:8px 4px; border:0; border-bottom:2px solid transparent; border-radius:var(--r-sm); background:transparent; color:var(--text-secondary); font:500 13px var(--font-sans); cursor:pointer; }
.material-switch button[data-state=active] { color:var(--accent); font-weight:600; }
.material-switch button:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.material-switch .archive-icon { width:16px; height:16px; }
.material-content { padding:20px; }
.material-content :deep(.panel) { border:0; box-shadow:none; background:transparent; padding:0; margin:0; }
.material-content :deep(.panel::before),.material-content :deep(.panel::after) { display:none; }
.material-footer { flex:none; padding:8px 16px; border-top:1px solid var(--border-soft); }
.material-footer :deep(button) { font-size:12px; }
</style>

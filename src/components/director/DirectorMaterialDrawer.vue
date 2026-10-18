<template>
  <TabsRoot v-model="active" as-child :unmount-on-hide="false"><section class="material-drawer" aria-label="创作素材">
    <div class="material-heading">
      <span><i class="workbench-heading-icon" aria-hidden="true"><ArchiveIcon name="scene" /></i>创作素材</span>
      <button v-if="compact" class="btn btn-quiet btn-sm" type="button" aria-controls="drawing-canvas" @click="$emit('back', $event)"><ArchiveIcon name="image" />返回画布</button>
    </div>
    <TabsList class="workbench-tabs material-switch" aria-label="素材分类">
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

const props = defineProps<{ expert: boolean; compact?: boolean; sceneContext?: string }>()
defineEmits<{ back: [event: MouseEvent] }>()
const active = ref(props.sceneContext ? 'scenes' : 'character')
async function selectSection(section: string) {
  if (!sections.value.some(item => item.id === section)) return
  active.value = section
  await nextTick()
  const button = document.getElementById(`material-tab-${section}`)
  button?.focus({ preventScroll: true })
  const drawer = button?.closest<HTMLElement>('.material-drawer')
  if (!drawer) return
  const rect = drawer.getBoundingClientRect()
  const top = parseFloat(getComputedStyle(drawer).scrollMarginTop) || 0
  if (rect.top < top || rect.top > innerHeight - 100) drawer.scrollIntoView({ block: 'start', behavior: scrollBehavior() })
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
.material-drawer { min-width:0; container:materials / inline-size; overflow:clip; scroll-margin-top:inherit; }
.material-heading { display:flex; justify-content:space-between; align-items:center; gap:8px; }
.material-content { padding:20px; }
.material-footer { flex:none; padding:8px 16px; border-top:1px solid var(--border-soft); }
.material-footer :deep(button) { font-size:12px; }
</style>

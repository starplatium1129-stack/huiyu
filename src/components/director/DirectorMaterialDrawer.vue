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
    <div v-for="item in sections" v-show="active === item.id" :id="`material-${item.id}`"
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
.material-drawer { min-width: 0; container-type: inline-size; border: 1px solid var(--border-soft); border-radius: var(--r-xl); background: var(--bg-surface); overflow: clip; }
.material-heading { display: flex; justify-content: space-between; align-items: center; gap: var(--s-2); padding: var(--s-3) var(--s-4); color: var(--text-primary); font-size: var(--fs-body); font-weight: 600; }
.material-heading small { color: var(--text-muted); font: 400 var(--fs-label-sm) var(--font-sans); letter-spacing: normal; }
.material-switch { position: relative; isolation: isolate; display: flex; gap: var(--s-1); padding: 0 var(--s-3) var(--s-2); }
.material-switch button { position: relative; z-index: var(--z-raised); flex: 1; min-width: 0; min-height: 44px; display: flex; align-items: center; justify-content: center; gap: var(--s-1); border: 1px solid transparent; border-radius: var(--r-md); background: transparent; color: var(--text-secondary); font: 500 var(--fs-body) var(--font-sans); cursor: pointer; }
.material-switch button[aria-pressed="true"] { background: transparent; color: var(--accent); border-color: transparent; }
.material-switch button:hover { color: var(--accent); }
.material-switch button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.material-switch .archive-icon { width: 16px; height: 16px; }
.material-content { padding: var(--s-3); }
.material-content :deep(.panel) { border: 0; box-shadow: none; background: transparent; padding: var(--s-1); margin: 0; }
.material-content :deep(.panel::before), .material-content :deep(.panel::after) { display: none; }
</style>

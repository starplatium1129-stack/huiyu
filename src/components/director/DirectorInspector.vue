<template>
  <TabsRoot v-model="active" as="aside" :unmount-on-hide="false" id="drawing-inspector"
    class="director-inspector inspector-workbench" aria-label="创作参数">
    <div class="inspector-heading"><strong><i class="workbench-heading-icon" aria-hidden="true"><ArchiveIcon name="gear" /></i>绘制工具</strong><span v-if="busy" role="status">正在绘制</span></div>
    <TabsList class="workbench-tabs inspector-tabs" aria-label="参数分类">
      <AnimatedSelection variant="underline" />
      <TabsTrigger v-for="tab in tabs" :key="tab.id" :value="tab.id" as-child>
        <button :id="`inspector-tab-${tab.id}`" type="button" :aria-controls="`inspector-${tab.id}`">
          <span class="studio-control-label">{{ tab.label }}</span><span v-if="tab.id === 'delivery' && queueCount" class="inspector-count">{{ queueCount }}</span>
        </button>
      </TabsTrigger>
    </TabsList>
    <!-- Each panel owns its scroll position. Once visited, retain drafts and running tools. -->
    <TabsContent v-for="tab in tabs" :key="tab.id" :value="tab.id" force-mount as-child>
      <section v-show="active === tab.id" v-content-motion:up="active === tab.id" :id="`inspector-${tab.id}`" :data-panel="tab.id"
        class="inspector-scroll inspector-section" :aria-labelledby="`inspector-tab-${tab.id}`" tabindex="0">
        <DeferredPanel :active="active === tab.id"><slot :name="tab.id" /></DeferredPanel>
      </section>
    </TabsContent>
    <slot name="actions" />
  </TabsRoot>
</template>

<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from 'reka-ui'
import DeferredPanel from './DeferredPanel.vue'
import AnimatedSelection from '../visual/AnimatedSelection.vue'
import ArchiveIcon from '../visual/ArchiveIcon.vue'
import '@/assets/css/director/expert-workspace.css'
import '@/assets/css/director/components/DirectorInspector.css'

defineProps<{ queueCount: number; busy: boolean }>()
const tabs = [
  { id: 'render', label: '绘制' }, { id: 'image', label: '图像' },
  { id: 'prompt', label: '提示词' }, { id: 'delivery', label: '任务' },
]
const active = ref('render')

async function selectSection(section: string, scrollToStart = false) {
  if (!tabs.some(tab => tab.id === section)) return
  active.value = section
  await nextTick()
  if (scrollToStart) document.getElementById(`inspector-${section}`)?.scrollTo({ top: 0, behavior: 'instant' })
  const button = document.getElementById(`inspector-tab-${section}`)
  button?.focus({ preventScroll: true })
  const bounds = button?.getBoundingClientRect()
  if (bounds && (bounds.top < 0 || bounds.bottom > innerHeight)) button?.scrollIntoView({ block: 'nearest' })
}
defineExpose({ selectSection })
</script>

<template>
  <TabsRoot v-model="active" as="aside" :unmount-on-hide="false" id="drawing-inspector"
    class="director-inspector inspector-workbench" aria-label="创作参数">
    <div class="inspector-heading"><strong>创作工具</strong><span>{{ busy ? '正在绘制' : '调整这一幕' }}</span></div>
    <TabsList class="inspector-tabs" aria-label="参数分类">
      <TabsTrigger v-for="tab in visibleTabs" :key="tab.id" :value="tab.id" as-child>
        <button :id="`inspector-tab-${tab.id}`" type="button" :aria-controls="`inspector-${tab.id}`">
          {{ tab.label }}<span v-if="tab.id === 'delivery' && queueCount" class="inspector-count">{{ queueCount }}</span>
        </button>
      </TabsTrigger>
    </TabsList>
    <!-- Each panel owns its scroll position. Once visited, retain drafts and running tools. -->
    <TabsContent v-for="tab in tabs" :key="tab.id" :value="tab.id" force-mount as-child>
      <section v-show="active === tab.id" :id="`inspector-${tab.id}`" :data-panel="tab.id"
        class="inspector-scroll inspector-section" :aria-labelledby="`inspector-tab-${tab.id}`" tabindex="0">
        <DeferredPanel :active="active === tab.id"><slot :name="tab.id" /></DeferredPanel>
      </section>
    </TabsContent>
  </TabsRoot>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useEventListener } from '@vueuse/core'
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from 'reka-ui'
import DeferredPanel from './DeferredPanel.vue'
import '@/assets/css/director/expert-workspace.css'
import '@/assets/css/director/components/DirectorInspector.css'

const props = defineProps<{ expert: boolean; queueCount: number; busy: boolean }>()
const tabs = [
  { id: 'render', label: '生成' }, { id: 'style', label: '画面' },
  { id: 'tools', label: '成片' }, { id: 'prompt', label: '提示词' }, { id: 'delivery', label: '任务' },
]
const visibleTabs = computed(() => tabs.filter(tab => props.expert || tab.id !== 'style'))
const active = ref('render')
watch(() => props.expert, expert => { if (!expert && active.value === 'style') active.value = 'render' })

async function selectSection(section: string) {
  if (!visibleTabs.value.some(tab => tab.id === section)) return
  active.value = section
  await nextTick()
  const button = document.getElementById(`inspector-tab-${section}`)
  button?.focus({ preventScroll: true })
  const bounds = button?.getBoundingClientRect()
  if (bounds && (bounds.top < 0 || bounds.bottom > innerHeight)) button?.scrollIntoView({ block: 'nearest' })
}
// The existing scene-mode output link must reveal its target after visiting another tool.
useEventListener(document, 'click', event => {
  if (event.target instanceof Element && event.target.closest('.pb a[href="#stepResult"]')) void selectSection('render')
})
defineExpose({ selectSection })
</script>

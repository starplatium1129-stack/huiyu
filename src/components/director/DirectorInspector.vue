<template>
  <StudioTabs v-model="active" :tabs="tabs" :stacked="!expert" as="aside" id-prefix="inspector"
    class="director-inspector" aria-label="创作参数" label="参数分类"
    list-class="inspector-tabs" content-class="inspector-scroll" panel-class="inspector-section">
    <template #heading><div class="inspector-heading"><strong>创作参数</strong><span>{{ busy ? '正在绘制' : '调整这一幕' }}</span></div></template>
    <template v-for="tab in tabs" :key="tab.id" #[tab.id]>
        <DeferredPanel :active="expert ? active === tab.id : tab.id !== 'style'">
          <slot :name="tab.id" />
        </DeferredPanel>
    </template>
  </StudioTabs>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import StudioTabs from '@/components/ui/StudioTabs.vue'
import DeferredPanel from './DeferredPanel.vue'
import '@/assets/css/director/expert-workspace.css'
const props = defineProps<{ expert: boolean; queueCount: number; busy: boolean }>()
const tabs = computed(() => [{ id:'render', label:'生成' }, { id:'style', label:'画面' }, { id:'prompt', label:'提示词' }, { id:'delivery', label:'任务', count:props.queueCount }])
const active = ref('render')
function selectSection(section: string) {
  if (tabs.value.some(tab => tab.id === section)) active.value = section
}
defineExpose({ selectSection })
</script>

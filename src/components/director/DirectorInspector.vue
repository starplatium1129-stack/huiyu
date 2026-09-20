<template>
  <aside class="director-inspector" aria-label="创作参数">
    <div class="inspector-heading"><strong>创作参数</strong><span>{{ busy ? '正在绘制' : '调整这一幕' }}</span></div>
    <div v-if="expert" class="inspector-tabs" role="tablist" aria-label="参数分类" @keydown="onKeydown">
      <button v-for="tab in tabs" :id="`inspector-tab-${tab.id}`" :key="tab.id" type="button" role="tab"
        :aria-selected="active === tab.id" :aria-controls="`inspector-${tab.id}`"
        :tabindex="active === tab.id ? 0 : -1" @click="active = tab.id">
        {{ tab.label }}<span v-if="tab.id === 'delivery' && queueCount" class="inspector-count">{{ queueCount }}</span>
      </button>
    </div>
    <div ref="scrollArea" class="inspector-scroll">
      <section v-for="tab in tabs" v-show="!expert || active === tab.id" :id="`inspector-${tab.id}`" :key="tab.id"
        class="inspector-section" :data-panel="tab.id" :role="expert ? 'tabpanel' : undefined"
        :aria-labelledby="expert ? `inspector-tab-${tab.id}` : undefined">
        <DeferredPanel :active="expert ? active === tab.id : tab.id !== 'style'">
          <slot :name="tab.id" />
        </DeferredPanel>
      </section>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { ref, nextTick, watch } from 'vue'
import DeferredPanel from './DeferredPanel.vue'
import '@/assets/css/director/expert-workspace.css'
defineProps<{ expert: boolean; queueCount: number; busy: boolean }>()
const tabs = [{ id: 'render', label: '生成' }, { id: 'style', label: '画面' }, { id: 'prompt', label: '提示词' }, { id: 'delivery', label: '任务' }]
const active = ref('render')
const scrollArea = ref<HTMLElement | null>(null)
watch(active, async () => { await nextTick(); if (scrollArea.value) scrollArea.value.scrollTop = 0 })
function selectSection(section: string) {
  if (tabs.some(tab => tab.id === section)) active.value = section
}
defineExpose({ selectSection })
function onKeydown(event: KeyboardEvent) {
  const index = tabs.findIndex(tab => tab.id === active.value)
  let next = index
  if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
  else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = tabs.length - 1
  else return
  event.preventDefault()
  active.value = tabs[next]!.id
  void nextTick(() => document.getElementById(`inspector-tab-${active.value}`)?.focus())
}
</script>

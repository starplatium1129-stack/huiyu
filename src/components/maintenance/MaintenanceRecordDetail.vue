<template>
  <section class="maintenance-inspector" :aria-label="`${label}详情`">
    <template v-if="record">
      <header class="inspector-header"><div><div class="inspector-kicker">{{ label }}档案 <code>{{ record.id }}</code></div><h2>{{ record.title || '未命名记录' }}</h2><div class="inspector-meta"><span>{{ record.characterName }}</span><span>{{ record.category || '未分类' }}</span><span>{{ record.rating }}</span><span v-if="readonly">只读</span></div></div></header>
      <ArchiveStatePanel v-if="record.adult && !local" compact kind="warning" title="此内容仅限本机查看" message="请在本机工作台打开这条记录。" />
      <template v-else>
        <div class="inspector-actions">
          <StudioTooltip anchor :content="readonly ? '桌面模式仅可查看和导出' : undefined">
            <button class="btn btn-primary btn-sm" type="button" :disabled="readonly" @click="$emit('edit', record.id)">编辑</button>
          </StudioTooltip>
          <RouterLink v-if="record.href" class="btn btn-ghost btn-sm" :to="record.href">使用此场景</RouterLink><button class="btn btn-ghost btn-sm" type="button" @click="copy(JSON.stringify(record.raw, null, 2), '记录 JSON')">复制 JSON</button><details :key="record.id" class="inspector-more"><summary>更多操作</summary><div><button class="btn btn-ghost btn-sm" type="button" :disabled="readonly" @click="$emit('duplicate', record.id)">复制为新记录</button><button class="btn btn-danger btn-sm" type="button" :disabled="readonly" @click="$emit('remove', record.id)">{{ kind === 'scene' ? '下架' : '删除' }}</button></div></details></div>
        <div class="inspector-tabs" aria-label="详情内容"><button type="button" :aria-pressed="section === 'overview'" @click="section = 'overview'">概览</button><button type="button" :aria-pressed="section === 'prompts'" @click="section = 'prompts'">提示词</button><span role="status">{{ feedback }}</span></div>
        <div ref="bodyEl" class="inspector-body" tabindex="0" :aria-label="section === 'overview' ? '场景概览内容' : '提示词内容'">
          <template v-if="section === 'overview'"><section class="inspector-section"><h3>故事与场景</h3><p class="inspector-story">{{ record.description || '尚未填写。可在编辑中补充。' }}</p></section><section class="inspector-section"><h3>场景要素</h3><dl v-if="record.facts.length" class="inspector-facts"><div v-for="fact in record.facts" :key="fact.label"><dt>{{ fact.label }}</dt><dd>{{ fact.value }}</dd></div></dl><p v-else class="inspector-empty">尚未填写场景要素。</p></section><details class="inspector-section inspector-tags" open><summary>标签 · {{ record.tags.length }}</summary><div><span v-for="(tag, index) in record.tags" :key="`${index}-${tag}`">{{ tag }}</span><p v-if="!record.tags.length" class="inspector-empty">暂无标签</p></div></details></template>
          <template v-else><section v-for="prompt in record.prompts.filter(item => item.value)" :key="prompt.label" class="inspector-section"><div class="inspector-section-head"><h3>{{ prompt.label }}</h3><button class="btn btn-ghost btn-sm" type="button" :aria-label="`复制${prompt.label}`" @click="copy(prompt.value, prompt.label)">复制</button></div><pre class="inspector-prompt">{{ prompt.value }}</pre></section><p v-if="!record.prompts.some(item => item.value)" class="inspector-empty">尚未填写提示词。</p></template>
        </div>
      </template>
    </template>
    <ArchiveStatePanel v-else compact kind="empty" title="选择一条记录" message="在左侧选择场景，完整内容会显示在这里。" />
  </section>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import type { MaintenanceRecord } from '@/utils/maintenanceRecords'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'
import ArchiveStatePanel from '@/components/visual/ArchiveStatePanel.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
const props = defineProps<{ record: MaintenanceRecord | null; kind: 'scene' | 'blueprint'; label: string; readonly: boolean }>()
defineEmits<{ edit: [id: string]; duplicate: [id: string]; remove: [id: string] }>()
const local = isLocalStudioHost()
const section = ref('overview')
const feedback = ref('')
const bodyEl = ref<HTMLElement | null>(null)
watch(() => props.record?.id, async () => {
  feedback.value = ''
  await nextTick()
  if (bodyEl.value) bodyEl.value.scrollTop = 0
})
async function copy(value: string, label: string) {
  const id = props.record?.id
  try { await navigator.clipboard.writeText(value); if (props.record?.id === id) feedback.value = `已复制${label}` }
  catch { if (props.record?.id === id) feedback.value = '复制失败，请手动选择文本复制。' }
}
</script>

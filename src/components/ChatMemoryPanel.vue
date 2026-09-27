<template>
  <section class="chat-memory-panel" aria-labelledby="chatMemoryTitle">
    <header>
      <div>
        <span>LONG-TERM MEMORY</span>
        <strong id="chatMemoryTitle">{{ characterName }}的长期记忆</strong>
      </div>
      <button type="button" class="memory-close" aria-label="关闭长期记忆" @click="$emit('close')">×</button>
    </header>
    <p>只保存你主动固定的事实。发送消息时最多召回 4 条相关内容，不自动记录角色说过的话。</p>
    <div v-if="!items.length" class="memory-empty">在自己的聊天气泡下点击“记住”，事实会出现在这里。</div>
    <div v-else class="memory-list">
      <article v-for="item in items" :key="item.id" class="memory-item">
        <textarea v-model="drafts[item.id]" maxlength="240" rows="2" :aria-label="`编辑记忆：${item.text}`"></textarea>
        <div>
          <span>{{ drafts[item.id]?.length || 0 }} / 240</span>
          <button type="button" class="btn btn-ghost" @click="save(item.id)">保存</button>
          <button type="button" class="btn btn-ghost" @click="requestDelete(item.id)">删除</button>
        </div>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { reactive, watch } from 'vue'
import { confirmAction } from '@/composables/useConfirm'
import type { ChatMemoryItem } from '@/utils/chatMemory'

const props = defineProps<{
  items: ChatMemoryItem[]
  characterName: string
}>()
const emit = defineEmits<{
  update: [id: string, text: string]
  delete: [id: string]
  close: []
}>()

const drafts = reactive<Record<string, string>>({})

watch(() => props.items, items => {
  const ids = new Set(items.map(item => item.id))
  for (const key of Object.keys(drafts)) if (!ids.has(key)) delete drafts[key]
  for (const item of items) drafts[item.id] = item.text
}, { deep: true, immediate: true })

function save(id: string) {
  const text = String(drafts[id] || '').trim()
  if (text) emit('update', id, text)
}

async function requestDelete(id: string) {
  const fact = props.items.find(item => item.id === id)
  if (!fact) return
  const confirmed = await confirmAction({
    title: '删除这条长期记忆？',
    message: fact.text,
    confirmLabel: '删除记忆',
    danger: true,
  })
  if (confirmed) emit('delete', id)
}
</script>

<style scoped src="@/assets/css/components/ChatMemoryPanel-0.css"></style>

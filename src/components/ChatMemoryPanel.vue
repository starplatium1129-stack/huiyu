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

<style scoped>
.chat-memory-panel {
  margin: 0 0 var(--s-4);
  padding: var(--s-4);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-lg);
  background: var(--glass-fill);
  box-shadow: var(--shadow-md);
}
.chat-memory-panel header,
.memory-item > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-3);
}
.chat-memory-panel header div { display: grid; gap: 2px; }
.chat-memory-panel header span { color: var(--text-muted); font-size: var(--fs-label-xs); font-weight: 700; letter-spacing: .08em; }
.chat-memory-panel header strong { color: var(--text-primary); font-size: var(--fs-title-xs); }
.chat-memory-panel > p { margin: var(--s-2) 0 var(--s-4); color: var(--text-secondary); font-size: var(--fs-label); }
.memory-close { border: 0; background: transparent; color: var(--text-muted); font-size: var(--fs-title); cursor: pointer; }
.memory-empty { padding: var(--s-4); border: 1px dashed var(--border-soft); border-radius: var(--r-md); color: var(--text-muted); text-align: center; }
.memory-list { display: grid; gap: var(--s-3); }
.memory-item { display: grid; gap: var(--s-2); }
.memory-item textarea { width: 100%; padding: 9px 11px; border: 1px solid var(--border-soft); border-radius: var(--r-md); background: var(--bg-deep); color: var(--text-primary); font: inherit; }
.memory-item > div { justify-content: flex-end; }
.memory-item > div span { margin-right: auto; color: var(--text-muted); font-size: var(--fs-mono-sm); }
</style>

<template>
  <section class="chat-memory-panel room-tool-panel" aria-labelledby="chatMemoryTitle">
    <header class="room-tool-heading">
      <div>
        <span>LONG-TERM MEMORY</span>
        <h2 id="chatMemoryTitle">{{ characterName }}的长期记忆</h2>
      </div>
      <button type="button" class="btn btn-quiet btn-icon" aria-label="关闭长期记忆" @click="close"><ArchiveIcon name="close" /></button>
    </header>
    <div class="room-tool-body">
      <p>只保存你主动固定的事实。可填写主题整理不同说法；同一主题只召回最近更新的一条，旧记录保留。每次最多召回 4 条。</p>
      <label class="studio-field-label" for="memory-recall-query">查看一句话会唤起哪些记忆</label>
      <input id="memory-recall-query" v-model="query" class="input" placeholder="输入你想说的话" maxlength="1200" />
      <p v-if="query.trim()" role="status">{{ recalled.length ? `匹配 ${recalled.length} 条，已在下方标明` : '未找到相关记忆，可补充主题或修改措辞' }}</p>
      <div v-if="!items.length" class="memory-empty">在自己的聊天气泡下点击“记住”，事实会出现在这里。</div>
      <div v-else class="memory-list">
        <article v-for="item in items" :key="item.id" class="memory-item">
          <input v-model="topics[item.id]" class="input" maxlength="40" :aria-label="`记忆主题：${item.topic || '未分类'}`" placeholder="主题（可选，例如：饮食偏好）" />
          <textarea v-model="drafts[item.id]" class="textarea" maxlength="240" rows="2" :aria-label="`编辑记忆：${item.text}`"></textarea>
          <small>{{ new Date(item.updatedAt).toLocaleString() }} · {{ item.sourceMid ? '来源：你固定的聊天消息' : '来源：手动记录' }}{{ recalled.includes(item.id) ? ' · 本次召回' : '' }}</small>
          <div>
            <span>{{ drafts[item.id]?.length || 0 }} / 240</span>
            <button type="button" class="btn btn-ghost btn-sm" @click="save(item.id)">保存</button>
            <button type="button" class="btn btn-quiet btn-sm" @click="requestDelete(item.id)">删除</button>
          </div>
        </article>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, reactive, ref, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { confirmAction } from '@/composables/useConfirm'
import type { ChatMemoryItem } from '@/utils/chatMemory'
import { normalizeChatMemoryText } from '@/utils/chatMemoryCore'
import { selectChatFacts } from '@/utils/chatMemoryRecall'

const props = defineProps<{
  items: ChatMemoryItem[]
  characterName: string
}>()
const emit = defineEmits<{
  update: [id: string, text: string, topic: string]
  delete: [id: string]
  close: []
}>()

const drafts = reactive<Record<string, string>>({})
const topics = reactive<Record<string, string>>({})
const savedTopics = new Map<string, string>()
const query = ref('')
const recalled = computed(() => selectChatFacts({ version: 1, byCharacter: { selected: props.items } }, 'selected', query.value).map(result => result.item.id))
const savedTexts = new Map<string, string>()
let confirmation: AbortController | null = null
function cancelDelete() { confirmation?.abort(); confirmation = null }
function close() { cancelDelete(); emit('close') }
onScopeDispose(cancelDelete)
watch(() => [props.items, props.characterName], cancelDelete, { deep: true, flush: 'sync' })

watch(() => props.items, items => {
  const ids = new Set(items.map(item => item.id))
  for (const key of Object.keys(drafts)) if (!ids.has(key)) { delete drafts[key]; delete topics[key]; savedTexts.delete(key); savedTopics.delete(key) }
  for (const item of items) {
    if (!(item.id in drafts) || drafts[item.id] === savedTexts.get(item.id)) drafts[item.id] = item.text
    savedTexts.set(item.id, item.text)
    if (!(item.id in topics) || topics[item.id] === savedTopics.get(item.id)) topics[item.id] = item.topic || ''
    savedTopics.set(item.id, item.topic || '')
  }
}, { deep: true, immediate: true })

function save(id: string) {
  const text = normalizeChatMemoryText(drafts[id])
  if (text) { drafts[id] = text; emit('update', id, text, topics[id] || '') }
}

async function requestDelete(id: string) {
  const fact = props.items.find(item => item.id === id)
  if (!fact || confirmation) return
  const controller = new AbortController()
  confirmation = controller
  const confirmed = await confirmAction({
    title: '删除这条长期记忆？',
    message: fact.text,
    confirmLabel: '删除记忆',
    danger: true,
    signal: controller.signal,
  })
  if (confirmation === controller) confirmation = null
  if (confirmed && !controller.signal.aborted) emit('delete', id)
}
</script>

<style scoped src="@/assets/css/components/ChatMemoryPanel-0.css"></style>

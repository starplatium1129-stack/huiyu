<template>
  <section class="chat-memory-panel room-tool-panel" aria-labelledby="chatMemoryTitle">
    <header class="room-tool-heading">
      <div>
        <span class="memory-journal-kicker">共同记忆手账</span>
        <h2 id="chatMemoryTitle">和{{ characterName }}的记忆手账</h2>
      </div>
      <button type="button" class="btn btn-quiet btn-icon" aria-label="关闭共同记忆手账" @click="close"><ArchiveIcon name="close" /></button>
    </header>
    <div class="room-tool-body">
      <p class="memory-journal-intro">记下你们聊过的小事与约定；对话时会按主题轻声想起最近的一条（每次最多回想 4 条）。</p>
      <div v-if="!items.length" class="memory-empty">手账还是空白的。在对话气泡旁点一下「记住」，就能悄悄夹进这一页。</div>
      <div v-else class="memory-list">
        <article v-for="{ item, row } in editableItems" :key="item.id" class="memory-item" :class="{ 'is-recalled': recalled.includes(item.id) }">
          <input v-model="row.topic" @input="markEdited(item.id, 'topicDirty')" class="input" maxlength="40" :aria-label="`便签主题：${item.topic || '未分类'}`" placeholder="主题（可选，例如：喜欢的甜点、约定）" />
          <textarea v-model="row.text" @input="markEdited(item.id, 'textDirty')" class="textarea" maxlength="240" rows="2" :aria-label="`编辑记忆便签：${item.text}`"></textarea>
          <small class="memory-item-meta">{{ new Date(item.updatedAt).toLocaleString() }} · {{ item.sourceMid ? '摘自对话' : '手写便签' }}{{ recalled.includes(item.id) ? ' · 本次会想起' : '' }}</small>
          <div class="memory-item-footer">
            <span>{{ row.text.length }} / 240</span>
            <button type="button" class="btn btn-ghost btn-sm" :aria-disabled="row.saving || row.deleting || undefined" :aria-busy="row.saving" @click="save(item.id)">{{ row.saving ? '保存中…' : '保存' }}</button>
            <button type="button" class="btn btn-quiet btn-sm" :aria-disabled="row.saving || row.deleting || undefined" :aria-busy="row.deleting" @click="requestDelete(item.id)">删除</button>
          </div>
          <p v-if="row.message" role="status">{{ row.message }}</p>
        </article>
      </div>
      <details v-if="items.length" class="memory-recall-debug">
        <StudioDisclosureSummary><span>回忆匹配预览（高级）</span></StudioDisclosureSummary>
        <div class="memory-recall-body" data-disclosure-content>
          <label class="studio-field-label" for="memory-recall-query">试写一句话，看看会唤起哪几条便签</label>
          <input id="memory-recall-query" v-model="query" class="input" placeholder="输入你想对她说的话…" maxlength="1200" />
          <p v-if="query.trim()" class="memory-recall-status" role="status">{{ recalled.length ? `本次将轻声唤起 ${recalled.length} 条记忆` : '这句话暂未匹配到相关便签' }}</p>
        </div>
      </details>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onScopeDispose, reactive, ref, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import { confirmAction } from '@/composables/useConfirm'
import type { ChatMemoryItem } from '@/utils/chatMemory'
import { normalizeChatMemoryText } from '@/utils/chatMemoryCore'
import { selectChatFacts } from '@/utils/chatMemoryRecall'

const props = defineProps<{
  items: ChatMemoryItem[]
  characterName: string
  saveMemory: (id: string, text: string, topic: string) => Promise<boolean>
  deleteMemory: (id: string) => Promise<boolean>
}>()
const emit = defineEmits<{
  close: []
}>()

interface MemoryDraft {
  text: string
  topic: string
  textDirty: boolean
  topicDirty: boolean
  saving: boolean
  deleting: boolean
  message: string
}
const rows = reactive(new Map<string, MemoryDraft>())
// The synchronous items watcher initializes each owner before rendering.
const editableItems = computed(() => props.items.map(item => ({ item, row: rows.get(item.id)! })))
const query = ref('')
const recalled = computed(() => selectChatFacts({ version: 1, byCharacter: { selected: props.items } }, 'selected', query.value).map(result => result.item.id))
let disposed = false
let confirmation: AbortController | null = null
function cancelDelete() { confirmation?.abort(); confirmation = null }
function close() { disposed = true; cancelDelete(); emit('close') }
onScopeDispose(() => { disposed = true; cancelDelete() })
watch(() => props.items, cancelDelete, { deep: true, flush: 'sync' })

watch(() => props.items, items => {
  const ids = new Set(items.map(item => item.id))
  for (const id of rows.keys()) if (!ids.has(id)) rows.delete(id)
  for (const item of items) {
    const row = rows.get(item.id)
    if (!row) {
      rows.set(item.id, { text: item.text, topic: item.topic || '', textDirty: false, topicDirty: false, saving: false, deleting: false, message: '' })
      continue
    }
    // Input ownership survives failed writes and reverting to the old saved value.
    if (!row.textDirty) row.text = item.text
    if (!row.topicDirty) row.topic = item.topic || ''
  }
}, { deep: true, immediate: true, flush: 'sync' })

function markEdited(id: string, field: 'textDirty' | 'topicDirty') {
  const row = rows.get(id)
  if (!row) return
  row[field] = true
  row.message = ''
}
function ownsRow(id: string, row: MemoryDraft) { return !disposed && rows.get(id) === row }

async function save(id: string) {
  const row = rows.get(id)
  if (!row || disposed || row.saving || row.deleting) return
  const text = normalizeChatMemoryText(row.text)
  if (!text) { row.message = '请填写记忆内容后再保存。'; return }
  const topic = normalizeChatMemoryText(row.topic).slice(0, 40)
  row.text = text; row.topic = topic
  row.saving = true; row.message = ''
  // Both submitted fields stay locally owned until persistence is confirmed.
  row.textDirty = true; row.topicDirty = true
  try {
    const saved = await props.saveMemory(id, text, topic)
    await nextTick()
    if (!ownsRow(id, row)) return
    if (!saved) { row.message = '保存尚未确认，当前修改已保留，请重试。'; return }
    const incoming = props.items.find(item => item.id === id)
    if (!incoming || incoming.text !== text || (incoming.topic || '') !== topic) {
      row.message = '记忆已发生变化，当前修改已保留，请确认后重试。'
      return
    }
    if (row.text === text) row.textDirty = false
    if (row.topic === topic) row.topicDirty = false
    row.message = row.textDirty || row.topicDirty ? '提交时的记忆已保存；当前修改尚未保存，请再次保存。' : '记忆已保存。'
  } catch {
    if (ownsRow(id, row)) row.message = '保存尚未确认，当前修改已保留，请重试。'
  } finally {
    if (ownsRow(id, row)) row.saving = false
  }
}

async function requestDelete(id: string) {
  const fact = props.items.find(item => item.id === id)
  const row = rows.get(id)
  if (!fact || !row || disposed || row.saving || row.deleting || confirmation) return
  const controller = new AbortController()
  confirmation = controller
  row.deleting = true
  try {
    const confirmed = await confirmAction({
      title: '删除这条长期记忆？',
      message: fact.text,
      confirmLabel: '删除记忆',
      danger: true,
      signal: controller.signal,
    })
    if (confirmation === controller) confirmation = null
    if (!confirmed || controller.signal.aborted || !ownsRow(id, row) || row.saving) return
    row.message = ''
    const deleted = await props.deleteMemory(id)
    await nextTick()
    if (ownsRow(id, row)) row.message = deleted ? '记忆已发生变化，请确认后重试删除。' : '删除尚未确认，请稍后重试。'
  } catch {
    if (ownsRow(id, row)) row.message = '删除尚未确认，请稍后重试。'
  } finally {
    if (confirmation === controller) confirmation = null
    if (ownsRow(id, row)) row.deleting = false
  }
}
</script>

<style scoped src="@/assets/css/components/ChatMemoryPanel-0.css"></style>

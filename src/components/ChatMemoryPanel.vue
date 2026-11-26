<template>
  <section class="chat-memory-panel room-tool-panel" aria-labelledby="chatMemoryTitle">
    <header class="room-tool-heading">
      <div>
        <h2 id="chatMemoryTitle">剧情记忆与摘要 · {{ characterName }}</h2>
      </div>
      <button type="button" class="btn btn-quiet btn-icon" aria-label="关闭长期记忆" @click="close"><ArchiveIcon name="close" /></button>
    </header>
    <div class="room-tool-body">
      <section v-if="characterId" class="story-summary-card" aria-labelledby="storySummaryHeading">
        <div class="story-summary-head">
          <h3 id="storySummaryHeading">长剧情前情提要（滚动摘要）</h3>
          <span v-if="summaryState.updatedAt" class="story-summary-time">更新于 {{ new Date(summaryState.updatedAt).toLocaleString() }}</span>
        </div>
        <p class="story-summary-desc">超长对话裁切前自动注入上下文，保障主线事件、约定与关系连续性。</p>
        <ToggleSwitch :model-value="summaryState.autoEnabled" label="自动滚动摘要" @update:model-value="toggleAutoSummary">
          消息超出上下文预算后自动在后台滚动归纳摘要
        </ToggleSwitch>
        <label class="sr-only" for="story-summary-editor">编辑当前分支前情提要</label>
        <textarea
          id="story-summary-editor"
          v-model="summaryDraft"
          class="textarea story-summary-textarea"
          maxlength="3000"
          rows="4"
          placeholder="当前分支暂无前情提要。你可以直接填写重点剧情，或点击下方「立即生成摘要」由模型归纳。"
        />
        <div class="story-summary-actions">
          <span class="story-summary-count">{{ summaryDraft.length }} / 3000</span>
          <button
            type="button"
            class="btn btn-primary btn-sm"
            :disabled="summaryGenerating || !canGenerateSummary"
            @click="generateSummaryNow"
          >
            {{ summaryGenerating ? '生成中…' : summaryDraft.trim() ? '更新摘要' : '立即生成摘要' }}
          </button>
          <button type="button" class="btn btn-ghost btn-sm" :disabled="summaryGenerating" @click="saveManualSummary">保存提要</button>
          <button v-if="summaryDraft.trim() || summaryState.text" type="button" class="btn btn-quiet btn-sm" :disabled="summaryGenerating" @click="clearBranchSummary">清空</button>
        </div>
        <p v-if="summaryMessage" class="story-summary-status" role="status">{{ summaryMessage }}</p>
      </section>

      <p>同主题召回最新 1 条 · 每次最多 4 条</p>
      <label class="studio-field-label" for="memory-recall-query">检索测试</label>
      <input id="memory-recall-query" v-model="query" class="input" placeholder="输入你想说的话" maxlength="1200" />
      <p v-if="query.trim()" role="status">{{ recalled.length ? `匹配 ${recalled.length} 条` : '未匹配到相关记忆' }}</p>
      <div v-if="!items.length" class="memory-empty">暂无记忆。在消息气泡下点击“记住”添加。</div>
      <div v-else class="memory-list">
        <article v-for="{ item, row } in editableItems" :key="item.id" class="memory-item">
          <input v-model="row.topic" @input="markEdited(item.id, 'topicDirty')" class="input" maxlength="40" :aria-label="`记忆主题：${item.topic || '未分类'}`" placeholder="主题（可选，例如：饮食偏好）" />
          <textarea v-model="row.text" @input="markEdited(item.id, 'textDirty')" class="textarea" maxlength="240" rows="2" :aria-label="`编辑记忆：${item.text}`"></textarea>
          <small>{{ new Date(item.updatedAt).toLocaleString() }} · {{ item.sourceMid ? '来源：你固定的聊天消息' : '来源：手动记录' }}{{ recalled.includes(item.id) ? ' · 本次召回' : '' }}</small>
          <div>
            <span>{{ row.text.length }} / 240</span>
            <button type="button" class="btn btn-ghost btn-sm" :aria-disabled="row.saving || row.deleting || undefined" :aria-busy="row.saving" @click="save(item.id)">{{ row.saving ? '保存中…' : '保存' }}</button>
            <button type="button" class="btn btn-quiet btn-sm" :aria-disabled="row.saving || row.deleting || undefined" :aria-busy="row.deleting" @click="requestDelete(item.id)">删除</button>
          </div>
          <p v-if="row.message" role="status">{{ row.message }}</p>
        </article>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onScopeDispose, reactive, ref, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
import { confirmAction } from '@/composables/useConfirm'
import type { ChatProvider } from '@/composables/chat/chatStorageTypes'
import type { ChatMemoryItem } from '@/utils/chatMemory'
import { normalizeChatMemoryText } from '@/utils/chatMemoryCore'
import { selectChatFacts } from '@/utils/chatMemoryRecall'
import {
  clearStorySummary,
  getStorySummary,
  requestStorySummary,
  saveStorySummary,
} from '@/utils/chatStorySummary'

export interface SummaryContext {
  provider: ChatProvider
  model: string
  hostConfig: boolean
  api?: { baseUrl: string; model: string; apiKey: string }
  chatgptClientId?: string
  userName: string
  messages: ReadonlyArray<{ mid: string; role: 'user' | 'assistant'; content: string }>
}

const props = defineProps<{
  items: ChatMemoryItem[]
  characterName: string
  characterId?: string
  branchId?: string
  summaryContext?: SummaryContext
  saveMemory: (id: string, text: string, topic: string) => Promise<boolean>
  deleteMemory: (id: string) => Promise<boolean>
}>()
const emit = defineEmits<{
  close: []
}>()

const branch = computed(() => props.branchId || 'main')
const summaryState = ref(props.characterId ? getStorySummary(props.characterId, branch.value) : {
  text: '',
  summarizedThroughMid: '',
  autoEnabled: false,
  updatedAt: 0,
})
const summaryDraft = ref(summaryState.value.text)
const summaryGenerating = ref(false)
const summaryMessage = ref('')
let summaryAbort: AbortController | null = null

const canGenerateSummary = computed(() => Boolean(
  props.summaryContext
  && props.summaryContext.provider !== 'muse'
  && props.summaryContext.messages.some(m => m.content.trim()),
))

watch(() => [props.characterId, branch.value] as const, ([charId, activeBranch]) => {
  if (!charId) return
  const next = getStorySummary(charId, activeBranch)
  summaryState.value = next
  summaryDraft.value = next.text
  summaryMessage.value = ''
})

function toggleAutoSummary(enabled: boolean) {
  if (!props.characterId) return
  const next = saveStorySummary(props.characterId, branch.value, { autoEnabled: enabled })
  summaryState.value = next
}

function saveManualSummary() {
  if (!props.characterId) return
  const next = saveStorySummary(props.characterId, branch.value, {
    text: summaryDraft.value,
    summarizedThroughMid: props.summaryContext?.messages.at(-1)?.mid || summaryState.value.summarizedThroughMid,
  })
  summaryState.value = next
  summaryDraft.value = next.text
  summaryMessage.value = '前情提要已保存。'
}

function clearBranchSummary() {
  if (!props.characterId) return
  clearStorySummary(props.characterId, branch.value)
  summaryState.value = getStorySummary(props.characterId, branch.value)
  summaryDraft.value = ''
  summaryMessage.value = '前情提要已清空。'
}

async function generateSummaryNow() {
  if (!props.characterId || !props.summaryContext || summaryGenerating.value) return
  summaryAbort?.abort()
  const controller = new AbortController()
  summaryAbort = controller
  summaryGenerating.value = true
  summaryMessage.value = ''
  try {
    const generated = await requestStorySummary({
      ...props.summaryContext,
      characterName: props.characterName,
      existingSummary: summaryDraft.value.trim(),
      signal: controller.signal,
    })
    if (controller.signal.aborted || disposed) return
    const next = saveStorySummary(props.characterId, branch.value, {
      text: generated,
      summarizedThroughMid: props.summaryContext.messages.at(-1)?.mid || '',
    })
    summaryState.value = next
    summaryDraft.value = next.text
    summaryMessage.value = '前情提要已更新并保存。'
  } catch (error) {
    if (!controller.signal.aborted && !disposed) {
      summaryMessage.value = error instanceof Error ? error.message : '生成摘要失败，请重试。'
    }
  } finally {
    if (summaryAbort === controller) summaryAbort = null
    summaryGenerating.value = false
  }
}

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
const editableItems = computed(() => props.items.map(item => ({ item, row: rows.get(item.id)! })))
const query = ref('')
const recalled = computed(() => selectChatFacts({ version: 1, byCharacter: { selected: props.items } }, 'selected', query.value).map(result => result.item.id))
let disposed = false
let confirmation: AbortController | null = null
function cancelDelete() { confirmation?.abort(); confirmation = null }
function close() { disposed = true; cancelDelete(); summaryAbort?.abort(); emit('close') }
onScopeDispose(() => { disposed = true; cancelDelete(); summaryAbort?.abort() })
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
<style scoped>
.story-summary-card { display:grid; gap:var(--s-2); margin-bottom:var(--s-4); padding:var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-base); }
.story-summary-head { display:flex; flex-wrap:wrap; align-items:baseline; justify-content:space-between; gap:var(--s-2); }
.story-summary-head h3 { margin:0; font:600 var(--fs-body-sm)/1.3 var(--font-sans); color:var(--text-primary); }
.story-summary-time { color:var(--text-secondary); font:400 var(--fs-label-xs)/1.3 var(--font-sans); }
.story-summary-desc { margin:0; color:var(--text-secondary); font:400 var(--fs-label-xs)/1.4 var(--font-sans); }
@supports (field-sizing:content) {
  .story-summary-textarea { field-sizing:content; resize:none; min-block-size:4lh; max-block-size:14lh; }
}
.story-summary-actions { display:flex; flex-wrap:wrap; align-items:center; justify-content:flex-end; gap:var(--s-2); }
.story-summary-count { margin-right:auto; color:var(--text-secondary); font:400 var(--fs-label-xs)/1.3 var(--font-mono); }
.story-summary-status { margin:0; color:var(--text-secondary); font:400 var(--fs-label-xs)/1.4 var(--font-sans); }
</style>

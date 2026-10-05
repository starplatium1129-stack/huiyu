<template>
  <section class="chat-archive-panel" aria-label="对话历史归档">
    <div class="archive-panel-head">
      <div>
        <strong>对话归档</strong>
        <small>对话超过 20 条时，早期消息自动转入本地归档；可随时导出备份或并回当前对话。</small>
      </div>
      <button class="btn btn-ghost btn-sm" type="button" @click="close">收起</button>
    </div>

    <div class="archive-counts" role="list" aria-label="各角色归档条数">
      <span v-for="id in characterIds" :key="id" role="listitem">
        {{ characterName(id) }}：<strong>{{ counts[id] || 0 }}</strong> 条
      </span>
    </div>

    <div class="archive-actions">
      <button class="btn btn-ghost btn-sm" type="button" :disabled="exporting" @click="exportJson">导出 JSON</button>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="exporting" @click="exportMarkdown">导出 Markdown</button>
      <button class="btn btn-ghost btn-sm" type="button" @click="fileEl?.click()">导入归档</button>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="restoring || !counts[activeChar]" @click="restoreCurrent">
        归档并入当前对话
      </button>
      <button class="btn btn-ghost btn-sm danger" type="button" :disabled="clearing || !totalCount" @click="clearArchive">
        清空归档
      </button>
      <input ref="fileEl" class="archive-file-input" type="file" accept=".json,application/json" @change="onFile">
    </div>
  </section>
</template>

<script setup lang="ts">
import { downloadBlob } from "@/utils/downloadBlob"
import { computed, onScopeDispose, ref, watch } from 'vue'
import { chatResetRevision } from '@/utils/chatReset'
import { getCompanionCharacter } from '@/utils/companionRegistry'
import type { useChatStorage } from '@/composables/chat/useChatStorage'
import { confirmAction } from '@/composables/useConfirm'

type ChatStorage = ReturnType<typeof useChatStorage>

const props = defineProps<{
  storage: ChatStorage
  activeChar: string
}>()

const emit = defineEmits<{
  close: []
  notice: [message: string, kind?: 'info' | 'warning' | 'error']
}>()

const fileEl = ref<HTMLInputElement>()
let fileRequest = 0, disposed = false
let context = new AbortController()
const exporting = ref(false), restoring = ref(false), clearing = ref(false)
function invalidate() {
  ++fileRequest
  context.abort()
  context = new AbortController()
  exporting.value = false; restoring.value = false; clearing.value = false
}
function close() { invalidate(); emit('close') }
watch(() => [props.storage, props.activeChar], invalidate, { flush: 'sync' })
onScopeDispose(() => { disposed = true; invalidate() })
const characterIds = computed(() => Object.keys(counts.value))

function characterName(id: string) {
  return getCompanionCharacter(id)?.name || id
}

const counts = computed(() => props.storage.archiveCount())
const totalCount = computed(() => Object.values(counts.value).reduce((sum, n) => sum + n, 0))

function download(name: string, content: string, mime: string) {
  downloadBlob(new Blob([content], { type: mime }), name)
}

async function exportArchive(format: 'json' | 'markdown') {
  if (disposed || exporting.value) return
  const owner = context, storage = props.storage, revision = chatResetRevision()
  const current = () => !disposed && !owner.signal.aborted && revision === chatResetRevision()
  exporting.value = true
  try {
    const content = await (format === 'json' ? storage.exportArchiveJson() : storage.exportArchiveMarkdown())
    if (!current()) return
    if (!totalCount.value) { emit('notice', '归档里还没有消息。', 'info'); return }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16)
    download(`aics-chat-archive-${stamp}.${format === 'json' ? 'json' : 'md'}`, content,
      format === 'json' ? 'application/json;charset=utf-8' : 'text/markdown;charset=utf-8')
    emit('notice', `已导出 ${totalCount.value} 条归档消息。`, 'info')
  } catch (error) { if (current()) emit('notice', `无法读取归档：${error instanceof Error ? error.message : '存储暂不可用'}`, 'error') }
  finally { if (context === owner) exporting.value = false }
}
const exportJson = () => exportArchive('json')
const exportMarkdown = () => exportArchive('markdown')

async function onFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  const request = ++fileRequest, storage = props.storage
  const current = () => !disposed && request === fileRequest && storage === props.storage
  if (!file) return
  if (file.size > 8 * 1024 * 1024) {
    emit('notice', '归档文件超过 8 MB，请确认来源后重试。', 'error')
    return
  }
  try {
    const revision = chatResetRevision()
    const text = await file.text()
    if (!current()) return
    if (revision !== chatResetRevision()) { emit('notice', '聊天内容已清空，请重新选择归档文件后导入。', 'warning'); return }
    const added = await storage.importArchiveJson(text, current)
    if (!current()) return
    if (revision !== chatResetRevision()) { emit('notice', '聊天内容已清空，请重新选择归档文件后导入。', 'warning'); return }
    emit('notice', added ? `导入完成，新增 ${added} 条归档消息。` : '导入完成，没有新增消息（可能已存在）。', 'info')
  } catch (error) {
    if (current()) emit('notice', `无法读取归档：${error instanceof Error ? error.message : '文件读取失败'}`, 'error')
  }
}

async function restoreCurrent() {
  if (disposed || restoring.value) return
  const owner = context, storage = props.storage, character = props.activeChar
  const current = () => !disposed && !owner.signal.aborted
  restoring.value = true
  try {
    const added = await storage.restoreFromArchive(character, current)
    if (!current()) return
    emit('notice', added
      ? `已把 ${added} 条归档消息并回 ${characterName(character)} 的对话。`
      : '当前角色没有可并入的归档消息。', 'info')
  } catch (error) {
    if (current()) emit('notice', `无法恢复归档：${error instanceof Error ? error.message : '存储暂不可用'}`, 'error')
  } finally { if (context === owner) restoring.value = false }
}

async function clearArchive() {
  if (disposed || clearing.value || !totalCount.value) return
  const owner = context, storage = props.storage, revision = chatResetRevision()
  const current = () => !disposed && !owner.signal.aborted && revision === chatResetRevision()
  clearing.value = true
  try {
    const confirmed = await confirmAction({
      title: '清空全部对话归档？',
      message: '本地保存的历史归档消息将被彻底清空。建议在操作前先导出 JSON 或 Markdown 备份。',
      confirmLabel: '清空归档',
      danger: true,
      signal: owner.signal,
    })
    if (!confirmed || !current()) return
    const cleared = await storage.clearArchive(undefined, current)
    if (!current()) return
    if (cleared) emit('notice', '对话归档已清空。', 'info')
    else emit('notice', '归档清空尚未保存，请重试。', 'error')
  } catch (error) {
    if (current()) emit('notice', `无法清空归档：${error instanceof Error ? error.message : '存储暂不可用'}`, 'error')
  } finally { if (context === owner) clearing.value = false }
}
</script>

<style scoped src="@/assets/css/components/ChatArchivePanel-0.css"></style>

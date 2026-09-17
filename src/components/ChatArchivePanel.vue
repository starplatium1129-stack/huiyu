<template>
  <section class="chat-archive-panel" aria-label="对话历史归档">
    <div class="archive-panel-head">
      <div>
        <strong>对话归档</strong>
        <small>对话超过 20 条时，早期消息自动转入本地归档；可随时导出备份或并回当前对话。</small>
      </div>
      <button class="btn btn-ghost btn-sm" type="button" @click="$emit('close')">收起</button>
    </div>

    <div class="archive-counts" role="list" aria-label="各角色归档条数">
      <span v-for="id in characterIds" :key="id" role="listitem">
        {{ characterName(id) }}：<strong>{{ counts[id] || 0 }}</strong> 条
      </span>
    </div>

    <div class="archive-actions">
      <button class="btn btn-ghost btn-sm" type="button" @click="exportJson">导出 JSON</button>
      <button class="btn btn-ghost btn-sm" type="button" @click="exportMarkdown">导出 Markdown</button>
      <button class="btn btn-ghost btn-sm" type="button" @click="fileEl?.click()">导入归档</button>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="!counts[activeChar]" @click="restoreCurrent">
        归档并入当前对话
      </button>
      <button class="btn btn-ghost btn-sm danger" type="button" :disabled="!totalCount" @click="clearArchive">
        清空归档
      </button>
      <input ref="fileEl" class="archive-file-input" type="file" accept=".json,application/json" @change="onFile">
    </div>
  </section>
</template>

<script setup lang="ts">
import { downloadBlob } from "@/utils/downloadBlob"
import { computed, ref } from 'vue'
import { CHARACTERS } from '@/config/characters'
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
const characterIds = Object.keys(CHARACTERS)

function characterName(id: string) {
  return CHARACTERS[id]?.name || id
}

const counts = computed(() => props.storage.archiveCount())
const totalCount = computed(() => Object.values(counts.value).reduce((sum, n) => sum + n, 0))

function download(name: string, content: string, mime: string) {
  downloadBlob(new Blob([content], { type: mime }), name)
}

function exportJson() {
  if (!totalCount.value) {
    emit('notice', '归档里还没有消息。', 'info')
    return
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16)
  download(`aics-chat-archive-${stamp}.json`, props.storage.exportArchiveJson(), 'application/json;charset=utf-8')
  emit('notice', `已导出 ${totalCount.value} 条归档消息（JSON）。`, 'info')
}

function exportMarkdown() {
  if (!totalCount.value) {
    emit('notice', '归档里还没有消息。', 'info')
    return
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16)
  download(`aics-chat-archive-${stamp}.md`, props.storage.exportArchiveMarkdown(), 'text/markdown;charset=utf-8')
  emit('notice', `已导出 ${totalCount.value} 条归档消息（Markdown）。`, 'info')
}

function onFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (file.size > 8 * 1024 * 1024) {
    emit('notice', '归档文件超过 8 MB，请确认来源后重试。', 'error')
    return
  }
  void file.text().then(text => {
    try {
      const added = props.storage.importArchiveJson(text)
      emit('notice', added ? `导入完成，新增 ${added} 条归档消息。` : '导入完成，没有新增消息（可能已存在）。', 'info')
    } catch (error) {
      emit('notice', `无法读取归档：${error instanceof Error ? error.message : '文件已损坏'}`, 'error')
    }
  }).catch(error => {
    emit('notice', `无法读取归档：${error instanceof Error ? error.message : '文件读取失败'}`, 'error')
  })
}

function restoreCurrent() {
  const added = props.storage.restoreFromArchive(props.activeChar)
  emit('notice', added
    ? `已把 ${added} 条归档消息并回 ${characterName(props.activeChar)} 的对话。`
    : '当前角色没有可并入的归档消息。', 'info')
}

async function clearArchive() {
  if (!totalCount.value) return
  const confirmed = await confirmAction({
    title: '清空全部对话归档？',
    message: '本地保存的历史归档消息将被彻底清空。建议在操作前先导出 JSON 或 Markdown 备份。',
    confirmLabel: '清空归档',
    danger: true,
  })
  if (!confirmed) return
  props.storage.clearArchive()
  emit('notice', '对话归档已清空。', 'info')
}
</script>

<style scoped>
.chat-archive-panel {
  display: grid;
  gap: var(--s-3);
  margin: 0 0 var(--s-4);
  padding: var(--s-4);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-lg);
  background: var(--bg-surface);
}
.archive-panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--s-3);
}
.archive-panel-head strong { display: block; }
.archive-panel-head small { display: block; margin-top: 2px; color: var(--text-muted); }
.archive-counts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s-2) var(--s-4);
  color: var(--text-secondary);
  font-size: var(--fs-label);
}
.archive-counts strong { color: var(--accent); }
.archive-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s-2);
}
.archive-file-input { display: none; }
.danger { color: var(--danger-text); }
.danger:disabled { color: var(--text-muted); }
</style>

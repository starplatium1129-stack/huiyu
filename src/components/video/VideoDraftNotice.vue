<template>
  <section v-if="store.draftIssue" class="video-draft-notice" role="alert">
    <p>部分视频草稿暂不可读取，原记录已保留并停止覆盖：{{ store.draftIssue }}</p>
    <div class="tw:flex tw:flex-wrap tw:gap-s-2">
      <button class="btn btn-ghost btn-sm" type="button" :disabled="busy" @click="store.reloadDamagedDrafts">重新读取</button>
      <button class="btn btn-ghost btn-sm" type="button" @click="download">导出原草稿</button>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="busy" @click="discard">放弃损坏草稿</button>
    </div>
    <p v-if="error">{{ error }}</p>
  </section>
</template>
<script setup lang="ts">
import { ref, onScopeDispose, onDeactivated } from 'vue'
import { useVideoStore } from '@/stores/videoStore'
import { downloadBlob } from '@/utils/downloadBlob'
import { confirmAction } from '@/composables/useConfirm'
const store = useVideoStore(), busy = ref(false), error = ref('')
let confirmation: AbortController | undefined
onScopeDispose(() => confirmation?.abort())
onDeactivated(() => confirmation?.abort())
function download() { downloadBlob(store.exportDamagedDrafts(), '绘遇-视频草稿原件.json') }
async function discard() {
  if (busy.value) return
  busy.value = true; error.value = ''; confirmation = new AbortController()
  try {
    if (!await confirmAction({ title: '放弃无法读取的草稿？', message: '仅清除上方无法读取的记录。已保存作品和正常草稿保留；建议先导出原草稿。', confirmLabel: '放弃损坏草稿', signal: confirmation.signal })) return
    await store.discardDamagedDrafts()
  }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '清除尚未确认，请重试' }
  finally { busy.value = false }
}
</script>
<style scoped>
.video-draft-notice { padding:var(--s-4); margin-bottom:var(--s-4); border:1px solid var(--border-strong); border-radius:var(--r-md); background:var(--bg-surface); color:var(--text-primary); }
.video-draft-notice p { margin:0 0 var(--s-3); }
</style>

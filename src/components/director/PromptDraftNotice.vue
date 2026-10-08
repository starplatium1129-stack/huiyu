<script setup lang="ts">
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { getDesktopCapabilities } from '@/platform/desktop/capabilities'
import { exportDirectorBlueprint } from '@/utils/directorBlueprintFile'

defineProps<{ blueprint: Record<string, unknown> }>()
const pb = usePromptBuilderStore()
const desktop = Boolean(getDesktopCapabilities())
</script>

<template>
  <section v-if="!desktop && pb.draftSaveState !== 'idle'" class="draft-save-notice" :data-state="pb.draftSaveState" aria-label="草稿保存状态">
    <p role="status" aria-live="polite">{{ pb.draftSaveState === 'failed' ? pb.draftSaveError : pb.draftSaveState === 'pending' ? '正在保存草稿…' : '草稿已保存到此浏览器' }}</p>
    <template v-if="pb.draftSaveState === 'failed'">
      <button class="btn btn-ghost btn-sm" type="button" @click="pb.retryDraftSave()">重试保存</button>
      <button class="btn btn-ghost btn-sm" type="button" @click="exportDirectorBlueprint(blueprint)">导出当前草稿</button>
      <span>导出的文件可通过「数据工具 → 导入蓝图配置」恢复。</span>
    </template>
  </section>
</template>

<style scoped>
.draft-save-notice { display:flex; align-items:center; flex-wrap:wrap; gap:var(--s-2); margin-bottom:var(--s-2); font-size:var(--fs-label-sm); color:var(--text-secondary); flex-shrink:0; }
.draft-save-notice p { margin:0; }
.draft-save-notice[data-state='failed'] { padding:var(--s-3); border:1px solid var(--danger-text); border-radius:var(--r-md); background:var(--bg-surface); }
.draft-save-notice[data-state='failed'] p { color:var(--danger-text); flex-basis:100%; }
</style>

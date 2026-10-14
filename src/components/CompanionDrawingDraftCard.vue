<template>
  <section class="companion-drawing-draft" aria-label="绘画草稿">
    <div><strong>绘画草稿已准备</strong><small>尚未生成图片</small></div>
    <p>{{ draft.description }}</p>
    <button type="button" @click="open"><ArchiveIcon name="palette" />到工作台编辑并生成</button>
  </section>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router'
import { getDesktopCapabilities } from '@/platform/desktop/capabilities'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import type { CompanionDrawingDraft } from '@/types/companionDrawing'
const props = defineProps<{ draft: CompanionDrawingDraft }>()
const router = useRouter()
function open() {
  const path = `/prompt-builder?companionDraft=${encodeURIComponent(props.draft.path)}&draftOpen=${Date.now()}`
  const desktop = getDesktopCapabilities()
  if (desktop) desktop.openAtelier(path)
  else void router.push(path)
}
</script>

<style scoped>
.companion-drawing-draft { margin:10px 14px 0; padding:12px; border:1px solid var(--border-soft); border-radius:12px; background:var(--bg-surface); }
.companion-drawing-draft > div { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
.companion-drawing-draft strong { font-size:13px; color:var(--text-primary); }
.companion-drawing-draft small { font-size:11px; color:var(--text-secondary); }
.companion-drawing-draft p { margin:8px 0; max-height:72px; overflow:auto; color:var(--text-primary); font-size:12px; line-height:1.7; white-space:pre-wrap; overflow-wrap:anywhere; }
.companion-drawing-draft button { display:flex; align-items:center; gap:6px; min-height:32px; padding:5px 8px; border:1px solid var(--border-soft); border-radius:8px; background:var(--bg-elevated); color:var(--text-primary); font-size:12px; }
</style>

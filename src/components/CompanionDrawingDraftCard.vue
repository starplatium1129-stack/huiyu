<template>
  <section class="companion-drawing-draft" aria-label="绘画草稿">
    <div><strong>绘画草稿已准备</strong><small>尚未生成图片</small></div>
    <p>{{ draft.description }}</p>
    <button class="btn btn-ghost btn-sm" type="button" @click="open"><ArchiveIcon name="palette" />到工作台编辑并生成</button>
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
.companion-drawing-draft { margin:var(--s-3) var(--s-4) 0; padding:var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-surface); }
.companion-drawing-draft > div { display:flex; flex-wrap:wrap; align-items:center; gap:var(--s-2); }
.companion-drawing-draft strong { font-size:var(--fs-label); color:var(--text-primary); }
.companion-drawing-draft small { font-size:var(--fs-label-xs); color:var(--text-secondary); }
.companion-drawing-draft p { margin:var(--s-2) 0; max-height:6em; overflow:auto; color:var(--text-primary); font-size:var(--fs-body-sm); line-height:var(--lh-body); white-space:pre-wrap; overflow-wrap:anywhere; }
.companion-drawing-draft button { max-width:100%; white-space:normal; text-align:start; }
</style>

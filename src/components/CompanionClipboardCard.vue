<template>
  <FluidTransition panel=".companion-clipboard-card">
    <div v-if="card" class="companion-clipboard-card" role="status" aria-live="polite">
      <img v-if="card.kind === 'image'" :src="card.previewUrl" alt="剪贴板图片预览" />
      <div>
        <strong>{{ card.kind === 'image' ? '检测到复制的图片' : '检测到复制的文本' }}</strong>
        <p v-if="card.kind === 'text'" class="companion-clipboard-preview">{{ card.text }}</p>
        <p v-if="card.error" class="tw:m-0 tw:text-warning-text tw:text-label tw:leading-body" role="alert">{{ card.error }}</p>
      </div>
      <div class="companion-clipboard-actions">
        <button v-if="card.kind === 'image'" type="button" class="btn btn-secondary btn-sm" :disabled="card.saving" @click="emit('inspect')">让{{ characterName }}看看</button>
        <button type="button" class="btn btn-primary btn-sm" :disabled="card.saving" :aria-busy="card.saving || false" @click="emit('accept')">{{ card.saving ? '处理中…' : card.kind === 'image' ? '存入作品册' : '填入输入框' }}</button>
        <button type="button" class="btn btn-ghost btn-sm" @click="emit('dismiss')">忽略</button>
      </div>
    </div>
  </FluidTransition>
</template>
<script setup lang="ts">
import FluidTransition from '@/components/visual/FluidTransition.vue'
defineProps<{ card: { kind: 'image' | 'text'; previewUrl?: string; text?: string; saving?: boolean; error?: string } | null; characterName: string }>()
const emit = defineEmits<{ inspect: []; accept: []; dismiss: [] }>()
</script>

<style scoped>
.companion-clipboard-card { display:flex; flex-wrap:wrap; align-items:center; gap:var(--s-3); margin:var(--s-3) var(--s-4) 0; padding:var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-surface); color:var(--text-primary); }
.companion-clipboard-card img { width:64px; height:64px; flex-shrink:0; object-fit:contain; border-radius:var(--r-sm); background:var(--bg-elevated); }
.companion-clipboard-card > div:not(.companion-clipboard-actions) { flex:1; min-width:0; }
.companion-clipboard-card strong { font-size:var(--fs-label); }
.companion-clipboard-preview { max-height:6em; overflow:auto; margin:var(--s-2) 0 0; white-space:pre-wrap; overflow-wrap:anywhere; color:var(--text-secondary); font-size:var(--fs-body-sm); line-height:var(--lh-body); }
.companion-clipboard-actions { display:flex; flex-wrap:wrap; gap:var(--s-2); width:100%; }
.companion-clipboard-actions button:disabled { opacity:1; color:var(--text-disabled); }
</style>

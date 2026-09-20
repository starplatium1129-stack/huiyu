<template>
  <section
    class="empty-state archive-state-panel"
    :class="{ compact }"
    :data-kind="kind"
    :role="role"
    :aria-busy="kind === 'loading' ? 'true' : undefined"
  >
    <div class="archive-state-mark" aria-hidden="true">
      <ArchiveIcon :name="iconName" />
    </div>
    <div v-if="code" class="archive-state-code">{{ code }}</div>
    <h2>{{ title }}</h2>
    <p v-if="message">{{ message }}</p>
    <div v-if="$slots.default" class="archive-state-actions"><slot /></div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import ArchiveIcon, { type ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'

const props = withDefaults(defineProps<{
  kind: 'loading' | 'empty' | 'filtered' | 'error' | 'success' | 'warning'
  title: string
  message?: string
  code?: string
  compact?: boolean
}>(), { message:'', code:'', compact:false })

const role = computed(() => (props.kind === 'error' || props.kind === 'warning') ? 'alert' : props.kind === 'loading' ? 'status' : undefined)

const iconName = computed<ArchiveIconName>(() => ({
  loading:'refresh', empty:'gallery', filtered:'search', error:'warning', success:'success', warning:'warning',
})[props.kind] as ArchiveIconName)
</script>

<style scoped>
.archive-state-panel {
  min-height:260px;
  display:grid;
  place-items:center;
  align-content:center;
  border-color:var(--border-soft);
  background:var(--bg-surface);
  padding:var(--s-6) var(--s-4);
  border-style:solid;
  border-width:1px;
  border-radius:var(--r-lg);
}
.archive-state-panel h2 { margin:var(--s-2) 0; font-size:var(--fs-title-sm); line-height:var(--lh-tight); font-weight:600; }
.archive-state-panel p { max-width:38em; margin:0; color:var(--text-secondary); font-size:var(--fs-body-sm); line-height:var(--lh-loose); }
.archive-state-mark::before { content:''; position:absolute; inset:4px; border:1px solid var(--border-strong); border-radius:var(--r-md); transform:rotate(-8deg); background:var(--bg-elevated); }
.archive-state-mark :deep(.archive-icon) { position:relative; }
.archive-state-panel.compact { min-height:150px; margin:0; padding:var(--s-4); }
.archive-state-panel.compact .archive-state-mark { width:52px; height:52px; margin-bottom:var(--s-2); }
.archive-state-mark { position:relative; display:grid; place-items:center; width:68px; height:68px; margin:0 auto var(--s-3); color:var(--state-accent,var(--archive-blue)); font-size:var(--fs-glyph); }
.archive-state-code { color:var(--text-secondary); font:500 var(--fs-mono-xs) var(--font-mono); letter-spacing:.1em; }
.archive-state-actions { display:flex; justify-content:center; gap:var(--s-2); flex-wrap:wrap; margin-top:var(--s-3); }
[data-kind="loading"] { --state-accent:var(--archive-blue); }
[data-kind="empty"] { --state-accent:var(--accent); }
[data-kind="filtered"] { --state-accent:var(--archive-blue); }
[data-kind="error"] { --state-accent:var(--danger-text); }
[data-kind="success"] { --state-accent:var(--success-text); }
[data-kind="loading"] :deep(.archive-icon) { animation:state-counter 1.8s linear infinite reverse; }
[data-kind="error"] h2 { color:var(--danger-text); }
[data-kind="success"] h2 { color:var(--success-text); }
@keyframes state-counter{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.archive-state-mark i,.archive-state-mark :deep(.archive-icon),.archive-state-mark{animation:none!important}}
</style>

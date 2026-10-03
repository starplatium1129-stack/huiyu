<template>
  <section
    class="empty-state archive-state-panel"
    :class="{ compact }"
    :data-kind="kind"
    :role="role"
    :aria-busy="kind === 'loading' ? 'true' : undefined"
  >
    <div class="archive-state-mark tw:relative tw:grid tw:place-items-center tw:w-[68px] tw:h-[68px] tw:mt-0 tw:mx-auto tw:mb-s-3 tw:[color:var(--state-accent,var(--archive-blue))] tw:text-glyph" aria-hidden="true">
      <ArchiveIcon :name="iconName" />
    </div>
    <div v-if="code" class="archive-state-code tw:text-secondary tw:[font:500_var(--fs-mono-xs)_var(--font-mono)] tw:[letter-spacing:.1em]">{{ code }}</div>
    <h2 class="archive-state-title">{{ title }}</h2>
    <p v-if="message" class="archive-state-message">{{ message }}</p>
    <div v-if="$slots.default" class="archive-state-actions tw:flex tw:justify-center tw:gap-s-2 tw:flex-wrap tw:mt-s-3"><slot /></div>
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
@reference "../../assets/css/tailwind.css";
/* Shared control bases retain selector precedence and avoid repeated template payload. */
.archive-state-panel { @apply tw:min-h-[260px] tw:grid tw:place-items-center tw:content-center tw:border-soft tw:[background:var(--bg-surface)] tw:py-s-6 tw:px-s-4 tw:border-solid tw:[border-width:1px] tw:rounded-lg; }
.archive-state-title { @apply tw:my-s-2 tw:mx-0 tw:text-title-sm tw:leading-tight tw:font-semibold; }
.archive-state-message { @apply tw:max-w-[38em] tw:m-0 tw:text-secondary tw:text-body-sm tw:leading-loose; }

.archive-state-mark::before { content:''; position:absolute; inset:4px; border-radius:var(--r-lg); background:var(--bg-elevated); }
.archive-state-mark :deep(.archive-icon) { position:relative; }
.archive-state-panel.compact { min-height:150px; margin:0; padding:var(--s-4); }
.archive-state-panel.compact .archive-state-mark { width:52px; height:52px; margin-bottom:var(--s-2); }
[data-kind="loading"] { --state-accent:var(--archive-blue); }
[data-kind="empty"] { --state-accent:var(--accent); }
[data-kind="filtered"] { --state-accent:var(--archive-blue); }
[data-kind="error"] { --state-accent:var(--danger-text); }
[data-kind="success"] { --state-accent:var(--success-text); }
[data-kind="warning"] { --state-accent:var(--warning-text); }
[data-kind="loading"] :deep(.archive-icon) { animation:state-counter 1.1s linear infinite; }
[data-kind="error"] h2 { color:var(--danger-text); }
[data-kind="success"] h2 { color:var(--success-text); }
[data-kind="warning"] h2 { color:var(--warning-text); }
@keyframes state-counter{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.archive-state-mark i,.archive-state-mark :deep(.archive-icon),.archive-state-mark{animation:none!important}}
:root:is([data-motion='reduce'],[data-motion='reduced']) .archive-state-mark :deep(.archive-icon) { animation:none!important; }
</style>

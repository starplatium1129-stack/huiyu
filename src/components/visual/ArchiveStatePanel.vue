<template>
  <section
    v-content-motion:fade="kind === 'filtered'"
    class="empty-state archive-state-panel"
    :class="{ compact, illustrated: !!$slots.illustration, 'has-chibi': !!$slots.chibi && !$slots.illustration }"
    :data-kind="kind"
    :data-character="character || undefined"
    :role="role"
    :aria-busy="kind === 'loading' ? 'true' : undefined"
  >
    <div v-if="$slots.illustration" class="archive-state-illustration" aria-hidden="true"><slot name="illustration" /></div>
    <div v-else-if="$slots.chibi" class="archive-state-chibi" aria-hidden="true"><slot name="chibi" /></div>
    <div v-else class="archive-state-mark tw:relative tw:grid tw:place-items-center tw:w-[68px] tw:h-[68px] tw:mt-0 tw:mx-auto tw:mb-s-3 tw:[color:var(--state-accent,var(--archive-blue))] tw:text-glyph" aria-hidden="true">
      <StudioOrbitSpinner v-if="kind === 'loading'" /><ArchiveIcon v-else :name="iconName" />
    </div>
    <div v-if="code" class="archive-state-code">
      <span class="archive-state-dot" aria-hidden="true" />
      <span>{{ code }}</span>
    </div>
    <component :is="headingLevel" class="archive-state-title">{{ title }}</component>
    <p v-if="message" class="archive-state-message">{{ message }}</p>
    <div v-if="$slots.default" class="archive-state-actions tw:flex tw:justify-center tw:gap-s-2 tw:flex-wrap tw:mt-s-3"><slot /></div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import ArchiveIcon, { type ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'
import StudioOrbitSpinner from '@/components/ui/StudioOrbitSpinner.vue'

const props = withDefaults(defineProps<{
  kind: 'loading' | 'empty' | 'filtered' | 'error' | 'success' | 'warning'
  title: string
  message?: string
  code?: string
  compact?: boolean
  /** 文档层级控制：页面主空态默认 h2，嵌入侧栏/子区传 h3 或 p */
  headingLevel?: 'h2' | 'h3' | 'p'
  /** 可选角色语境（如 nene / natsume），带入角色色点与画册氛围 */
  character?: string
}>(), {
  message: '',
  code: '',
  compact: false,
  headingLevel: 'h2',
  character: '',
})

const role = computed(() => (props.kind === 'error' || props.kind === 'warning') ? 'alert' : props.kind === 'loading' ? 'status' : undefined)

const iconName = computed<ArchiveIconName>(() => ({
  loading: 'refresh',
  empty: 'gallery',
  filtered: 'search',
  error: 'warning',
  success: 'success',
  warning: 'warning',
})[props.kind] as ArchiveIconName)
</script>

<style scoped>
@reference "../../assets/css/tailwind.css";
/* Shared control bases retain selector precedence and avoid repeated template payload. */
.archive-state-panel {
  @apply tw:min-h-[260px] tw:grid tw:place-items-center tw:content-center tw:border-soft tw:py-s-6 tw:px-s-4 tw:border-solid tw:[border-width:1px] tw:rounded-lg;
  margin: var(--s-4) auto 0;
  background: radial-gradient(ellipse at 50% 0, color-mix(in srgb, var(--state-accent, var(--accent)) 8%, transparent), transparent 65%), var(--bg-surface);
  box-shadow: inset 0 1px 0 var(--glass-highlight);
}
/* Soft dashed artbook inner lining; excluded from Terraria pixel style. */
.archive-state-panel::before {
  inset: var(--s-2);
  border-style: dashed;
  border-color: color-mix(in srgb, var(--state-accent, var(--border-strong)) 34%, transparent);
  border-radius: calc(var(--r-lg) - 6px);
}
.archive-state-code {
  display: inline-flex;
  align-items: center;
  gap: var(--s-1);
  padding: 2px var(--s-2);
  margin-bottom: var(--s-1);
  border: 1px solid color-mix(in srgb, var(--state-accent, var(--border-strong)) 26%, transparent);
  border-radius: var(--r-pill);
  background: color-mix(in srgb, var(--state-accent, var(--bg-elevated)) 8%, var(--bg-surface));
  color: var(--text-secondary);
  font: 500 var(--fs-mono-xs) / var(--lh-flush) var(--font-mono);
  letter-spacing: .09em;
}
.archive-state-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--state-character, var(--state-accent, var(--accent)));
  flex: none;
}
.archive-state-title {
  @apply tw:my-s-2 tw:mx-0 tw:text-title-sm tw:leading-tight tw:font-semibold;
  color: var(--text-primary);
}
.archive-state-message { @apply tw:max-w-[38em] tw:m-0 tw:text-secondary tw:text-body-sm tw:leading-loose; }
.archive-state-panel.illustrated { min-height: clamp(340px, 48vh, 500px); border: 0; border-radius: 0; background: transparent; box-shadow: none; }
.archive-state-panel.illustrated::before { display: none; }
.archive-state-illustration { width: 100%; margin: 0 auto var(--s-5); }
.archive-state-panel.illustrated .archive-state-title { font: 600 clamp(1.4rem, 1.7vw, 1.8rem) / var(--lh-tight) var(--font-serif); }

.archive-state-chibi {
  display: grid;
  place-items: center;
  max-width: 176px;
  margin: 0 auto var(--s-3);
}
.archive-state-chibi :deep(img) {
  display: block;
  width: 100%;
  height: auto;
  object-fit: contain;
  pointer-events: none;
}

.archive-state-mark::before, .archive-state-mark::after { content: ''; position: absolute; inset: 6px; border-radius: var(--r-lg); border: 1px solid var(--border-soft); }
.archive-state-mark::before { transform: translate(-4px, 3px) rotate(-10deg); background: color-mix(in srgb, var(--state-accent, var(--accent)) 12%, var(--bg-surface)); }
.archive-state-mark::after { background: var(--bg-surface); box-shadow: var(--shadow-sm); transform: rotate(4deg); }
.archive-state-mark :deep(.archive-icon), .archive-state-mark :deep(.studio-orbit-spinner) { position: relative; z-index: var(--z-raised); }
.archive-state-mark :deep(.studio-orbit-spinner) { width: 36px; height: 36px; color: var(--state-accent); }
.archive-state-panel.compact { min-height: 150px; margin: 0; padding: var(--s-4); }
.archive-state-panel.compact .archive-state-mark { width: 52px; height: 52px; margin-bottom: var(--s-2); }
.archive-state-panel.compact .archive-state-chibi { max-width: 112px; margin-bottom: var(--s-2); }

[data-character='nene'] { --state-character: var(--nene-violet); }
[data-character='natsume'] { --state-character: var(--natsume-amber); }
[data-kind='loading'] { --state-accent: var(--archive-blue); }
[data-kind='empty'] { --state-accent: var(--state-character, var(--accent)); }
[data-kind='filtered'] { --state-accent: var(--state-character, var(--archive-blue)); }
[data-kind='error'] { --state-accent: var(--danger-text); }
[data-kind='success'] { --state-accent: var(--success-text); }
[data-kind='warning'] { --state-accent: var(--warning-text); }
[data-kind='error'] .archive-state-title { color: var(--danger-text); }
[data-kind='success'] .archive-state-title { color: var(--success-text); }
[data-kind='warning'] .archive-state-title { color: var(--warning-text); }

:root[data-theme-style='terraria'] .archive-state-panel::before { border-style: solid; border-radius: 0; }
:root[data-theme-style='terraria'] .archive-state-code { border-radius: 0; }
:root[data-theme-style='terraria'] .archive-state-dot { border-radius: 0; }

@media (forced-colors: active) {
  .archive-state-panel { background: Canvas; }
  .archive-state-panel::before { display: none; }
  .archive-state-mark::before, .archive-state-mark::after { background: Canvas; border-color: CanvasText; }
  .archive-state-code { background: Canvas; border-color: CanvasText; color: CanvasText; }
}
</style>

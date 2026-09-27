<template>
  <header
    class="archive-page-hero tw:relative tw:grid tw:[grid-template-columns:minmax(0,_1fr)_minmax(280px,_.8fr)] tw:min-h-[300px] tw:mb-s-6 tw:overflow-hidden tw:isolate tw:[border-bottom:1px_solid_var(--border-soft)]"
    :class="{ 'is-compact': compact }"
  >
    <div v-if="!compact" class="archive-register tw:absolute tw:top-s-5 tw:left-0 tw:text-muted tw:[font:500_var(--fs-label-xs)/var(--lh-label)_var(--font-sans)] tw:[letter-spacing:.14em] tw:uppercase" aria-hidden="true">
      <span>{{ section }}</span>
    </div>

    <div class="archive-copy tw:self-center tw:min-w-0 tw:[padding:var(--s-8)_var(--s-6)_var(--s-6)_0]">
      <slot />
      <div v-if="$slots.meta" class="archive-meta tw:flex tw:flex-wrap tw:gap-s-2 tw:mt-s-4">
        <slot name="meta" />
      </div>
    </div>

    <SemanticParticleField
      v-if="!compact"
      class="archive-particles"
      :shape="shape"
      :portrait-id="portraitId"
      :label="label"
      :caption="caption || `FILE ${chapter} / ${folio}`"
      :density="compact ? 'ambient' : 'hero'"
    />

  </header>
</template>

<script setup lang="ts">
import SemanticParticleField from '@/components/visual/SemanticParticleField.vue'
import type { ParticleShapeId } from '@/utils/particleShapes'

withDefaults(defineProps<{
  chapter: string
  section: string
  shape: ParticleShapeId
  label: string
  folio?: string
  caption?: string
  compact?: boolean
  /** 角色形象粒子：有预生成点云时粒子重组为该角色剪影。 */
  portraitId?: string
}>(), {
  folio: '08',
  caption: '',
  compact: false,
  portraitId: '',
})

</script>

<style scoped>
@reference "../../assets/css/tailwind.css";
/* Keep scoped precedence at this component boundary. */
.archive-particles { @apply tw:min-w-0 tw:min-h-[300px]; }
.archive-copy :deep(h1) { margin: var(--s-3) 0 var(--s-4); font: 500 clamp(2rem, 3.2vw, 3rem)/var(--lh-tight) var(--font-display); letter-spacing: -.04em; }
.archive-copy :deep(p) { max-width: 42em; color: var(--text-secondary); line-height: var(--lh-loose); }
.archive-page-hero.is-compact { grid-template-columns: minmax(0, 1fr); min-height: 0; }
.is-compact .archive-copy { padding-top: var(--s-6); padding-bottom: var(--s-5); }
@media (max-width: 768px) { .archive-page-hero { grid-template-columns: minmax(0, 1fr); } .archive-copy { padding-right: 0; } .archive-particles { min-height: 200px; } }
</style>

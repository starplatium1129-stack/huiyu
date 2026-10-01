<template>
  <div class="outfit-override-note" role="status">
    <ArchiveIcon name="wardrobe" class="outfit-override-icon" />
    <span class="outfit-override-text">已换装为「{{ outfitOverrideLabel }}」</span>
    <button type="button" class="outfit-override-restore" @click="pb.clearOutfitOverride()">
      恢复默认服装
    </button>
  </div>
</template>

<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { usePromptTagTools } from '@/composables/prompt/usePromptTagTools'

const pb = usePromptBuilderStore()
const { outfitOverrideLabel } = usePromptTagTools(pb)
</script>

<style scoped>
@reference "../../assets/css/tailwind.css";
.outfit-override-note {
  @apply tw:flex tw:items-center tw:gap-s-2 tw:mb-s-3; padding: var(--s-2) var(--s-3);
  border: 1px solid color-mix(in srgb, var(--accent) 34%, var(--border-soft));
  @apply tw:rounded-md; background: var(--accent-soft);
  @apply tw:text-label-xs tw:leading-label;
}
.outfit-override-icon { flex: 0 0 auto; @apply tw:w-[15px] tw:h-[15px] tw:text-accent; }
.outfit-override-text { flex: 1 1 auto; @apply tw:min-w-0 tw:text-secondary; }
.outfit-override-restore {
  flex: 0 0 auto; padding: 4px 10px; border: 1px solid var(--border-strong);
  @apply tw:rounded-pill; background: var(--bg-elevated);
  @apply tw:text-primary tw:text-label-xs tw:cursor-pointer;
  transition: border-color var(--motion-hover), background var(--motion-hover);
}
.outfit-override-restore:hover { @apply tw:border-accent; background: var(--bg-hover); }
.outfit-override-restore:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>

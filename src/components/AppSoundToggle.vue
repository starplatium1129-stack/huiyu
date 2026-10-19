<template>
  <StudioTooltip :content="soundEnabled ? '界面音效已开启' : '界面音效已关闭'">
    <button
      type="button"
      class="sound-toggle tw:grid tw:place-items-center tw:w-[32px] tw:h-[32px] tw:p-0 tw:rounded-[50%] tw:text-muted tw:cursor-pointer"
      data-interface-sound-toggle
      :class="{ active: soundEnabled }"
      :aria-pressed="soundEnabled"
      :aria-label="soundEnabled ? '关闭界面音效' : '开启界面音效'"
      @click="toggleSound"
    >
      <ArchiveIcon :name="soundEnabled ? 'sound' : 'mute'" />
    </button>
  </StudioTooltip>
</template>

<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import { useInterfaceFeedback } from '@/composables/useInterfaceFeedback'

const { soundEnabled, toggleSound } = useInterfaceFeedback()
</script>

<style scoped>
.sound-toggle {
  border:1px solid var(--border-soft);
  background:var(--bg-surface);
  transition:color var(--motion-hover),border-color var(--motion-hover),background var(--motion-hover);
}
.sound-toggle.active { color:var(--text-primary); border-color:var(--border-strong); background:var(--bg-elevated); }
/* Shared control feedback animates the icon while the hit target stays fixed. */
@media (hover: hover) and (pointer: fine) {
  .sound-toggle:hover { color:var(--text-primary); border-color:var(--border-strong); background:var(--bg-hover); }
}
.sound-toggle:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
</style>

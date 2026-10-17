<template>
  <StudioTooltip content="外观与动态效果">
    <button type="button" class="btn btn-ghost btn-icon appearance-button" :class="{ 'btn-sm': compact }" aria-label="外观与动态效果" @click="open">
      <ArchiveIcon name="palette" />
    </button>
  </StudioTooltip>
</template>
<script setup lang="ts">
import ArchiveIcon from './visual/ArchiveIcon.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
defineProps<{ compact?: boolean }>()
function open() { window.dispatchEvent(new CustomEvent('atelier:appearance-open', { detail: { section: 'appearance' } })) }
</script>

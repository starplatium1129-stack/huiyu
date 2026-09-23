<template>
  <StudioTooltip :content="soundEnabled ? '界面音效已开启' : '界面音效已关闭'">
    <button
      type="button"
      class="sound-toggle"
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
  display:grid;
  place-items:center;
  width:32px;
  height:32px;
  padding:0;
  border:1px solid var(--border-soft);
  border-radius:50%;
  background:var(--bg-surface);
  color:var(--text-muted);
  cursor:pointer;
  transition:color var(--motion-hover),border-color var(--motion-hover),background var(--motion-hover),transform var(--motion-hover);
}
.sound-toggle.active { color:var(--archive-blue); border-color:color-mix(in srgb,var(--archive-blue) 48%,var(--border-soft)); background:var(--archive-blue-soft); }
/* plans/003：触控设备没有 hover 语义，粘滞 hover 会让高亮状态「卡住」；
   hover 动效只在精确指针设备启用，按压反馈（:active）保留给触屏。 */
@media (hover: hover) and (pointer: fine) {
  .sound-toggle:hover { color:var(--archive-blue); border-color:color-mix(in srgb,var(--archive-blue) 48%,var(--border-soft)); background:var(--archive-blue-soft); }
}
.sound-toggle:active { transform:scale(.97); }
.sound-toggle:focus-visible { outline:none; box-shadow:var(--ring); }
</style>

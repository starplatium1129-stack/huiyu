<template>
  <div class="archive-corner-frame tw:absolute tw:[z-index:var(--z-raised)] tw:inset-[10px] tw:pointer-events-none" :class="`corner-${variant}`" aria-hidden="true">
    <i class="tl"></i><i class="tr"></i><i class="bl"></i><i class="br"></i>
  </div>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  /** 装饰强度：frame 常规四角；ghost 更淡（用于结果画布叠层） */
  variant?: 'frame' | 'ghost'
}>(), { variant: 'frame' })
</script>

<style scoped>
.archive-corner-frame i {
  position: absolute;
  width: 24px;
  height: 24px;
  border-color: color-mix(in srgb, var(--accent) 78%, var(--editorial-gold));
  border-style: solid;
  opacity: 0.85;
  box-shadow: 0 0 8px color-mix(in srgb, var(--accent) 35%, transparent);
  transition: border-color var(--motion-surface), opacity var(--motion-surface);
}
.archive-corner-frame .tl { top: 0; left: 0; border-width: var(--line-hairline) 0 0 var(--line-hairline); }
.archive-corner-frame .tr { top: 0; right: 0; border-width: var(--line-hairline) var(--line-hairline) 0 0; }
.archive-corner-frame .bl { bottom: 0; left: 0; border-width: 0 0 var(--line-hairline) var(--line-hairline); }
.archive-corner-frame .br { right: 0; bottom: 0; border-width: 0 var(--line-hairline) var(--line-hairline) 0; }
.archive-corner-frame.corner-ghost {
  opacity: 0.5;
}
</style>

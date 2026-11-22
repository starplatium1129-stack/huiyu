<template>
  <div class="archive-corner-frame tw:absolute tw:[z-index:var(--z-raised)] tw:inset-[10px] tw:pointer-events-none" :class="`corner-${variant}`" aria-hidden="true">
    <i class="tl"></i><i class="tr"></i><i class="bl"></i><i class="br"></i>
  </div>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  /** 装饰强度：frame 常规四角；ghost 更淡（画布叠层）；editorial 画册分镜细框（圆角 L 线 + 极克制四角星芒） */
  variant?: 'frame' | 'ghost' | 'editorial'
}>(), { variant: 'frame' })
</script>

<style scoped>
.archive-corner-frame {
  --corner-ink: color-mix(in srgb, var(--character-accent, var(--accent)) 72%, var(--editorial-gold));
}
.archive-corner-frame i {
  position: absolute;
  width: 22px;
  height: 22px;
  border-color: var(--corner-ink);
  border-style: solid;
  opacity: 0.82;
  transition: border-color var(--motion-surface), opacity var(--motion-surface);
}
.archive-corner-frame .tl { top: 0; left: 0; border-width: var(--line-hairline) 0 0 var(--line-hairline); border-top-left-radius: var(--r-xs); }
.archive-corner-frame .tr { top: 0; right: 0; border-width: var(--line-hairline) var(--line-hairline) 0 0; border-top-right-radius: var(--r-xs); }
.archive-corner-frame .bl { bottom: 0; left: 0; border-width: 0 0 var(--line-hairline) var(--line-hairline); border-bottom-left-radius: var(--r-xs); }
.archive-corner-frame .br { right: 0; bottom: 0; border-width: 0 var(--line-hairline) var(--line-hairline) 0; border-bottom-right-radius: var(--r-xs); }

.archive-corner-frame.corner-ghost {
  opacity: 0.5;
}

/* 画册分镜细框：精致圆角 L 线配极克制 1px 十字星芒，仅用于主舞台，严守克制边界 */
.archive-corner-frame.corner-editorial {
  inset: 12px;
}
.archive-corner-frame.corner-editorial i {
  width: 24px;
  height: 24px;
  opacity: 0.78;
}
.archive-corner-frame.corner-editorial i::after {
  content: "";
  position: absolute;
  width: 7px;
  height: 7px;
  pointer-events: none;
  background:
    linear-gradient(var(--corner-ink), var(--corner-ink)) center / 1px 100% no-repeat,
    linear-gradient(var(--corner-ink), var(--corner-ink)) center / 100% 1px no-repeat;
  opacity: 0.68;
}
.archive-corner-frame.corner-editorial .tl::after { top: 3px; left: 3px; }
.archive-corner-frame.corner-editorial .tr::after { top: 3px; right: 3px; }
.archive-corner-frame.corner-editorial .bl::after { bottom: 3px; left: 3px; }
.archive-corner-frame.corner-editorial .br::after { bottom: 3px; right: 3px; }

:root[data-theme-style="terraria"] .archive-corner-frame {
  display: none;
}
@media (forced-colors: active) {
  .archive-corner-frame { display: none; }
}
</style>

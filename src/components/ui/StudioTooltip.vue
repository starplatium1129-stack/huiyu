<script setup lang="ts">
import { computed, defineComponent, onActivated, onDeactivated, onMounted, onUpdated, onBeforeUnmount, ref, watch } from "vue"
import { TooltipArrow, TooltipContent, TooltipPortal, TooltipRoot, TooltipTrigger, injectTooltipRootContext } from "reka-ui"
import { useModalPortalHost } from '@/composables/useModalPortalHost'
import FluidTransition from '@/components/visual/FluidTransition.vue'

/**
 * 原生 title 属性的替身。
 *
 * title 是纯浏览器行为，外观和交互都改不动，实测有五个问题：
 *   · 出现延迟约 1 秒，各平台还各不一样
 *   · 无法主题化：深色主题下永远是系统浅底
 *   · 只有 hover 才出现，键盘玩家拿不到这些说明（本项目大量用 title 解释参数含义）
 *   · 触屏完全不出现
 *   · 禁用控件在多数浏览器里不派发指针事件，title 连 hover 都不响应
 * 换成 Reka Tooltip：hover 与 focus 都触发、跟随双主题令牌、有碰撞检测与箭头。
 *
 * 用法（子元素必须是**单个元素**，纯文本不行）：
 *   <StudioTooltip content="采样步数：越多细节越足"><button …>…</button></StudioTooltip>
 * 控件可能被禁用时补 `anchor`：额外包一层能接住 hover 的外壳（并让其禁用子元素让出
 * 命中区域），否则禁用状态下提示依然出不来。
 *
 * App 共用 TooltipProvider，让相邻说明跳过重复延迟；空提示保留同一触发节点，
 * 仅禁用提示行为，避免动态文案改变时重新挂载真实控件。
 */
const props = withDefaults(defineProps<{
  /** 提示正文；为空时保留触发节点并禁用提示行为 */
  content?: string | null
  side?: "top" | "right" | "bottom" | "left"
  /** hover 多久后出现（毫秒）；键盘聚焦不受此延迟约束 */
  delay?: number
  /** 触发元素可能被禁用时打开：包一层可接收 hover 的外壳 */
  anchor?: boolean
}>(), { content: null, side: "top", delay: 400, anchor: false })

const descriptionId = ref<string>()
const open = ref(false)
// Close Reka itself so pending hover timers are cancelled without replacing the slot DOM.
const TooltipLifecycle = defineComponent({
  setup() {
    const context = injectTooltipRootContext()
    watch(context.open, open => { if (open) syncPortalHost(); descriptionId.value = open ? context.contentId : undefined }, { flush: 'sync' })
    watch(() => props.content, content => { if (!content) context.onClose() })
    onDeactivated(context.onClose)
    return () => null
  },
})
const anchorEl = ref<HTMLElement | null>(null)
const hasDisabledChild = ref(false)

function syncDisabled() {
  if (!props.content || !props.anchor || !anchorEl.value) {
    hasDisabledChild.value = false
    return
  }
  const child = anchorEl.value.firstElementChild as (HTMLElement & { disabled?: boolean }) | null
  hasDisabledChild.value = Boolean(
    child?.disabled ||
    child?.matches(":disabled, [aria-disabled='true']") ||
    child?.getAttribute("aria-disabled") === "true"
  )
}

function dispatchToChild(type: string, e?: PointerEvent | FocusEvent) {
  const child = anchorEl.value?.firstElementChild
  if (!child) return
  let ev: Event
  try {
    if (type.startsWith("pointer")) {
      const pe = e as PointerEvent | undefined
      ev = new PointerEvent(type, {
        bubbles: false,
        cancelable: true,
        pointerType: pe?.pointerType ?? "mouse",
        clientX: pe?.clientX ?? 0,
        clientY: pe?.clientY ?? 0,
      })
    } else if (type === "focus" || type === "blur") {
      ev = new FocusEvent(type, { bubbles: false, cancelable: true })
    } else {
      ev = new Event(type, { bubbles: false, cancelable: true })
    }
  } catch {
    ev = new Event(type, { bubbles: false, cancelable: true })
  }
  child.dispatchEvent(ev)
}

function onAnchorPointerMove(e: PointerEvent) {
  if (!props.anchor) return
  syncDisabled()
  if (e.target === anchorEl.value || hasDisabledChild.value) {
    dispatchToChild("pointermove", e)
  }
}

function onAnchorPointerLeave(e: PointerEvent) {
  if (!props.anchor) return
  dispatchToChild("pointerleave", e)
}

function onAnchorPointerDown(e: PointerEvent) {
  if (!props.anchor) return
  if (e.target === anchorEl.value || hasDisabledChild.value) {
    dispatchToChild("pointerdown", e)
  }
}

function onAnchorFocus(e: FocusEvent) {
  if (!props.anchor || !hasDisabledChild.value) return
  dispatchToChild("focus", e)
}

function onAnchorBlur(e: FocusEvent) {
  if (!props.anchor || !hasDisabledChild.value) return
  dispatchToChild("blur", e)
}

const { portalTarget, syncPortalHost } = useModalPortalHost(() => anchorEl.value)
const inDialog = computed(() => !!portalTarget.value)
let observer: MutationObserver | null = null

function setupObserver() {
  observer?.disconnect()
  observer = null
  if (props.anchor && anchorEl.value && typeof MutationObserver !== "undefined") {
    observer = new MutationObserver(() => syncDisabled())
    observer.observe(anchorEl.value, {
      attributes: true,
      attributeFilter: ["disabled", "aria-disabled"],
      subtree: true,
      childList: true,
    })
  }
}

onActivated(() => { syncDisabled(); setupObserver() })
onDeactivated(() => { observer?.disconnect(); observer = null })
onMounted(() => {
  syncDisabled()
  setupObserver()
})
onUpdated(() => {
  syncDisabled()
})
onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
})
watch(() => props.anchor, () => {
  syncDisabled()
  setupObserver()
})
</script>

<template>
  <span
    ref="anchorEl"
    class="studio-tooltip-anchor"
    :data-anchor="anchor && content ? '' : undefined"
    :tabindex="anchor && hasDisabledChild ? 0 : undefined"
    :aria-disabled="anchor && hasDisabledChild ? 'true' : undefined"
    :aria-describedby="anchor && hasDisabledChild ? descriptionId : undefined"
    @pointermove="onAnchorPointerMove"
    @pointerleave="onAnchorPointerLeave"
    @pointerdown="onAnchorPointerDown"
    @focus="onAnchorFocus"
    @blur="onAnchorBlur"
  >
    <TooltipRoot v-model:open="open" :disabled="!content" :delay-duration="delay">
      <TooltipLifecycle />
      <TooltipTrigger as-child><slot /></TooltipTrigger>
      <TooltipPortal v-if="content" :to="portalTarget">
        <FluidTransition small panel=".studio-tooltip">
        <TooltipContent
          v-if="open" force-mount
          :data-fluid-glass="inDialog ? undefined : ''"
          :side="side"
          :side-offset="6"
          :collision-padding="12"
          class="studio-tooltip"
          :data-in-dialog="inDialog ? '' : undefined"
        >
          {{ content }}
          <TooltipArrow class="studio-tooltip-arrow" :width="10" :height="5" />
        </TooltipContent>
        </FluidTransition>
      </TooltipPortal>
    </TooltipRoot>
  </span>
</template>

<!-- Reka portals cross component roots; keep these uniquely prefixed rules global. -->
<style>
@reference "../../assets/css/tailwind.css";
.studio-tooltip-anchor { @apply tw:contents; }
.studio-tooltip { @apply tw:[z-index:var(--z-popover)] tw:[max-width:min(320px,_calc(100vw_-_24px))] tw:py-s-2 tw:px-s-3 tw:border tw:border-solid tw:border-soft tw:rounded-md tw:bg-elevated tw:text-primary tw:text-label-sm tw:leading-body tw:shadow-(--shadow-md); }
.studio-tooltip-arrow { @apply tw:[fill:var(--bg-elevated)]; }
/* 默认 display:contents —— 外壳不产生盒子，DOM 结构与布局对调用方完全透明。
   只有 anchor 模式才真的生成一个能接住指针的盒子。 */
.studio-tooltip-anchor[data-anchor] {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  max-width: 100%;
}
/* 禁用控件不派发指针事件，命中区域要交给外壳；子元素因此让出 hover。 */
.studio-tooltip-anchor[data-anchor] > :disabled { pointer-events: none; }

.studio-tooltip {
  --surface-enter-y:3px;
  --surface-enter-scale:.98;
  transform-origin: var(--reka-tooltip-content-transform-origin, center);
}
/* Enter and leave share an interruptible surface; Reka releases semantics immediately. */
:root:is([data-motion='reduce'], [data-motion='reduced'], [data-reduced-motion='true']) .studio-tooltip[data-state] { animation:none; transition: none; }
/* 渲染进 dialog 时要盖过弹窗内部最高层（--z-overlay 是弹窗层） */
.studio-tooltip[data-in-dialog] { z-index: calc(var(--z-overlay) + 1); }
@media (prefers-reduced-motion: reduce) { :root:not([data-motion='full']) .studio-tooltip[data-state] { animation: none; transition: none; } }
@media (forced-colors: active) { .studio-tooltip { background: Canvas; border-color: CanvasText; } .studio-tooltip-arrow { fill: Canvas; } }
</style>

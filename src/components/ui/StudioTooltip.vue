<script setup lang="ts">
import { nextTick, onMounted, onUpdated, onBeforeUnmount, ref, watch } from "vue"
import { TooltipArrow, TooltipContent, TooltipPortal, TooltipProvider, TooltipRoot, TooltipTrigger } from "reka-ui"

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
 * 每个实例自带 TooltipProvider：Reka 的 TooltipRoot 强制要求 provider 祖先，缺了会直接
 * 抛 `Injection "Symbol(TooltipProviderContext)" not found`。放在组件内，调用方就不需要
 * 记得在 App 层挂 provider，组件在单测里也能独立跑。代价是跨提示的 skip-delay 合并
 * 用不上（换到另一个控件要重新等 delay）——这个延迟很短，换来的是没有隐式全局依赖。
 */
const props = withDefaults(defineProps<{
  /** 提示正文；为空时组件退化为只渲染子元素，不做任何包装 */
  content?: string | null
  side?: "top" | "right" | "bottom" | "left"
  /** hover 多久后出现（毫秒）；键盘聚焦不受此延迟约束 */
  delay?: number
  /** 触发元素可能被禁用时打开：包一层可接收 hover 的外壳 */
  anchor?: boolean
}>(), { content: null, side: "top", delay: 400, anchor: false })

const anchorEl = ref<HTMLElement | null>(null)
const hasDisabledChild = ref(false)

function syncDisabled() {
  if (!props.anchor || !anchorEl.value) {
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

/**
 * 原生 <dialog> 用 showModal 打开后在顶层渲染，body 其余部分对它都是下方内容：
 * portal 到 body 的提示会被整个 dialog 盖住（StudioSelect 的弹层同理，那里是
 * 被 inert 拦住点击）。所以存在祖先 dialog 时把提示渲染进 dialog 里。
 */
const portalTarget = ref<HTMLElement | undefined>(undefined)
const inDialog = ref(false)
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

onMounted(() => {
  syncDisabled()
  const dialog = anchorEl.value?.closest("dialog")
  if (dialog) { portalTarget.value = dialog; inDialog.value = true }
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
    :data-anchor="anchor ? '' : undefined"
    :tabindex="anchor && hasDisabledChild ? 0 : undefined"
    :aria-disabled="anchor && hasDisabledChild ? 'true' : undefined"
    @pointermove="onAnchorPointerMove"
    @pointerleave="onAnchorPointerLeave"
    @pointerdown="onAnchorPointerDown"
    @focus="onAnchorFocus"
    @blur="onAnchorBlur"
  >
    <TooltipProvider v-if="content" :delay-duration="delay">
      <TooltipRoot>
        <TooltipTrigger as-child><slot /></TooltipTrigger>
        <TooltipPortal :to="portalTarget">
          <TooltipContent
            :side="side"
            :side-offset="6"
            :collision-padding="12"
            class="studio-tooltip"
            :data-in-dialog="inDialog ? '' : undefined"
          >
            {{ content }}
            <TooltipArrow class="studio-tooltip-arrow" :width="10" :height="5" />
          </TooltipContent>
        </TooltipPortal>
      </TooltipRoot>
    </TooltipProvider>
    <slot v-else />
  </span>
</template>

<!-- Reka portals cross component roots; keep these uniquely prefixed rules global. -->
<style>
/* 默认 display:contents —— 外壳不产生盒子，DOM 结构与布局对调用方完全透明。
   只有 anchor 模式才真的生成一个能接住指针的盒子。 */
.studio-tooltip-anchor { display: contents; }
.studio-tooltip-anchor[data-anchor] {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  max-width: 100%;
}
/* 禁用控件不派发指针事件，命中区域要交给外壳；子元素因此让出 hover。 */
.studio-tooltip-anchor[data-anchor] > :disabled { pointer-events: none; }

.studio-tooltip {
  z-index: var(--z-popover);
  max-width: min(320px, calc(100vw - 24px));
  padding: var(--s-2) var(--s-3);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-md);
  background: var(--bg-elevated);
  color: var(--text-primary);
  font-size: var(--fs-label-sm);
  line-height: var(--lh-body);
  box-shadow: var(--shadow-md);
  transform-origin: var(--reka-tooltip-content-transform-origin, center);
}
.studio-tooltip[data-state='open'] { animation:studio-tooltip-in var(--motion-control) var(--ease-out) both; }
.studio-tooltip[data-state='closed'] { animation:studio-tooltip-out var(--motion-hover) var(--ease-out) both; }
@keyframes studio-tooltip-in { from { opacity:0; transform:translateY(-2px) scale(.98); } to { opacity:1; transform:none; } }
@keyframes studio-tooltip-out { from { opacity:1; transform:none; } to { opacity:0; transform:translateY(-1px) scale(.99); } }
/* 渲染进 dialog 时要盖过弹窗内部最高层（--z-overlay 是弹窗层） */
.studio-tooltip[data-in-dialog] { z-index: calc(var(--z-overlay) + 1); }
.studio-tooltip-arrow { fill: var(--bg-elevated); }
@media (prefers-reduced-motion: reduce) { .studio-tooltip[data-state] { animation: none; } }
@media (forced-colors: active) { .studio-tooltip { background: Canvas; border-color: CanvasText; } .studio-tooltip-arrow { fill: Canvas; } }
</style>

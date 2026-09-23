<script setup lang="ts">
import { computed, onMounted, ref, useAttrs } from 'vue'
import {
  SelectRoot,
  SelectTrigger,
  SelectValue,
  SelectPortal,
  SelectContent,
  SelectViewport,
  SelectGroup,
  SelectLabel,
  SelectItem,
  SelectItemText,
  SelectItemIndicator,
} from 'reka-ui'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'

/**
 * 选项值允许字符串或数字：调用方既有角色/场景 id，也有 1.5× 这类倍率与页码。
 * 组件按选项原始类型回写，数字不会被转成字符串。
 * value 为空串表示「全部 / 自动 / 无」这类真实可选项，不是「未选择」。
 */
export interface StudioSelectOption {
  value: string | number
  label: string
  disabled?: boolean
}

/** 对应原生 optgroup：画幅比例按竖/方/横/官方 CG 分组。 */
export interface StudioSelectGroup {
  label: string
  options: readonly StudioSelectOption[]
}

// 组件不渲染任何原生 <select>：仓库 e2e 明确要求外观对话框、桌宠设置等容器内
// 原生控件数量为 0（apple-hig-accessibility / companion-focus），因此 id 直接落在
// 可见 trigger 上，原生外观全部由 Reka + 本组件的样式接管。
defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  /** 平铺选项，与 groups 二选一 */
  options?: readonly StudioSelectOption[]
  /** 分组选项，对应原生 optgroup */
  groups?: readonly StudioSelectGroup[]
  /** 下拉的可访问名称；外层若已有 <label> 包裹可省，但仍建议传入以便读屏直接报出用途 */
  label?: string
  placeholder?: string
  disabled?: boolean
  id?: string
  /** sm 用于绘制区、分镜卡等紧凑行；md 为表单默认尺寸 */
  size?: 'sm' | 'md'
  /** 行内场景（如「第 N / M 页」）不撑满父级宽度 */
  inline?: boolean
}>(), {
  label: '',
  placeholder: '请选择',
  disabled: false,
  size: 'md',
  inline: false,
})

const modelValue = defineModel<string | number>({ default: '' })

// Reka 的条目值必须是非空字符串，而空串在原生 select 里是「全部分类」这类真实选项，
// 因此统一映射成一个内部哨兵键，回写时再还原成调用方原本的空串或数字类型。
const EMPTY_KEY = '__studio-select-empty__'
const keyOf = (value: string | number | null | undefined): string =>
  value === '' || value === null || value === undefined ? EMPTY_KEY : String(value)

const flatOptions = computed<readonly StudioSelectOption[]>(() =>
  props.groups ? props.groups.flatMap(group => group.options) : (props.options ?? []))
const optionByKey = computed(() => new Map(flatOptions.value.map(option => [keyOf(option.value), option])))
const currentKey = computed(() => keyOf(modelValue.value))

// 由组件自己算显示文案，不依赖 Reka 从已挂载条目里取 textContent：
// 弹层按需挂载，首次展开前它的条目集合是空的。
const selectedLabel = computed(() => optionByKey.value.get(currentKey.value)?.label ?? '')

function applyKey(key: string) {
  const option = optionByKey.value.get(key)
  if (option) modelValue.value = option.value
  else modelValue.value = key === EMPTY_KEY ? '' : key
}

const attrs = useAttrs()
// class 落在外层包裹上，便于页面按上下文控制宽度与布局；其余属性（title、data-*、
// aria-*）连同 id 一起加到可见 trigger。样式一律走 class —— 仓库禁止内联 style
// （test-style-debt 的内联样式预算只允许承载自定义属性），所以 style 不透传。
const wrapperClass = computed(() => [attrs.class, props.inline ? 'studio-select-inline' : undefined])
const accessibleName = computed(() => props.label || (attrs['aria-label'] as string | undefined) || undefined)
const triggerAttrs = computed(() => {
  const { class: _class, style: _style, id: _id, 'aria-label': _ariaLabel, ...rest } = attrs
  return rest
})

/**
 * 原生 <dialog> 用 showModal() 打开后进入顶层模态，body 的其余部分对指针与读屏都是
 * inert：默认 portal 到 body 的弹层会落在 dialog 之外，看着在屏幕上却点不动
 * （ModelStudio 这类把下拉放在 <dialog> 里的宿主就是这么坏的）。
 * 所以存在祖先 dialog 时，弹层跟着它渲染；否则保持 portal 到 body。
 * DESIGN.md 的「portalled content inside legacy trapped dialogs needs an explicit
 * integration check」说的就是这件事。
 */
const wrapperEl = ref<HTMLElement | null>(null)
const portalTarget = ref<HTMLElement | undefined>(undefined)
onMounted(() => {
  const dialog = wrapperEl.value?.closest('dialog')
  if (dialog) portalTarget.value = dialog
})
</script>

<template>
  <div ref="wrapperEl" class="studio-select-wrapper" :class="wrapperClass" :data-size="size">
    <SelectRoot :model-value="currentKey" :disabled="disabled" @update:model-value="applyKey">
      <SelectTrigger
        v-bind="triggerAttrs"
        :id="id"
        class="studio-select-trigger"
        :aria-label="accessibleName"
        :data-empty="selectedLabel ? undefined : ''"
        :data-value="String(modelValue ?? '')"
      >
        <SelectValue class="studio-select-value" :placeholder="placeholder">{{ selectedLabel || placeholder }}</SelectValue>
        <ArchiveIcon name="chevron-down" class="studio-select-icon" aria-hidden="true" />
      </SelectTrigger>

      <SelectPortal :to="portalTarget">
        <SelectContent position="popper" align="start" :side-offset="6" :collision-padding="12" class="studio-select-content">
          <SelectViewport class="studio-select-viewport">
            <template v-if="groups">
              <SelectGroup v-for="group in groups" :key="group.label" class="studio-select-group">
                <SelectLabel class="studio-select-group-label">{{ group.label }}</SelectLabel>
                <SelectItem
                  v-for="option in group.options"
                  :key="keyOf(option.value)"
                  :value="keyOf(option.value)"
                  :disabled="option.disabled"
                  class="studio-select-item"
                >
                  <!-- data-value 与原生 option 的 value 语义一致，e2e 按值选择靠它定位。
                       SelectItem 外面还包着 CollectionItem，属性透传不保证，所以挂在
                       SelectItemText 上（该组件显式透传 $attrs）。 -->
                  <SelectItemText :data-value="String(option.value)">{{ option.label }}</SelectItemText>
                  <SelectItemIndicator class="studio-select-check">
                    <ArchiveIcon name="success" />
                  </SelectItemIndicator>
                </SelectItem>
              </SelectGroup>
            </template>
            <template v-else>
              <SelectItem
                v-for="option in options"
                :key="keyOf(option.value)"
                :value="keyOf(option.value)"
                :disabled="option.disabled"
                class="studio-select-item"
              >
                <SelectItemText :data-value="String(option.value)">{{ option.label }}</SelectItemText>
                <SelectItemIndicator class="studio-select-check">
                  <ArchiveIcon name="success" />
                </SelectItemIndicator>
              </SelectItem>
            </template>
          </SelectViewport>
        </SelectContent>
      </SelectPortal>
    </SelectRoot>
  </div>
</template>

<!-- Reka portals cross component roots; keep these uniquely prefixed rules global. -->
<style>
.studio-select-wrapper {
  position: relative;
  display: inline-flex;
  width: 100%;
  min-width: 0;
}
.studio-select-wrapper.studio-select-inline { width: auto; }

.studio-select-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-2);
  width: 100%;
  min-width: 0;
  min-height: 40px;
  padding: var(--s-2) var(--s-3);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-md);
  background-color: var(--bg-deep);
  color: var(--text-primary);
  font: 500 var(--fs-body-sm) var(--font-sans);
  text-align: start;
  cursor: pointer;
  outline: none;
  transition: border-color var(--motion-hover) var(--ease-out), background-color var(--motion-hover) var(--ease-out);
}
.studio-select-wrapper[data-size='sm'] .studio-select-trigger {
  gap: var(--s-1);
  min-height: 32px;
  padding: var(--s-1) var(--s-2);
  font-size: var(--fs-label-sm);
}
.studio-select-trigger:hover:not(:disabled) {
  border-color: var(--accent);
  background-color: var(--bg-surface);
}
.studio-select-trigger:focus-visible {
  border-color: var(--accent);
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.studio-select-trigger[data-disabled] {
  color: var(--text-disabled);
  cursor: not-allowed;
}
.studio-select-value {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.studio-select-trigger[data-empty] .studio-select-value { color: var(--text-muted); }
.studio-select-icon {
  width: 15px;
  height: 15px;
  flex-shrink: 0;
  color: var(--text-muted);
  transition: transform var(--motion-hover) var(--ease-out);
}
.studio-select-trigger[data-state='open'] .studio-select-icon { transform: rotate(180deg); }

.studio-select-content {
  z-index: var(--z-popover);
  width: var(--reka-select-trigger-width, max-content);
  min-width: 140px;
  max-width: calc(100vw - 24px);
  max-height: var(--reka-select-content-available-height, 320px);
  overflow: hidden;
  padding: var(--s-1);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-xl);
  background: var(--bg-surface);
  backdrop-filter: blur(20px);
  box-shadow: var(--shadow-lg);
  color: var(--text-primary);
}
.studio-select-viewport {
  max-height: min(280px, calc(var(--reka-select-content-available-height, 320px) - 16px));
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}
.studio-select-group + .studio-select-group {
  margin-top: var(--s-1);
  padding-top: var(--s-1);
  border-top: 1px solid var(--border-soft);
}
.studio-select-group-label {
  padding: var(--s-1) var(--s-3);
  color: var(--text-muted);
  font: 600 var(--fs-label-sm) var(--font-sans);
}
.studio-select-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-2);
  min-height: 36px;
  padding: var(--s-2) var(--s-3);
  border-radius: var(--r-md);
  font: 500 var(--fs-label) var(--font-sans);
  cursor: pointer;
  outline: none;
  user-select: none;
}
.studio-select-item:is(:hover, [data-highlighted]) {
  background: var(--bg-hover);
}
.studio-select-item[data-state='checked'] {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}
.studio-select-item[data-disabled] {
  color: var(--text-disabled);
  cursor: not-allowed;
}
.studio-select-check {
  display: inline-flex;
  align-items: center;
  color: var(--accent);
}
.studio-select-check .archive-icon {
  width: 14px;
  height: 14px;
}
@media (max-width: 600px) {
  .studio-select-trigger { min-height: 44px; }
  .studio-select-wrapper[data-size='sm'] .studio-select-trigger { min-height: 44px; }
  .studio-select-item { min-height: 44px; }
}
@media (prefers-reduced-motion: reduce) {
  .studio-select-icon { transition: none; }
}
@media (forced-colors: active) {
  .studio-select-content { background: Canvas; border-color: CanvasText; }
  .studio-select-item[data-state='checked'] { outline: 1px solid Highlight; }
}
</style>

<script setup lang="ts">
import { computed, onActivated, onDeactivated, ref, useAttrs, watch } from 'vue'
import { useModalPortalHost } from '@/composables/useModalPortalHost'
import { usePageScrollLock } from '@/composables/usePageScrollLock'
import StudioToggleIcon from '@/components/ui/StudioToggleIcon.vue'
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
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import FluidTransition from '@/components/visual/FluidTransition.vue'

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

// 可见 trigger 承载 id 与可访问名称；外观及键鼠语义由 Reka 和共享样式接管。
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
  /** 提示文案，使用 StudioTooltip 接管；悬停与键盘聚焦均触发，不再渲染原生 title */
  hint?: string | null
}>(), {
  label: '',
  placeholder: '请选择',
  disabled: false,
  size: 'md',
  inline: false,
  hint: null,
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
  if (props.disabled) return
  const option = optionByKey.value.get(key)
  if (option?.disabled) return
  if (option) modelValue.value = option.value
  else modelValue.value = key === EMPTY_KEY ? '' : key
}

const attrs = useAttrs()
const open = ref(false)
usePageScrollLock(() => open.value)
const pointerOpened = ref(false)
let viewActive = true
onActivated(() => { viewActive = true })
onDeactivated(() => {
  viewActive = false
  open.value = false
})
// Closing a cached page must release the portal without focusing its hidden trigger.
function onCloseAutoFocus(event: Event) {
  if (!viewActive || open.value) event.preventDefault()
}
function onEscape(event: KeyboardEvent) {
  if (!open.value || event.defaultPrevented || event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  open.value = false
}
function onDismissEscape(event: KeyboardEvent) {
  // Reka also handles Escape at window level, after the trigger/content handler.
  if (event.isComposing || event.keyCode === 229) event.preventDefault()
}
// class 落在外层包裹上，便于页面按上下文控制宽度与布局；其余属性（data-*、
// aria-*）连同 id 一起加到可见 trigger。布局与外观由共享 class 负责，style 不透传。
// title 转为 hint 由 StudioTooltip 接管，不再透传给原生 trigger 产生原生提示。
const wrapperClass = computed(() => [attrs.class, props.inline ? 'studio-select-inline' : undefined])
const accessibleName = computed(() => props.label || (attrs['aria-label'] as string | undefined) || undefined)
const effectiveHint = computed(() => props.hint ?? (attrs.title as string | undefined) ?? null)
const triggerAttrs = computed(() => {
  const { class: _class, style: _style, id: _id, 'aria-label': _ariaLabel, title: _title, ...rest } = attrs
  return rest
})

const wrapperEl = ref<HTMLElement | null>(null)
// Tooltip provides a separate Popper context; select positioning uses its own trigger.
const selectTrigger = ref<{ $el: HTMLElement } | null>(null)
const { portalTarget, collisionBoundary } = useModalPortalHost(() => wrapperEl.value, open)
watch(() => props.disabled, value => { if (value) open.value = false }, { flush: 'sync' })
</script>

<template>
  <div ref="wrapperEl" class="studio-select-wrapper" :class="wrapperClass" :data-size="size">
    <SelectRoot v-model:open="open" :model-value="currentKey" :disabled="disabled" @update:model-value="applyKey">
      <StudioTooltip :content="effectiveHint" :anchor="disabled">
        <SelectTrigger
          ref="selectTrigger"
          v-bind="triggerAttrs"
          :id="id"
          class="studio-select-trigger"
          :aria-label="accessibleName"
          :data-empty="selectedLabel ? undefined : ''"
          :data-value="String(modelValue ?? '')"
          @pointerdown="pointerOpened = true"
          @keydown="pointerOpened = false"
          @keydown.esc="onEscape"
        >
          <SelectValue class="studio-select-value" :placeholder="placeholder">{{ selectedLabel || placeholder }}</SelectValue>
          <StudioToggleIcon :active="open" class="studio-select-icon" />
        </SelectTrigger>
      </StudioTooltip>

      <SelectPortal :to="portalTarget">
        <FluidTransition small panel=".studio-select-content">
        <SelectContent v-if="open" force-mount :body-lock="false" data-fluid-glass position="popper" :reference="selectTrigger?.$el" align="start" :side-offset="6" :collision-padding="12" :collision-boundary="collisionBoundary" class="studio-select-content" :data-pointer-open="pointerOpened" @keydown.capture="pointerOpened = false" @keydown.esc="onEscape" @escape-key-down="onDismissEscape" @close-auto-focus="onCloseAutoFocus">
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
                  <SelectItemText class="studio-select-item-text" :data-value="String(option.value)">{{ option.label }}</SelectItemText>
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
                <SelectItemText class="studio-select-item-text" :data-value="String(option.value)">{{ option.label }}</SelectItemText>
                <SelectItemIndicator class="studio-select-check">
                  <ArchiveIcon name="success" />
                </SelectItemIndicator>
              </SelectItem>
            </template>
          </SelectViewport>
        </SelectContent>
        </FluidTransition>
      </SelectPortal>
    </SelectRoot>
  </div>
</template>

<!-- Reka portals cross component roots; keep these uniquely prefixed rules global. -->
<style src="@/assets/css/components/ui/StudioSelect-0.css"></style>

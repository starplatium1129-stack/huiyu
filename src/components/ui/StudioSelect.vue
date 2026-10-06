<script setup lang="ts">
import { computed, onActivated, onDeactivated, onMounted, ref, useAttrs } from 'vue'
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
  const option = optionByKey.value.get(key)
  if (option) modelValue.value = option.value
  else modelValue.value = key === EMPTY_KEY ? '' : key
}

const attrs = useAttrs()
const open = ref(false)
const pointerOpened = ref(false)
let viewActive = true
onActivated(() => { viewActive = true })
onDeactivated(() => {
  viewActive = false
  open.value = false
})
// Closing a cached page must release the portal without focusing its hidden trigger.
function onCloseAutoFocus(event: Event) {
  if (!viewActive) event.preventDefault()
}
function onEscape(event: KeyboardEvent) {
  if (!open.value || event.defaultPrevented || event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  open.value = false
}
// class 落在外层包裹上，便于页面按上下文控制宽度与布局；其余属性（data-*、
// aria-*）连同 id 一起加到可见 trigger。样式一律走 class —— 仓库禁止内联 style
// （test-style-debt 的内联样式预算只允许承载自定义属性），所以 style 不透传。
// title 转为 hint 由 StudioTooltip 接管，不再透传给原生 trigger 产生原生提示。
const wrapperClass = computed(() => [attrs.class, props.inline ? 'studio-select-inline' : undefined])
const accessibleName = computed(() => props.label || (attrs['aria-label'] as string | undefined) || undefined)
const effectiveHint = computed(() => props.hint ?? (attrs.title as string | undefined) ?? null)
const triggerAttrs = computed(() => {
  const { class: _class, style: _style, id: _id, 'aria-label': _ariaLabel, title: _title, ...rest } = attrs
  return rest
})

/**
 * 原生 <dialog> 用 showModal() 打开后进入顶层模态，body 的其余部分对指针与读屏都是
 * inert：默认 portal 到 body 的弹层会落在 dialog 之外，看着在屏幕上却点不动
 * （ModelStudio 这类把下拉放在 <dialog> 里的宿主就是这么坏的）。
 * 自定义模态的 useFocusTrap 同样只接受容器内的焦点。弹层留在所属模态内；
 * 自定义面板可能在入场时带 transform/overflow，碰撞边界也应使用该面板。
 * DESIGN.md 的「portalled content inside legacy trapped dialogs needs an explicit
 * integration check」说的就是这件事。
 */
const wrapperEl = ref<HTMLElement | null>(null)
const portalTarget = ref<HTMLElement | undefined>(undefined)
const collisionBoundary = computed(() => portalTarget.value?.tagName === 'DIALOG' ? undefined : portalTarget.value)
onMounted(() => {
  portalTarget.value = wrapperEl.value?.closest<HTMLElement>('dialog, [role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]') ?? undefined
})
</script>

<template>
  <div ref="wrapperEl" class="studio-select-wrapper" :class="wrapperClass" :data-size="size">
    <SelectRoot v-model:open="open" :model-value="currentKey" :disabled="disabled" @update:model-value="applyKey">
      <StudioTooltip :content="effectiveHint" :anchor="disabled">
        <SelectTrigger
          data-fluid-glass
          v-bind="triggerAttrs"
          :id="id"
          class="studio-select-trigger"
          :aria-label="accessibleName"
          :data-empty="selectedLabel ? undefined : ''"
          :data-value="String(modelValue ?? '')"
          :data-pointer-open="pointerOpened"
          @pointerdown="pointerOpened = true"
          @keydown="pointerOpened = false"
          @keydown.esc="onEscape"
        >
          <SelectValue class="studio-select-value" :placeholder="placeholder">{{ selectedLabel || placeholder }}</SelectValue>
          <ArchiveIcon name="chevron-down" class="studio-select-icon" aria-hidden="true" />
        </SelectTrigger>
      </StudioTooltip>

      <SelectPortal :to="portalTarget">
        <SelectContent data-fluid-glass position="popper" align="start" :side-offset="6" :collision-padding="12" :collision-boundary="collisionBoundary" class="studio-select-content" :data-pointer-open="pointerOpened" @keydown.capture="pointerOpened = false" @keydown.esc="onEscape" @close-auto-focus="onCloseAutoFocus">
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
      </SelectPortal>
    </SelectRoot>
  </div>
</template>

<!-- Reka portals cross component roots; keep these uniquely prefixed rules global. -->
<style src="@/assets/css/components/ui/StudioSelect-0.css"></style>

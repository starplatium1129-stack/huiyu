<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, useId } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { listCompanionUiCharacters } from '@/utils/companionRegistry'

const props = withDefaults(defineProps<{ modelValue: string; label?: string }>(), { label: '切换角色' })
const emit = defineEmits<{ 'update:modelValue': [id: string] }>()
const characters = listCompanionUiCharacters()
const currentCharacter = computed(() => characters.find(character => character.id === props.modelValue) || characters[0])
const pickerEl = ref<HTMLElement | null>(null)
const triggerEl = ref<HTMLButtonElement | null>(null)
const open = ref(false)
const activeIndex = ref(0)
const listboxId = `companion-picker-${useId()}`
const activeOptionId = computed(() => open.value ? `${listboxId}-${characters[activeIndex.value]?.id || ''}` : undefined)

function showPicker(index = characters.findIndex(character => character.id === props.modelValue)) {
  if (!characters.length) return
  open.value = true
  activeIndex.value = (index + characters.length) % characters.length
}

function closePicker() {
  open.value = false
}

function togglePicker() {
  if (open.value) closePicker()
  else showPicker()
}

function selectCharacter(id: string) {
  closePicker()
  if (id !== props.modelValue) emit('update:modelValue', id)
  if (triggerEl.value?.offsetParent) triggerEl.value.focus()
}

function onTriggerKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const index = open.value ? activeIndex.value : characters.findIndex(character => character.id === props.modelValue)
    showPicker(index + (event.key === 'ArrowDown' ? 1 : -1))
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    if (open.value) selectCharacter(characters[activeIndex.value]?.id || props.modelValue)
    else showPicker()
  } else if (open.value && (event.key === 'Home' || event.key === 'End')) {
    event.preventDefault()
    activeIndex.value = event.key === 'Home' ? 0 : characters.length - 1
  } else if (event.key === 'Escape' && open.value) {
    event.preventDefault()
    closePicker()
  } else if (event.key === 'Tab') {
    closePicker()
  }
}

function onDocumentPointerDown(event: PointerEvent) {
  if (open.value && !pickerEl.value?.contains(event.target as Node)) closePicker()
}

function onViewportWheel(event: WheelEvent) {
  const el = event.currentTarget as HTMLElement | null
  if (!el) return
  el.scrollTop += event.deltaY
}

onMounted(() => document.addEventListener('pointerdown', onDocumentPointerDown, true))
onUnmounted(() => document.removeEventListener('pointerdown', onDocumentPointerDown, true))
</script>

<template>
  <div ref="pickerEl" class="companion-picker" :data-character="modelValue">
    <button
      ref="triggerEl"
      type="button"
      role="combobox"
      aria-haspopup="listbox"
      class="companion-picker-trigger"
      :aria-label="label"
      :aria-controls="listboxId"
      :aria-expanded="open"
      :aria-activedescendant="activeOptionId"
      :data-state="open ? 'open' : 'closed'"
      :data-value="modelValue"
      @click="togglePicker"
      @keydown="onTriggerKeydown"
    >
      <span class="companion-picker-mark" aria-hidden="true"><i></i></span>
      <span class="companion-picker-copy">
        <strong>{{ currentCharacter?.name || '选择角色' }}</strong>
        <small>当前陪伴</small>
      </span>
      <ArchiveIcon name="chevron-down" class="companion-picker-chevron" aria-hidden="true" />
    </button>

    <Transition name="companion-picker-menu">
      <div
        v-if="open"
        :id="listboxId"
        role="listbox"
        class="companion-picker-content"
        :aria-label="label"
        @pointerdown.stop
      >
        <div class="companion-picker-heading" aria-hidden="true">
          <span><ArchiveIcon name="character" />陪伴角色</span>
          <small>{{ characters.length }} 位可选</small>
        </div>
        <div class="companion-picker-viewport" @pointerdown.stop @wheel.passive="onViewportWheel">
          <button
            v-for="(character, index) in characters"
            :key="character.id"
            :id="`${listboxId}-${character.id}`"
            type="button"
            role="option"
            class="companion-picker-option"
            :class="{ 'is-active': index === activeIndex }"
            :aria-selected="character.id === modelValue"
            :data-value="character.id"
            tabindex="-1"
            @pointerenter="activeIndex = index"
            @click="selectCharacter(character.id)"
          >
            <span class="companion-picker-option-mark" aria-hidden="true"><i></i></span>
            <span class="companion-picker-option-copy">
              <strong>{{ character.name }}</strong>
              <small>{{ character.id === modelValue ? '正在陪伴' : `切换到${character.shortName}` }}</small>
            </span>
            <span v-if="character.id === modelValue" class="companion-picker-check" aria-hidden="true">
              <ArchiveIcon name="success" />
            </span>
          </button>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style>
@reference "../assets/css/tailwind.css";
.companion-picker {
  --companion-option-accent: var(--character-accent);
  @apply tw:relative tw:w-full tw:min-w-0 tw:max-w-[220px];
}
.companion-picker[data-character='nene'],
.companion-picker-option[data-value='nene'] { --companion-option-accent: var(--nene-violet); }
.companion-picker[data-character='natsume'],
.companion-picker-option[data-value='natsume'] { --companion-option-accent: var(--natsume-amber); }

.companion-picker-trigger {
  @apply tw:flex tw:items-center tw:gap-s-2 tw:w-full tw:min-w-0 tw:min-h-[40px];
  padding: 4px 9px 4px 7px;
  border: 1px solid var(--border-soft);
  @apply tw:rounded-pill;
  background: color-mix(in srgb, var(--bg-surface) 92%, var(--companion-option-accent) 8%);
  @apply tw:text-primary;
  box-shadow: inset 0 1px 0 var(--glass-highlight);
  @apply tw:cursor-pointer tw:text-left;
  transition: border-color var(--motion-hover), background-color var(--motion-hover), box-shadow var(--motion-hover);
}
.companion-picker-trigger:hover,
.companion-picker-trigger[data-state='open'] {
  border-color: color-mix(in srgb, var(--companion-option-accent) 58%, var(--border-soft));
  background: color-mix(in srgb, var(--bg-elevated) 88%, var(--companion-option-accent) 12%);
}
.companion-picker-trigger:focus-visible {
  outline: 2px solid var(--companion-option-accent);
  outline-offset: 2px;
}

.companion-picker-mark,
.companion-picker-option-mark {
  @apply tw:grid;
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--companion-option-accent) 45%, var(--border-soft));
  border-radius: 50%;
  background: color-mix(in srgb, var(--companion-option-accent) 12%, var(--bg-surface));
}
.companion-picker-mark { @apply tw:w-[27px] tw:h-[27px]; }
.companion-picker-option-mark { @apply tw:w-[34px] tw:h-[34px]; }
.companion-picker-mark i,
.companion-picker-option-mark i {
  @apply tw:w-[8px] tw:h-[8px];
  border-radius: 50%;
  background: var(--companion-option-accent);
  box-shadow: 0 0 9px color-mix(in srgb, var(--companion-option-accent) 48%, transparent);
}
.companion-picker-option-mark i { @apply tw:w-[10px] tw:h-[10px]; }

.companion-picker-copy,
.companion-picker-option-copy {
  @apply tw:flex tw:min-w-0;
  flex: 1;
  @apply tw:flex-col;
}
.companion-picker-copy strong,
.companion-picker-option-copy strong {
  @apply tw:overflow-hidden tw:text-primary;
  font: 600 var(--fs-label)/var(--lh-tight) var(--font-sans);
  @apply tw:text-ellipsis tw:whitespace-nowrap;
}
.companion-picker-copy small,
.companion-picker-option-copy small {
  @apply tw:overflow-hidden tw:text-secondary;
  font: 500 var(--fs-label-xs)/var(--lh-tight) var(--font-sans);
  @apply tw:text-ellipsis tw:whitespace-nowrap;
}

.companion-picker-chevron {
  flex: 0 0 auto;
  @apply tw:w-[15px] tw:h-[15px] tw:text-secondary;
  transition: transform var(--motion-hover) var(--ease-out);
}
.companion-picker-trigger[data-state='open'] .companion-picker-chevron { transform: rotate(180deg); }

.companion-picker-content {
  -webkit-app-region: no-drag;
  @apply tw:absolute;
  z-index: var(--z-popover);
  top: calc(100% + 8px);
  @apply tw:right-0;
  width: min(260px, calc(100vw - 16px));
  max-height: min(360px, calc(100dvh - 80px));
  @apply tw:overflow-hidden tw:p-s-2;
  border: 1px solid var(--border-soft);
  @apply tw:rounded-xl;
  background: var(--bg-elevated);
  @apply tw:text-primary;
  box-shadow: var(--shadow-glass-elevated);
}
html.companion-desktop .companion-picker-content { @apply tw:right-auto tw:left-0; -webkit-app-region: no-drag; }
.companion-picker-menu-enter-active,
.companion-picker-menu-leave-active { transition: opacity var(--motion-hover), transform var(--motion-hover) var(--ease-out); }
.companion-picker-menu-enter-from,
.companion-picker-menu-leave-to { opacity: 0; transform: translateY(-4px) scale(.98); }

.companion-picker-heading {
  @apply tw:flex tw:items-center tw:justify-between tw:gap-s-3 tw:mb-s-1;
  padding: var(--s-2) var(--s-2) var(--s-3);
  border-bottom: 1px solid var(--border-soft);
}
.companion-picker-heading > span { @apply tw:inline-flex tw:items-center tw:gap-s-2; font: 650 var(--fs-label-sm) var(--font-sans); }
.companion-picker-heading .archive-icon { @apply tw:w-[16px] tw:h-[16px]; color: var(--character-accent); }
.companion-picker-heading small { @apply tw:text-secondary; font: 500 var(--fs-label-xs) var(--font-sans); }

.companion-picker-viewport {
  -webkit-app-region: no-drag;
  touch-action: pan-y;
  max-height: min(290px, calc(100dvh - 140px));
  @apply tw:overflow-y-auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}
.companion-picker-option {
  @apply tw:flex tw:items-center tw:gap-s-3 tw:w-full tw:min-h-[52px] tw:p-s-2;
  border: 0;
  @apply tw:rounded-lg;
  outline: none;
  background: transparent;
  @apply tw:text-primary tw:cursor-pointer tw:text-left tw:select-none;
}
.companion-picker-option:is(:hover, .is-active) { background: var(--bg-hover); }
.companion-picker-option[aria-selected='true'] {
  background: color-mix(in srgb, var(--companion-option-accent) 12%, var(--bg-surface));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--companion-option-accent) 36%, var(--border-soft));
}
.companion-picker-option.is-active .companion-picker-option-mark {
  border-color: color-mix(in srgb, var(--companion-option-accent) 72%, var(--border-soft));
}
.companion-picker-check {
  @apply tw:grid;
  flex: 0 0 26px;
  @apply tw:w-[26px] tw:h-[26px];
  place-items: center;
  border-radius: 50%;
  background: color-mix(in srgb, var(--companion-option-accent) 15%, transparent);
  color: var(--companion-option-accent);
}
.companion-picker-check .archive-icon { @apply tw:w-[15px] tw:h-[15px]; }

@media (max-width: 400px) {
  .companion-picker-trigger { @apply tw:min-h-[38px]; }
  .companion-picker-mark { @apply tw:w-[25px] tw:h-[25px]; }
}
@media (prefers-reduced-motion: reduce) {
  .companion-picker-chevron,
  .companion-picker-menu-enter-active,
  .companion-picker-menu-leave-active { transition: none; }
}
@media (forced-colors: active) {
  .companion-picker-trigger,
  .companion-picker-content { border-color: CanvasText; background: Canvas; color: CanvasText; box-shadow: none; }
  .companion-picker-option[aria-selected='true'] { outline: 1px solid Highlight; outline-offset: -1px; }
}
</style>

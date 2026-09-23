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
        @wheel.stop
      >
        <div class="companion-picker-heading" aria-hidden="true">
          <span><ArchiveIcon name="character" />陪伴角色</span>
          <small>{{ characters.length }} 位可选</small>
        </div>
        <div class="companion-picker-viewport" @pointerdown.stop @wheel.stop>
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
.companion-picker {
  --companion-option-accent: var(--character-accent);
  position: relative;
  width: 100%;
  min-width: 0;
  max-width: 220px;
}
.companion-picker[data-character='nene'],
.companion-picker-option[data-value='nene'] { --companion-option-accent: var(--nene-violet); }
.companion-picker[data-character='natsume'],
.companion-picker-option[data-value='natsume'] { --companion-option-accent: var(--natsume-amber); }

.companion-picker-trigger {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  width: 100%;
  min-width: 0;
  min-height: 40px;
  padding: 4px 9px 4px 7px;
  border: 1px solid var(--border-soft);
  border-radius: var(--r-pill);
  background: color-mix(in srgb, var(--bg-surface) 92%, var(--companion-option-accent) 8%);
  color: var(--text-primary);
  box-shadow: inset 0 1px 0 var(--glass-highlight);
  cursor: pointer;
  text-align: left;
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
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--companion-option-accent) 45%, var(--border-soft));
  border-radius: 50%;
  background: color-mix(in srgb, var(--companion-option-accent) 12%, var(--bg-surface));
}
.companion-picker-mark { width: 27px; height: 27px; }
.companion-picker-option-mark { width: 34px; height: 34px; }
.companion-picker-mark i,
.companion-picker-option-mark i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--companion-option-accent);
  box-shadow: 0 0 9px color-mix(in srgb, var(--companion-option-accent) 48%, transparent);
}
.companion-picker-option-mark i { width: 10px; height: 10px; }

.companion-picker-copy,
.companion-picker-option-copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
}
.companion-picker-copy strong,
.companion-picker-option-copy strong {
  overflow: hidden;
  color: var(--text-primary);
  font: 600 var(--fs-label)/var(--lh-tight) var(--font-sans);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.companion-picker-copy small,
.companion-picker-option-copy small {
  overflow: hidden;
  color: var(--text-secondary);
  font: 500 var(--fs-label-xs)/var(--lh-tight) var(--font-sans);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.companion-picker-chevron {
  flex: 0 0 auto;
  width: 15px;
  height: 15px;
  color: var(--text-secondary);
  transition: transform var(--motion-hover) var(--ease-out);
}
.companion-picker-trigger[data-state='open'] .companion-picker-chevron { transform: rotate(180deg); }

.companion-picker-content {
  -webkit-app-region: no-drag;
  position: absolute;
  z-index: var(--z-popover);
  top: calc(100% + 8px);
  right: 0;
  width: min(260px, calc(100vw - 16px));
  max-height: min(360px, calc(100dvh - 80px));
  overflow: hidden;
  padding: var(--s-2);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-xl);
  background: var(--bg-elevated);
  color: var(--text-primary);
  box-shadow: var(--shadow-glass-elevated);
}
html.companion-desktop .companion-picker-content { right: auto; left: 0; -webkit-app-region: no-drag; }
.companion-picker-menu-enter-active,
.companion-picker-menu-leave-active { transition: opacity var(--motion-hover), transform var(--motion-hover) var(--ease-out); }
.companion-picker-menu-enter-from,
.companion-picker-menu-leave-to { opacity: 0; transform: translateY(-4px) scale(.98); }

.companion-picker-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-3);
  margin-bottom: var(--s-1);
  padding: var(--s-2) var(--s-2) var(--s-3);
  border-bottom: 1px solid var(--border-soft);
}
.companion-picker-heading > span { display: inline-flex; align-items: center; gap: var(--s-2); font: 650 var(--fs-label-sm) var(--font-sans); }
.companion-picker-heading .archive-icon { width: 16px; height: 16px; color: var(--character-accent); }
.companion-picker-heading small { color: var(--text-secondary); font: 500 var(--fs-label-xs) var(--font-sans); }

.companion-picker-viewport {
  -webkit-app-region: no-drag;
  touch-action: pan-y;
  max-height: min(290px, calc(100dvh - 140px));
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}
.companion-picker-option {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  width: 100%;
  min-height: 52px;
  padding: var(--s-2);
  border: 0;
  border-radius: var(--r-lg);
  outline: none;
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
  text-align: left;
  user-select: none;
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
  display: grid;
  flex: 0 0 26px;
  width: 26px;
  height: 26px;
  place-items: center;
  border-radius: 50%;
  background: color-mix(in srgb, var(--companion-option-accent) 15%, transparent);
  color: var(--companion-option-accent);
}
.companion-picker-check .archive-icon { width: 15px; height: 15px; }

@media (max-width: 400px) {
  .companion-picker-trigger { min-height: 38px; }
  .companion-picker-mark { width: 25px; height: 25px; }
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

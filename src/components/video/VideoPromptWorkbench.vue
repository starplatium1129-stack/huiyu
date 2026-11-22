<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, useId, watch } from 'vue'
import {
  videoVisualSlots, type VideoPromptAudio, type VideoPromptMode,
  type VideoPromptRecipe, type VideoVisualSlot,
} from '../../../types/videoPrompt'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import {
  matchesVideoPresetRating, pickRandomVideoPreset, presetCategoriesFor,
  summarizeVideoRecipe, videoMusicChoices, videoPresetRatings, videoPromptGroups,
  videoPromptPresets, videoSoundChoices, type VideoPresetCategory,
  type VideoPromptPreset, type VideoRecipeSummaryItem,
} from './videoPromptPresets'

const PRESET_COLLAPSED_LIMIT = 6

const props = defineProps<{
  mode: VideoPromptMode
  supportsAudio: boolean
  supportsDialogueAndMusic: boolean
  disabled: boolean
}>()
const recipe = defineModel<VideoPromptRecipe>({ required: true })
const id = useId()
const ratingId = `${id}-preset-rating`
const rating = ref<string | number>('all')
const category = ref<'all' | VideoPresetCategory>('all')
const presetsExpanded = ref(false)
const categories = computed(() => presetCategoriesFor(props.mode, rating.value))
const groups = computed(() => videoPromptGroups(props.mode, rating.value, rating.value === 'all' ? undefined : recipe.value))
const ratingPresets = computed(() => videoPromptPresets[props.mode].filter(preset => matchesVideoPresetRating(preset, rating.value)))
const filteredPresets = computed(() => category.value === 'all'
  ? ratingPresets.value
  : ratingPresets.value.filter(preset => preset.category === category.value))
const visiblePresets = computed(() => presetsExpanded.value
  ? filteredPresets.value
  : filteredPresets.value.slice(0, PRESET_COLLAPSED_LIMIT))
const hasMorePresets = computed(() => filteredPresets.value.length > PRESET_COLLAPSED_LIMIT)
const summary = computed(() => summarizeVideoRecipe(props.mode, recipe.value, props.supportsAudio, props.supportsDialogueAndMusic))
const previous = shallowRef<{ recipe: VideoPromptRecipe; button: HTMLElement | null; kind: 'preset' | 'clear' }>()
const notice = ref('')
const languages = [
  { value: '', label: '自动识别' }, { value: 'zh', label: '中文' }, { value: 'en', label: '英文' }, { value: 'ja', label: '日文' },
]

watch([() => props.mode, rating, categories], ([, , nextCategories]) => {
  if (!nextCategories.some(item => item.id === category.value)) category.value = 'all'
})

watch([() => props.mode, rating, category], () => {
  const index = filteredPresets.value.findIndex(preset => isSelected(preset))
  if (index >= PRESET_COLLAPSED_LIMIT) presetsExpanded.value = true
}, { immediate: true })

function isSelected(preset: VideoPromptPreset) {
  return videoVisualSlots.every(slot => recipe.value[slot] === preset.recipe[slot])
    && recipe.value.audio?.sound === preset.recipe.audio?.sound
    && recipe.value.audio?.music === preset.recipe.audio?.music
}

function withAudio(next: VideoPromptRecipe, audio: VideoPromptAudio) {
  if (Object.keys(audio).length) next.audio = audio
  else delete next.audio
  return next
}

function applyPreset(preset: VideoPromptPreset, button: HTMLElement | null) {
  if (isSelected(preset)) return
  previous.value = { recipe: recipe.value, button, kind: 'preset' }
  const { dialogue, language } = recipe.value.audio ?? {}
  const audio = { ...preset.recipe.audio, ...(dialogue ? { dialogue } : {}), ...(language ? { language } : {}) }
  recipe.value = withAudio({ ...preset.recipe }, audio)
  const index = filteredPresets.value.findIndex(item => item.id === preset.id)
  if (index >= PRESET_COLLAPSED_LIMIT) presetsExpanded.value = true
  notice.value = `已载入「${preset.title}」。`
}

function choosePreset(preset: VideoPromptPreset, event: MouseEvent) {
  applyPreset(preset, event.currentTarget as HTMLButtonElement)
}

function pickRandomPreset(event: MouseEvent) {
  const current = filteredPresets.value.find(preset => isSelected(preset))
  const next = pickRandomVideoPreset(props.mode, rating.value, category.value, current?.id)
  if (!next) return
  if (category.value !== 'all' && next.category !== category.value) category.value = 'all'
  applyPreset(next, event.currentTarget as HTMLButtonElement)
}

function clearRecipe(event: MouseEvent) {
  if (!summary.value.items.length) return
  previous.value = { recipe: recipe.value, button: event.currentTarget as HTMLButtonElement, kind: 'clear' }
  recipe.value = {}
  notice.value = '已清空已选积木。'
}

async function undoPrevious() {
  const edit = previous.value
  if (!edit) return
  recipe.value = edit.recipe
  previous.value = undefined
  notice.value = edit.kind === 'clear' ? '已恢复清空前的积木。' : '已恢复选预设前的积木。'
  await nextTick()
  if (document.activeElement === document.body) {
    const target = edit.button?.isConnected ? edit.button : document.getElementById(ratingId)
    target?.focus({ preventScroll: true })
  }
}

function setSlot(slot: VideoVisualSlot, value: string) {
  const next = { ...recipe.value }
  if (value) next[slot] = value
  else delete next[slot]
  recipe.value = next
  previous.value = undefined
}

function setAudio<K extends keyof VideoPromptAudio>(key: K, value: VideoPromptAudio[K]) {
  const audio = { ...recipe.value.audio }
  if (value) audio[key] = value
  else delete audio[key]
  recipe.value = withAudio({ ...recipe.value }, audio)
  previous.value = undefined
}

function setLanguage(value: string | number) {
  setAudio('language', value === 'zh' || value === 'en' || value === 'ja' ? value : undefined)
}

function removeSummaryItem(item: VideoRecipeSummaryItem) {
  if (item.slot) {
    setSlot(item.slot, '')
    notice.value = `已移除${item.slotLabel}「${item.label}」。`
    return
  }
  if (item.audioKey) {
    setAudio(item.audioKey, undefined)
    notice.value = `已移除${item.slotLabel}「${item.label}」。`
  }
}

function selectedSlotLabel(group: ReturnType<typeof videoPromptGroups>[number]) {
  const current = recipe.value[group.slot]
  if (!current) return ''
  return group.options.find(option => option.value === current)?.label ?? ''
}

function selectedChoiceLabel(choices: readonly { value: string; label: string }[], current?: string) {
  if (!current) return ''
  return choices.find(choice => choice.value === current)?.label ?? ''
}
</script>

<template>
  <div class="video-prompt-workbench">
    <fieldset class="workbench-group" :disabled="disabled">
      <div class="workbench-preset-bar">
        <legend class="field-label">精选场景预设</legend>
        <div class="workbench-preset-controls">
          <button class="btn btn-quiet btn-sm" type="button" :disabled="disabled || !filteredPresets.length" @click="pickRandomPreset">
            <ArchiveIcon name="dice" />随机搭一组
          </button>
          <StudioSelect :id="ratingId" v-model="rating" label="预设分级" size="sm" inline :options="videoPresetRatings" :disabled="disabled" />
        </div>
      </div>

      <div v-if="categories.length > 2" class="workbench-categories studio-segments studio-segments--compact" data-fluid-glass role="group" aria-label="预设分类">
        <AnimatedSelection />
        <button v-for="cat in categories" :key="cat.id" type="button" :aria-pressed="category === cat.id" :disabled="disabled" @click="category = cat.id">
          {{ cat.label }}
        </button>
      </div>

      <div v-if="visiblePresets.length" class="workbench-presets">
        <button v-for="preset in visiblePresets" :key="preset.id" class="btn btn-ghost workbench-preset" type="button"
          :aria-pressed="isSelected(preset)" @click="choosePreset(preset, $event)">
          <span class="workbench-preset-icon"><ArchiveIcon :name="preset.icon" /></span>
          <span class="workbench-preset-text">
            <strong>{{ preset.title }} <span v-if="preset.rating && preset.rating !== 'All'" class="workbench-grade">{{ preset.rating }}</span></strong>
            <small>{{ preset.summary }}</small>
          </span>
          <ArchiveIcon class="workbench-check" name="success" />
        </button>
      </div>
      <p v-else class="field-hint workbench-empty-hint">当前筛选下暂无预设，试试切换分级或直接点选下方积木。</p>

      <div v-if="hasMorePresets" class="workbench-preset-more">
        <button class="btn btn-quiet btn-sm" type="button" :aria-expanded="presetsExpanded" @click="presetsExpanded = !presetsExpanded">
          {{ presetsExpanded ? '收起部分预设' : `展开全部 ${filteredPresets.length} 套预设` }}
        </button>
      </div>
    </fieldset>

    <div v-if="summary.items.length || previous" class="workbench-summary-card" aria-label="当前积木组合">
      <div class="workbench-summary-head">
        <span class="field-label">当前积木组合</span>
        <div class="workbench-summary-actions">
          <button v-if="previous" class="btn btn-quiet btn-sm" type="button" :disabled="disabled" @click="undoPrevious">
            {{ previous.kind === 'clear' ? '恢复已清空积木' : '撤销预设' }}
          </button>
          <button v-if="summary.items.length" class="btn btn-quiet btn-sm" type="button" :disabled="disabled" @click="clearRecipe">
            清空积木
          </button>
        </div>
      </div>
      <div v-if="summary.items.length" class="workbench-summary-tags">
        <button v-for="item in summary.items" :key="item.key" type="button" class="workbench-summary-tag"
          :disabled="disabled" :aria-label="`移除 ${item.slotLabel}：${item.label}`" @click="removeSummaryItem(item)">
          <span>{{ item.slotLabel }} · {{ item.label }}</span>
          <ArchiveIcon name="close" class="workbench-tag-remove" />
        </button>
      </div>
      <p v-if="summary.prose" class="workbench-summary-prose">{{ summary.prose }}</p>
    </div>

    <p class="sr-only" role="status">{{ notice }}</p>

    <details class="workbench-details" open>
      <StudioDisclosureSummary class="workbench-summary">调整积木</StudioDisclosureSummary>
      <div class="workbench-slots" data-disclosure-content>
        <fieldset v-for="group in groups" :key="group.slot" v-memo="[mode, rating, recipe[group.slot], disabled]" class="workbench-group workbench-slot" :disabled="disabled">
          <legend class="field-label workbench-slot-legend">
            <span>{{ group.label }}</span>
            <small v-if="selectedSlotLabel(group)" class="workbench-slot-active">{{ selectedSlotLabel(group) }}</small>
          </legend>
          <div class="workbench-options">
            <template v-for="option in group.options" :key="option.value">
              <input :id="`${id}-${group.slot}-${option.value}`" :name="`${id}-${group.slot}`" class="sr-only" type="radio"
                :value="option.value" :checked="(recipe[group.slot] ?? '') === option.value" @change="setSlot(group.slot, option.value)" />
              <label class="workbench-chip" :for="`${id}-${group.slot}-${option.value}`" :title="option.text || undefined">
                <ArchiveIcon class="workbench-check" name="success" />
                <span>{{ option.label }}</span>
                <span v-if="option.rating && option.rating !== 'All'" class="workbench-grade">{{ option.rating }}</span>
              </label>
            </template>
          </div>
        </fieldset>
      </div>
    </details>

    <details v-if="supportsAudio" class="workbench-details">
      <StudioDisclosureSummary class="workbench-summary">{{ supportsDialogueAndMusic ? '声音与配乐' : '声景' }}</StudioDisclosureSummary>
      <div class="workbench-audio-stack" data-disclosure-content>
        <fieldset class="workbench-group workbench-slot" :disabled="disabled">
          <legend class="field-label workbench-slot-legend">
            <span>声景</span>
            <small v-if="selectedChoiceLabel(videoSoundChoices, recipe.audio?.sound)" class="workbench-slot-active">
              {{ selectedChoiceLabel(videoSoundChoices, recipe.audio?.sound) }}
            </small>
          </legend>
          <div class="workbench-options">
            <template v-for="choice in videoSoundChoices" :key="choice.value">
              <input :id="`${id}-sound-${choice.value}`" :name="`${id}-sound`" class="sr-only" type="radio"
                :value="choice.value" :checked="(recipe.audio?.sound ?? '') === choice.value" @change="setAudio('sound', choice.value)" />
              <label class="workbench-chip" :for="`${id}-sound-${choice.value}`" :title="choice.text || undefined">
                <ArchiveIcon class="workbench-check" name="success" />
                <span>{{ choice.label }}</span>
              </label>
            </template>
          </div>
        </fieldset>

        <template v-if="supportsDialogueAndMusic">
          <fieldset class="workbench-group workbench-slot" :disabled="disabled">
            <legend class="field-label workbench-slot-legend">
              <span>配乐</span>
              <small v-if="selectedChoiceLabel(videoMusicChoices, recipe.audio?.music)" class="workbench-slot-active">
                {{ selectedChoiceLabel(videoMusicChoices, recipe.audio?.music) }}
              </small>
            </legend>
            <div class="workbench-options">
              <template v-for="choice in videoMusicChoices" :key="choice.value">
                <input :id="`${id}-music-${choice.value}`" :name="`${id}-music`" class="sr-only" type="radio"
                  :value="choice.value" :checked="(recipe.audio?.music ?? '') === choice.value" @change="setAudio('music', choice.value)" />
                <label class="workbench-chip" :for="`${id}-music-${choice.value}`" :title="choice.text || undefined">
                  <ArchiveIcon class="workbench-check" name="success" />
                  <span>{{ choice.label }}</span>
                </label>
              </template>
            </div>
          </fieldset>

          <div class="workbench-dialogue-row">
            <div class="field">
              <label :for="`${id}-dialogue`" class="field-label">一句对白（可选）</label>
              <input :id="`${id}-dialogue`" :name="`${id}-dialogue`" class="input" maxlength="300" :disabled="disabled"
                placeholder="如：等雨停了再走吧。"
                :value="recipe.audio?.dialogue ?? ''" @input="setAudio('dialogue', ($event.target as HTMLInputElement).value)" />
            </div>
            <div class="field">
              <label :for="`${id}-dialogue-language`" class="field-label">对白语言</label>
              <StudioSelect :id="`${id}-dialogue-language`" label="对白语言" :options="languages" :disabled="disabled"
                :model-value="recipe.audio?.language ?? ''" @update:model-value="setLanguage" />
            </div>
          </div>
        </template>
      </div>
    </details>
  </div>
</template>

<style scoped>
.video-prompt-workbench, .workbench-slots, .workbench-audio-stack {
  display: grid;
  min-inline-size: 0;
  gap: var(--s-3);
}
.video-prompt-workbench { container: video-prompt-workbench / inline-size; }
.workbench-group {
  min-inline-size: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
.workbench-preset-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-2);
  margin-block-end: var(--s-2);
}
.workbench-preset-bar legend { margin: 0; padding: 0; }
.workbench-preset-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s-2);
}
.workbench-categories {
  flex-wrap: wrap;
  margin-block-end: var(--s-2);
}
.workbench-slot-legend {
  display: flex;
  align-items: baseline;
  gap: var(--s-2);
  margin-block-end: var(--s-2);
  padding: 0;
}
.workbench-slot-active {
  color: var(--accent);
  font: 500 var(--fs-label-xs) var(--font-sans);
}
.workbench-grade {
  margin-inline-start: var(--s-1);
  color: var(--text-secondary);
  font: 500 var(--fs-label-xs) var(--font-sans);
}
.workbench-presets {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--s-2);
}
@container video-prompt-workbench (min-width: 30rem) {
  .workbench-presets { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
.workbench-preset {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--s-2);
  min-block-size: 4rem;
  padding: var(--s-2) var(--s-3);
  border: 1px solid var(--border-soft);
  text-align: start;
  white-space: normal;
  transition: border-color var(--motion-hover) var(--ease-out), background-color var(--motion-hover) var(--ease-out);
}
.workbench-preset-icon {
  display: grid;
  place-items: center;
  inline-size: 2rem;
  block-size: 2rem;
  border-radius: var(--r-md);
  background: var(--bg-elevated);
}
.workbench-preset-text { display: grid; gap: var(--s-1); min-inline-size: 0; }
.workbench-preset-text strong, .workbench-preset-text small { overflow-wrap: anywhere; }
.workbench-preset-text small, .workbench-summary { color: var(--text-secondary); }
.workbench-check { inline-size: 1rem; block-size: 1rem; visibility: hidden; flex: none; }
.workbench-preset[aria-pressed="true"], input:checked + .workbench-chip {
  color: var(--text-primary);
  background: var(--bg-elevated);
  border-color: var(--text-secondary);
}
.workbench-preset[aria-pressed="true"] .workbench-check, input:checked + .workbench-chip .workbench-check { visibility: visible; }
.workbench-group:disabled .workbench-preset,
.workbench-group:disabled small,
.workbench-group:disabled .workbench-grade,
input:disabled + .workbench-chip,
.workbench-summary-tag:disabled {
  color: var(--text-disabled);
  cursor: not-allowed;
}
.workbench-empty-hint { margin: 0; }
.workbench-preset-more { display: flex; justify-content: flex-start; margin-block-start: var(--s-2); }
.workbench-summary-card {
  display: grid;
  gap: var(--s-2);
  padding: var(--s-3);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-md);
  background: var(--bg-base);
}
.workbench-summary-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-2);
}
.workbench-summary-actions { display: flex; flex-wrap: wrap; gap: var(--s-1); }
.workbench-summary-tags { display: flex; flex-wrap: wrap; gap: var(--s-2); }
.workbench-summary-tag {
  display: inline-flex;
  align-items: center;
  gap: var(--s-1);
  min-block-size: var(--control-height-sm);
  padding: var(--s-1) var(--s-2);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-pill);
  background: var(--bg-surface);
  color: var(--text-primary);
  font-size: var(--fs-label-xs);
  line-height: var(--lh-label);
  cursor: pointer;
}
.workbench-tag-remove { inline-size: 0.875rem; block-size: 0.875rem; color: var(--text-secondary); }
.workbench-summary-prose {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--fs-body-sm);
  line-height: var(--lh-body);
}
.workbench-details { border-block-start: 1px solid var(--border-soft); padding-block-start: var(--s-2); }
.workbench-summary { font-size: var(--fs-label); font-weight: 600; }
.workbench-slots, .workbench-audio-stack { padding-block-start: var(--s-2); }
.workbench-options { display: flex; flex-wrap: wrap; gap: var(--s-2); }
.workbench-chip {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--s-1);
  min-block-size: var(--control-height-sm);
  padding-inline: var(--s-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  color: var(--text-secondary);
  font-size: var(--fs-label-sm);
  cursor: pointer;
  transition: border-color var(--motion-hover) var(--ease-out), color var(--motion-hover) var(--ease-out);
}
.workbench-preset:focus-visible,
input:focus-visible + .workbench-chip,
.workbench-summary:focus-visible,
.workbench-summary-tag:focus-visible {
  outline: 2px solid var(--text-primary);
  outline-offset: 2px;
}
.workbench-dialogue-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--s-3);
}
@container video-prompt-workbench (min-width: 28rem) {
  .workbench-dialogue-row { grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); }
}
@media (hover: hover) and (pointer: fine) {
  input:not(:disabled) + .workbench-chip:hover { color: var(--text-primary); border-color: var(--text-secondary); }
  .workbench-summary-tag:not(:disabled):hover { border-color: var(--text-secondary); }
  .workbench-summary-tag:not(:disabled):hover .workbench-tag-remove { color: var(--text-primary); }
}
@media (pointer: coarse) {
  .workbench-chip, .workbench-summary, .workbench-summary-tag { min-block-size: 48px; }
}
@media (prefers-reduced-motion: reduce) {
  :root:not([data-motion='full']) .workbench-preset,
  :root:not([data-motion='full']) .workbench-chip { transition: none; }
}
:root:is([data-motion='reduce'], [data-motion='reduced'], [data-reduced-motion='true']) .workbench-preset,
:root:is([data-motion='reduce'], [data-motion='reduced'], [data-reduced-motion='true']) .workbench-chip { transition: none; }
@media (forced-colors: active) {
  .workbench-preset[aria-pressed="true"], input:checked + .workbench-chip { border-color: Highlight; }
  .workbench-preset:focus-visible,
  input:focus-visible + .workbench-chip,
  .workbench-summary:focus-visible,
  .workbench-summary-tag:focus-visible { outline-color: Highlight; }
}
</style>

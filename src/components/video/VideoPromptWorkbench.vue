<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, useId } from 'vue'
import { videoVisualSlots, type VideoPromptAudio, type VideoPromptMode, type VideoPromptRecipe, type VideoVisualSlot } from '../../../types/videoPrompt'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { matchesVideoPresetRating, videoMusicOptions, videoPresetRatings, videoPromptGroups, videoPromptPresets, videoSoundOptions, type VideoPromptPreset } from './videoPromptPresets'

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
const groups = computed(() => videoPromptGroups(props.mode))
const presets = computed(() => videoPromptPresets[props.mode].filter(preset => matchesVideoPresetRating(preset, rating.value)))
const previous = shallowRef<{ recipe: VideoPromptRecipe; button: HTMLButtonElement }>()
const notice = ref('')
const languages = [
  { value: '', label: '自动识别' }, { value: 'zh', label: '中文' }, { value: 'en', label: '英文' }, { value: 'ja', label: '日文' },
]

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

function choosePreset(preset: VideoPromptPreset, event: MouseEvent) {
  if (isSelected(preset)) return
  previous.value = { recipe: recipe.value, button: event.currentTarget as HTMLButtonElement }
  const { dialogue, language } = recipe.value.audio ?? {}
  const audio = { ...preset.recipe.audio, ...(dialogue ? { dialogue } : {}), ...(language ? { language } : {}) }
  recipe.value = withAudio({ ...preset.recipe }, audio)
  notice.value = `已载入「${preset.title}」。`
}

async function undoPreset() {
  const edit = previous.value
  if (!edit) return
  recipe.value = edit.recipe
  previous.value = undefined
  notice.value = '已恢复选预设前的积木。'
  await nextTick()
  if (document.activeElement === document.body) {
    const target = edit.button.isConnected ? edit.button : document.getElementById(ratingId)
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
</script>

<template>
  <div class="video-prompt-workbench">
    <fieldset class="workbench-group" :disabled="disabled">
      <legend class="field-label">精选场景预设</legend>
      <div class="workbench-rating">
        <StudioSelect :id="ratingId" v-model="rating" label="预设分级" size="sm" inline :options="videoPresetRatings" :disabled="disabled" />
      </div>
      <div class="workbench-presets">
        <button v-for="preset in presets" :key="preset.id" class="btn btn-ghost workbench-preset" type="button"
          :aria-pressed="isSelected(preset)" @click="choosePreset(preset, $event)">
          <span class="workbench-preset-icon"><ArchiveIcon :name="preset.icon" /></span>
          <span class="workbench-preset-text">
            <strong>{{ preset.title }} <span v-if="preset.rating && preset.rating !== 'All'" class="workbench-grade">{{ preset.rating }}</span></strong>
            <small>{{ preset.summary }}</small>
          </span>
          <ArchiveIcon class="workbench-check" name="success" />
        </button>
      </div>
      <button v-if="previous" class="btn btn-quiet btn-sm workbench-undo" type="button" @click="undoPreset">撤销预设</button>
      <p class="sr-only" role="status">{{ notice }}</p>
    </fieldset>

    <details class="workbench-details" open>
      <StudioDisclosureSummary class="workbench-summary">调整积木</StudioDisclosureSummary>
      <div class="workbench-slots" data-disclosure-content>
        <fieldset v-for="group in groups" :key="group.slot" class="workbench-group workbench-slot" :disabled="disabled">
          <legend class="field-label">{{ group.label }}</legend>
          <div class="workbench-options">
            <template v-for="option in group.options" :key="option.value">
              <input :id="`${id}-${group.slot}-${option.value}`" :name="`${id}-${group.slot}`" class="sr-only" type="radio"
                :value="option.value" :checked="(recipe[group.slot] ?? '') === option.value" @change="setSlot(group.slot, option.value)" />
              <label class="workbench-chip" :for="`${id}-${group.slot}-${option.value}`">
                <ArchiveIcon class="workbench-check" name="success" />{{ option.label }}
              </label>
            </template>
          </div>
        </fieldset>
      </div>
    </details>

    <details v-if="supportsAudio" class="workbench-details">
      <StudioDisclosureSummary class="workbench-summary">{{ supportsDialogueAndMusic ? '声音与配乐' : '声景' }}</StudioDisclosureSummary>
      <div class="workbench-audio" data-disclosure-content>
        <div class="field">
          <label :for="`${id}-sound`" class="field-label">声景</label>
          <StudioSelect :id="`${id}-sound`" label="声景" :options="videoSoundOptions" :disabled="disabled"
            :model-value="recipe.audio?.sound ?? ''" @update:model-value="setAudio('sound', String($event))" />
        </div>
        <template v-if="supportsDialogueAndMusic">
          <div class="field">
            <label :for="`${id}-music`" class="field-label">配乐</label>
            <StudioSelect :id="`${id}-music`" label="配乐" :options="videoMusicOptions" :disabled="disabled"
              :model-value="recipe.audio?.music ?? ''" @update:model-value="setAudio('music', String($event))" />
          </div>
          <div class="field">
            <label :for="`${id}-dialogue`" class="field-label">一句对白（可选）</label>
            <input :id="`${id}-dialogue`" :name="`${id}-dialogue`" class="input" maxlength="300" :disabled="disabled"
              :value="recipe.audio?.dialogue ?? ''" @input="setAudio('dialogue', ($event.target as HTMLInputElement).value)" />
          </div>
          <div class="field">
            <label :for="`${id}-dialogue-language`" class="field-label">对白语言</label>
            <StudioSelect :id="`${id}-dialogue-language`" label="对白语言" :options="languages" :disabled="disabled"
              :model-value="recipe.audio?.language ?? ''" @update:model-value="setLanguage" />
          </div>
        </template>
      </div>
    </details>
  </div>
</template>

<style scoped>
.video-prompt-workbench, .workbench-slots, .workbench-audio {
  display: grid;
  min-inline-size: 0;
  gap: var(--s-3);
}
.workbench-group {
  min-inline-size: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
.workbench-group legend { margin-block-end: var(--s-2); padding: 0; }
.workbench-rating { display: flex; justify-content: flex-end; margin-block-end: var(--s-2); }
.workbench-grade { margin-inline-start: var(--s-1); color: var(--text-secondary); font: 500 var(--fs-label-xs) var(--font-sans); }
.workbench-presets {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr));
  gap: var(--s-2);
}
.workbench-preset {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--s-2);
  min-block-size: 4rem;
  padding: var(--s-2) var(--s-3);
  text-align: start;
  white-space: normal;
}
.workbench-preset-icon {
  display: grid;
  place-items: center;
  inline-size: 2rem;
  block-size: 2rem;
  border-radius: var(--r-md);
  background: var(--bg-elevated);
}
.workbench-preset-text { display: grid; gap: var(--s-1); }
.workbench-preset-text small, .workbench-summary { color: var(--text-secondary); }
.workbench-check { inline-size: 1rem; block-size: 1rem; visibility: hidden; }
.workbench-preset[aria-pressed="true"], input:checked + .workbench-chip {
  color: var(--text-primary);
  background: var(--bg-elevated);
  border-color: var(--text-secondary);
}
.workbench-preset[aria-pressed="true"] .workbench-check, input:checked + .workbench-chip .workbench-check { visibility: visible; }
.workbench-group:disabled .workbench-preset, .workbench-group:disabled small, .workbench-group:disabled .workbench-grade, input:disabled + .workbench-chip {
  color: var(--text-disabled);
  cursor: not-allowed;
}
.workbench-undo { margin-block-start: var(--s-2); }
.workbench-details { border-block-start: 1px solid var(--border-soft); padding-block-start: var(--s-2); }
.workbench-summary { font-size: var(--fs-label); font-weight: 600; }
.workbench-slots, .workbench-audio { padding-block-start: var(--s-2); }
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
}
.workbench-preset:focus-visible, input:focus-visible + .workbench-chip, .workbench-summary:focus-visible {
  outline: 2px solid var(--text-primary);
  outline-offset: 2px;
}
.workbench-audio { grid-template-columns: repeat(auto-fit, minmax(min(100%, 13rem), 1fr)); }
@media (hover: hover) and (pointer: fine) {
  input:not(:disabled) + .workbench-chip:hover { color: var(--text-primary); border-color: var(--text-secondary); }
}
@media (pointer: coarse) {
  .workbench-chip, .workbench-summary { min-block-size: 48px; }
}
@media (forced-colors: active) {
  .workbench-preset[aria-pressed="true"], input:checked + .workbench-chip { border-color: Highlight; }
  .workbench-preset:focus-visible, input:focus-visible + .workbench-chip, .workbench-summary:focus-visible { outline-color: Highlight; }
}
</style>

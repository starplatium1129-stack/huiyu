<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, useId, watch } from 'vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import StudioSelect, { type StudioSelectOption } from '@/components/ui/StudioSelect.vue'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import {
  matchesVideoPresetRating, presetCategoriesFor, videoPresetRatings,
  type VideoPresetCategory,
} from './videoPromptPresets'
import {
  assembleVideoPrompt, blankVideoPromptFields, videoPromptGuidance, videoPromptPresets,
  type ShotPromptMode, type VideoPromptEdit, type VideoPromptFields,
} from './shotPromptComposer'

const PRESET_COLLAPSED_LIMIT = 6

const props = withDefaults(defineProps<VideoPromptEdit & {
  mode: ShotPromptMode
  cameraOptions: readonly StudioSelectOption[]
  motionOptions: readonly StudioSelectOption[]
  maxLength?: number
  disabled?: boolean
}>(), { maxLength: 4000 })
const emit = defineEmits<{ apply: [edit: VideoPromptEdit] }>()

const id = useId()
const disclosure = ref<HTMLDetailsElement | null>(null)
const primaryAction = ref<HTMLButtonElement | null>(null)
const revealed = ref(false)
const rating = ref<string | number>('all')
const category = ref<'all' | VideoPresetCategory>('all')
const presetsExpanded = ref(false)
const fields = ref(blankVideoPromptFields())
const camera = ref<VideoPromptEdit['camera'] | ''>('')
const motion = ref<VideoPromptEdit['motion'] | ''>('')
const notice = ref('')
const lastEdit = shallowRef<{ before: VideoPromptEdit; after: VideoPromptEdit; replace: boolean } | null>(null)
const keepCurrent = { value: '', label: '沿用当前' }
const cameraOptions = computed(() => [keepCurrent, ...props.cameraOptions])
const motionOptions = computed(() => [keepCurrent, ...props.motionOptions])
const categories = computed(() => presetCategoriesFor(props.mode, rating.value))
const ratingPresets = computed(() => videoPromptPresets[props.mode].filter(preset => matchesVideoPresetRating(preset, rating.value)))
const presets = computed(() => category.value === 'all'
  ? ratingPresets.value
  : ratingPresets.value.filter(preset => preset.category === category.value))
const visiblePresets = computed(() => presetsExpanded.value ? presets.value : presets.value.slice(0, PRESET_COLLAPSED_LIMIT))

watch([() => props.mode, rating, categories], ([, , nextCategories]) => {
  if (!nextCategories.some(item => item.id === category.value)) category.value = 'all'
})

type PromptField = { key: keyof VideoPromptFields; label: string; placeholder: string }
const promptFields = computed<PromptField[]>(() => [
  ...(props.mode === 'text'
    ? [{ key: 'setup' as const, label: '开场画面', placeholder: '谁在什么地方？开场是什么景别？' }]
    : []),
  { key: 'action', label: '主要动作', placeholder: '接下来谁做了什么？' },
  { key: 'atmosphere', label: '环境变化', placeholder: '光线、风、雨或背景如何变化？' },
  { key: 'ending', label: '动作收尾', placeholder: '动作停在哪里？最后留下什么画面？' },
])

function readPrompt(): VideoPromptEdit {
  return { prompt: props.prompt, camera: props.camera, motion: props.motion }
}

function sameEdit(a: VideoPromptEdit, b: VideoPromptEdit): boolean {
  return a.prompt === b.prompt && a.camera === b.camera && a.motion === b.motion
}

function loadPreset(preset: (typeof presets.value)[number]) {
  fields.value = { ...blankVideoPromptFields(), ...preset.fields }
  camera.value = preset.camera
  motion.value = preset.motion
  notice.value = `已载入「${preset.title}」，可以修改后应用。`
}

const appliedEdit = computed(() => lastEdit.value && sameEdit(lastEdit.value.after, props) ? lastEdit.value : null)
const basePrompt = computed(() => appliedEdit.value?.before.prompt ?? props.prompt)
const fragment = computed(() => assembleVideoPrompt(props.mode, fields.value))
const replaceOnApply = computed(() => appliedEdit.value?.replace ?? !basePrompt.value.trim())
const primaryLabel = computed(() => appliedEdit.value ? '更新已应用片段' : replaceOnApply.value ? '填入镜头描述' : '追加到镜头描述')

function buildEdit(replace: boolean): VideoPromptEdit {
  const original = basePrompt.value.trimEnd()
  const text = fragment.value
  const alreadyIncluded = original === text || original.endsWith(`\n${text}`)
  const prompt = replace ? text : alreadyIncluded ? original : [original, text].filter(Boolean).join('\n')
  return { prompt, camera: camera.value || props.camera, motion: motion.value || props.motion }
}

function canApply(edit: VideoPromptEdit): boolean {
  return !props.disabled && !!fragment.value && edit.prompt.trim().length >= 8
    && edit.prompt.length <= props.maxLength && !sameEdit(edit, props)
}

const preview = computed(() => buildEdit(replaceOnApply.value))
const canReplace = computed(() => !!basePrompt.value.trim() && !replaceOnApply.value)

function apply(replace: boolean) {
  const edit = buildEdit(replace)
  if (!canApply(edit)) return
  const usedReplaceButton = replace && canReplace.value
  lastEdit.value = { before: appliedEdit.value?.before ?? readPrompt(), after: edit, replace }
  emit('apply', edit)
  notice.value = '镜头描述和运动设置已更新。'
  if (usedReplaceButton) void focusPrimaryAction()
}

function undo() {
  if (!appliedEdit.value || props.disabled) return
  emit('apply', appliedEdit.value.before)
  lastEdit.value = null
  notice.value = '已恢复应用前的镜头描述和运动设置。'
  void focusPrimaryAction()
}

async function focusPrimaryAction() {
  await nextTick()
  if (disclosure.value?.open && document.activeElement === document.body) {
    const target = primaryAction.value ?? disclosure.value.querySelector('summary')
    target?.focus({ preventScroll: true })
  }
}
</script>

<template>
  <details ref="disclosure" class="video-prompt-workbench" @toggle="revealed ||= !!disclosure?.open">
    <StudioDisclosureSummary class="workbench-summary">
      <ArchiveIcon name="wand" />场景预设与提示词组装
    </StudioDisclosureSummary>
    <div class="workbench-body" data-disclosure-content>
      <template v-if="revealed">
        <fieldset class="workbench-group" :disabled="disabled">
          <legend class="field-label">场景预设</legend>
          <p class="field-hint">{{ videoPromptGuidance[mode] }}</p>
          <StudioSelect v-model="rating" class="workbench-rating" label="预设分级" size="sm" inline :options="videoPresetRatings" :disabled="disabled" />
          <div v-if="categories.length > 2" class="workbench-categories studio-segments studio-segments--compact" data-fluid-glass role="group" aria-label="预设分类">
            <AnimatedSelection />
            <button v-for="cat in categories" :key="cat.id" type="button" :aria-pressed="category === cat.id" :disabled="disabled" @click="category = cat.id">
              {{ cat.label }}
            </button>
          </div>
          <div class="workbench-presets">
            <button v-for="preset in visiblePresets" :key="preset.id" class="btn btn-ghost btn-sm" type="button"
              :disabled="disabled" @click="loadPreset(preset)">
              <ArchiveIcon :name="preset.icon" />{{ preset.title }}{{ preset.rating && preset.rating !== 'All' ? ' · ' + preset.rating : '' }}
            </button>
          </div>
          <div v-if="presets.length > PRESET_COLLAPSED_LIMIT" class="workbench-preset-more">
            <button class="btn btn-quiet btn-sm" type="button" :aria-expanded="presetsExpanded" @click="presetsExpanded = !presetsExpanded">
              {{ presetsExpanded ? '收起部分预设' : `展开全部 ${presets.length} 套预设` }}
            </button>
          </div>
        </fieldset>

        <fieldset class="workbench-group" :disabled="disabled">
          <legend class="field-label">组装片段</legend>
          <div class="workbench-fields">
            <label v-for="field in promptFields" :key="field.key" class="field">
              <span class="field-label">{{ field.label }}</span>
              <textarea v-model="fields[field.key]" class="textarea" rows="3" maxlength="4000"
                :placeholder="field.placeholder" spellcheck="false" autocorrect="off" autocapitalize="off" />
            </label>
          </div>
          <div class="workbench-parameters">
            <div class="field">
              <label :for="`${id}-camera`" class="field-label">镜头运动</label>
              <StudioSelect :id="`${id}-camera`" v-model="camera" label="镜头运动" :options="cameraOptions" :disabled="disabled" />
            </div>
            <div class="field">
              <label :for="`${id}-motion`" class="field-label">主体运动</label>
              <StudioSelect :id="`${id}-motion`" v-model="motion" label="主体运动" :options="motionOptions" :disabled="disabled" />
            </div>
          </div>
          <p class="field-hint workbench-parameter-hint">描述已写清动作或运镜时，优先按文字生成。</p>
        </fieldset>

        <div v-if="fragment" class="workbench-preview">
          <div class="workbench-preview-heading">
            <label :for="`${id}-preview`" class="field-label">{{ replaceOnApply ? '描述预览' : '追加后的描述' }}</label>
            <span class="field-hint" :class="{ 'workbench-limit': preview.prompt.length > maxLength }">{{ preview.prompt.length }} / {{ maxLength }}</span>
          </div>
          <textarea :id="`${id}-preview`" class="textarea" rows="4" readonly :value="preview.prompt" />
          <p v-if="preview.prompt.length > maxLength" class="field-hint workbench-limit">描述超长，请删减内容<span v-if="canReplace">，或改用替换</span>。</p>
        </div>
        <div v-if="fragment || appliedEdit" class="workbench-actions">
          <button v-if="fragment" ref="primaryAction" class="btn btn-primary btn-sm" type="button"
            :aria-disabled="!canApply(preview)" @click="apply(replaceOnApply)">{{ primaryLabel }}</button>
          <button v-if="fragment && canReplace" class="btn btn-ghost btn-sm" type="button" :disabled="!canApply(buildEdit(true))" @click="apply(true)">替换镜头描述</button>
          <button v-if="appliedEdit" class="btn btn-ghost btn-sm" type="button" :disabled="disabled" @click="undo">撤销应用</button>
        </div>
        <p class="field-hint workbench-notice" role="status">{{ notice }}</p>
      </template>
    </div>
  </details>
</template>

<style scoped>
.video-prompt-workbench { container:video-prompt / inline-size; min-inline-size:0; border-block-start:1px solid var(--border-soft); padding-block-start:var(--s-2); }
.workbench-summary { padding:var(--s-2); margin-inline:calc(-1 * var(--s-2)); color:var(--text-primary); font-size:var(--fs-label); font-weight:600; cursor:pointer; }
.workbench-summary:focus-visible { outline:2px solid var(--text-secondary); outline-offset:2px; }
.workbench-summary > .archive-icon { color:var(--accent); }
.workbench-body, .workbench-preview { display:grid; gap:var(--s-3); }
.workbench-body { padding-block:var(--s-2); }
.workbench-group { min-inline-size:0; margin:0; padding:0; border:0; }
.workbench-group legend { padding:0; margin-block-end:var(--s-2); }
.workbench-group p, .workbench-preview p, .workbench-notice { margin:0; }
.workbench-group .workbench-parameter-hint { margin-block-start:var(--s-2); }
.workbench-presets { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,8.5rem),1fr)); gap:var(--s-2); margin-block-start:var(--s-2); }
.workbench-rating { margin-block-start:var(--s-2); }
.workbench-categories { flex-wrap:wrap; margin-block-start:var(--s-2); }
.workbench-preset-more { display:flex; justify-content:flex-start; margin-block-start:var(--s-2); }
.workbench-presets .btn { justify-content:flex-start; white-space:normal; text-align:start; }
.workbench-fields, .workbench-parameters { display:grid; gap:var(--s-3); }
.workbench-parameters { margin-block-start:var(--s-3); }
.workbench-fields textarea { min-block-size:4.75rem; }
.workbench-preview { gap:var(--s-2); }
.workbench-preview-heading, .workbench-actions { display:flex; flex-wrap:wrap; align-items:center; gap:var(--s-2); }
.workbench-preview-heading { justify-content:space-between; }
.workbench-preview textarea { background:var(--bg-base); }
.workbench-limit { color:var(--warning-text); }
@container video-prompt (min-width:26rem) {
  .workbench-fields, .workbench-parameters { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .workbench-fields > :last-child:nth-child(odd) { grid-column:1 / -1; }
}
</style>

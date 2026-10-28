<template>
  <section class="catalog-editor" aria-label="编写内容">
    <header class="catalog-editor-head"><span class="catalog-editor-kind"><ArchiveIcon :name="icon" /></span><div><p>{{ CATALOG_LABELS[record.kind] }}</p><h2>{{ title }}</h2></div><small v-if="!record.revision" class="catalog-new-badge">新内容</small></header>
    <template v-if="record.kind !== 'document'">
      <details v-for="section in sections" :key="section" class="catalog-writing-section" :open="defaultOpen(section) || forcedOpen.has(section)" @toggle="toggleSection(section, $event)">
        <StudioDisclosureSummary>{{ sectionLabel(section) }}</StudioDisclosureSummary>
        <div data-disclosure-content class="form-grid">
          <template v-if="defaultOpen(section) || revealedSections.has(section) || forcedOpen.has(section)">
          <label v-for="field in fields.filter(f => f.section === section && !technicalPaths.has(f.path) && !derivedPaths.has(f.path))" :key="field.path" class="form-group" :class="{ 'form-group-full': field.type === 'long' || field.type === 'list' }" :data-catalog-field="field.path">
            <span class="field-label">{{ field.label }}</span>
            <ToggleSwitch v-if="field.type === 'boolean'" :model-value="Boolean(fieldValue(record.data, field.path))" :label="field.label" :disabled="fieldsDisabled || locked(field.path)" @update:model-value="update(field, $event)" />
            <StudioSelect v-else-if="fieldOptions.get(field.path)?.length" :model-value="String(fieldValue(record.data, field.path) ?? '')" :label="field.label" :disabled="fieldsDisabled || locked(field.path)" :options="fieldOptions.get(field.path)" :aria-invalid="fieldError?.field === field.path || undefined" @update:model-value="update(field, String($event))" />
            <textarea v-else-if="field.type === 'long' || field.type === 'list'" class="input" :value="text(field)" :rows="field.path === 'story' || field.path === 'profile.bg_story' ? 7 : 4" :disabled="fieldsDisabled || locked(field.path)" :placeholder="placeholder(field)" :aria-invalid="fieldError?.field === field.path || undefined" @input="update(field, ($event.target as HTMLTextAreaElement).value)"></textarea>
            <input v-else class="input" :value="text(field)" :disabled="fieldsDisabled || locked(field.path)" :placeholder="placeholder(field)" :aria-invalid="fieldError?.field === field.path || undefined" @input="update(field, ($event.target as HTMLInputElement).value)" />
            <span v-if="field.type === 'list'" class="catalog-field-note">每行一项</span>
            <span v-if="field.path === 'rating'" class="catalog-field-note">成人内容标记随分级同步</span>
            <span v-if="field.path === 'sampleRating'" class="catalog-field-note">只影响样张展示，不改变绘制内容</span>
            <span v-if="field.path === 'outfitId' && outfitReadError" class="catalog-error" role="alert">服装列表暂时无法读取：{{ outfitReadError }}</span>
            <span v-if="fieldError?.field === field.path" class="catalog-error" role="alert">{{ fieldError.message }}</span>
          </label>
          </template>
        </div>
      </details>
    </template>
    <CatalogDocumentEditor v-else v-model:record="record" :disabled="fieldsDisabled" />
    <CatalogPromptPreview v-if="record.kind !== 'document' && !fieldValue(record.data, 'draftDefaultOutfit') && advanced === null" :record="record" :pending="pending" :dirty="dirty" />
    <details class="catalog-advanced catalog-management-info" :open="!record.revision">
      <StudioDisclosureSummary>管理信息</StudioDisclosureSummary>
      <div data-disclosure-content class="form-grid">
        <label class="form-group" data-catalog-field="id"><span class="field-label">内部编号</span><input v-model="record.id" class="input" :aria-invalid="fieldError?.field === 'id' || undefined" :aria-describedby="fieldError?.field === 'id' ? fieldErrorId : undefined" :disabled="!!record.revision || fieldsDisabled || record.kind === 'outfit'" /><span v-if="fieldError?.field === 'id'" :id="fieldErrorId" class="catalog-error" role="alert">{{ fieldError.message }}</span></label>
        <label class="form-group" data-catalog-field="sortOrder"><span class="field-label">{{ record.revision ? '排序（小值优先）' : '排序（0 为自动追加）' }}</span><input v-model.number="record.sortOrder" class="input" type="number" step="1" :aria-invalid="fieldError?.field === 'sortOrder' || undefined" :aria-describedby="fieldError?.field === 'sortOrder' ? fieldErrorId : undefined" :disabled="fieldsDisabled" /><span v-if="fieldError?.field === 'sortOrder'" :id="fieldErrorId" class="catalog-error" role="alert">{{ fieldError.message }}</span></label>
        <label v-for="field in fields.filter(f => technicalPaths.has(f.path))" :key="field.path" class="form-group"><span class="field-label">{{ field.label }}</span><textarea v-if="field.type === 'list'" class="input" rows="2" :value="text(field)" :disabled="fieldsDisabled || locked(field.path)" @input="update(field, ($event.target as HTMLTextAreaElement).value)"></textarea><input v-else class="input" :value="text(field)" :disabled="fieldsDisabled || locked(field.path)" @input="update(field, ($event.target as HTMLInputElement).value)" /></label>
      </div>
    </details>
    <details v-if="!systemDocument" class="catalog-advanced" data-catalog-field="advanced" :open="advancedOpen" @toggle="toggleAdvanced">
      <StudioDisclosureSummary>完整数据与扩展设置</StudioDisclosureSummary><div data-disclosure-content>
      <p v-if="advanced !== null" class="catalog-note" role="status">完整数据尚未应用。请应用或放弃这部分修改后继续填写普通字段；暂存和保存也会先检查这些数据。</p>
      <textarea v-if="advancedRevealed" :value="advancedText" class="input" rows="12" aria-label="完整内容数据" :aria-invalid="!!completeDataError" :aria-describedby="completeDataError ? 'catalog-advanced-error' : undefined" :disabled="disabled" @input="updateAdvanced"></textarea>
      <button v-if="advancedRevealed" class="btn btn-ghost btn-sm" type="button" :disabled="disabled || advanced === null" @click="emit('applyAdvanced', owner)">应用这些设置</button>
      <button v-if="advanced !== null" class="btn btn-quiet btn-sm" type="button" :disabled="disabled" @click="emit('discardAdvanced', owner)">放弃完整数据修改</button>
      <p v-if="completeDataError" id="catalog-advanced-error" role="alert" class="catalog-error">{{ completeDataError }}</p></div>
    </details>
    <p v-if="error" role="alert" class="catalog-error">{{ error }}</p>
    <p v-if="generated" class="catalog-note">这份内容来自已有画面。名称和说明可以修改，原来的生成描述会保留。</p>
    <footer class="catalog-editor-footer">
      <span v-if="systemDocument">系统资料 · 只读</span>
      <div class="catalog-actions">
        <button v-if="record.revision && record.kind !== 'document'" class="catalog-text-button" type="button" :disabled="fieldsDisabled" @click="$emit('remove')">归档</button>
        <button v-if="record.kind !== 'document' && !(record.kind === 'character' && fieldValue(record.data, 'popular'))" class="btn btn-ghost" type="button" :disabled="fieldsDisabled" @click="$emit('duplicate')">复制一份</button>
        <button class="btn btn-primary" type="button" :disabled="disabled || systemDocument || (!!error && advanced === null)" @click="$emit('stage')">暂存修改</button>
      </div>
    </footer>
  </section>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue'
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
import ArchiveIcon, { type ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import CatalogDocumentEditor from './CatalogDocumentEditor.vue'
import CatalogPromptPreview from './CatalogPromptPreview.vue'
import type { CatalogChange, CatalogRecord } from '@/api/catalogApi'
import { catalogApi } from '@/api/catalogApi'
import { CATALOG_FIELDS, fieldValue, setField, type CatalogField } from '@/composables/scene/catalogFields'
import { CATALOG_LABELS, recordTitle } from '@/composables/scene/catalogPresentation'
import type { CatalogFieldError } from '@/composables/scene/useCatalogMaintenance'
const props = defineProps<{ disabled: boolean; characterNames: Record<string, string>; pending: CatalogChange[]; dirty: boolean; advanced: string | null; advancedError: string; fieldError: CatalogFieldError | null; editorSession: number }>()
const fieldErrorId = `catalog-field-error-${useId()}`
const record = defineModel<CatalogRecord>('record', { required: true })
const emit = defineEmits<{ stage: []; duplicate: []; remove: []; fieldInput: []; advanced: [text: string, owner: number]; applyAdvanced: [owner: number]; discardAdvanced: [owner: number] }>()
const fields = computed(() => CATALOG_FIELDS[record.value.kind].filter(field => !field.path.startsWith('draftDefaultOutfit.') || !!fieldValue(record.value.data, 'draftDefaultOutfit'))), sections = computed(() => [...new Set(fields.value.map(f => f.section))])
const title = computed(() => recordTitle(record.value) === '未命名内容' ? '从这里开始写' : recordTitle(record.value))
const icon = computed<ArchiveIconName>(() => ({ character: 'character', outfit: 'image', scene: 'scene', blueprint: 'spark', document: 'manager' } as const)[record.value.kind])
const technicalPaths = new Set(['outfit.id', 'popular.exactTokens', 'popular.exactPrefixes', 'popular.supportedEngines', 'profile.portrait', 'compositionIntent', 'coverageTags'])
const derivedPaths = new Set(['mature'])
const error = ref(''), advancedRevealed = ref(props.advanced !== null), advancedOpen = ref(props.advanced !== null)
const owner = props.editorSession
let disposed = false
onBeforeUnmount(() => { disposed = true })
const fieldsDisabled = computed(() => props.disabled || props.advanced !== null)
const outfitChoices = ref<Array<{ value: string; label: string }>>([])
const outfitLoading = ref(false)
const outfitReadError = ref('')
watch(() => record.value.kind === 'blueprint' ? String(fieldValue(record.value.data, 'characterId') ?? '') : '', async (characterId, _previous, onCleanup) => {
  outfitChoices.value = []; outfitReadError.value = ''
  if (!characterId) return
  const controller = new AbortController()
  onCleanup(() => controller.abort())
  outfitLoading.value = true
  try {
    const first = await catalogApi.query({ kind: 'outfit', character: characterId, pageSize: 100 }, controller.signal)
    const rest = await Promise.all(Array.from({ length: Math.max(0, Math.ceil(first.total / 100) - 1) }, (_, index) =>
      catalogApi.query({ kind: 'outfit', character: characterId, page: index + 2, pageSize: 100 }, controller.signal)))
    if (!controller.signal.aborted) outfitChoices.value = [first, ...rest].flatMap(page => page.items).map(item => ({ value: item.id.split('/').slice(1).join('/'), label: item.title }))
  } catch (e) { if (!controller.signal.aborted) outfitReadError.value = (e as Error).message }
  finally { if (!controller.signal.aborted) outfitLoading.value = false }
}, { immediate: true })
const advancedText = computed(() => props.advanced ?? JSON.stringify(record.value.data, null, 2))
const completeDataError = computed(() => props.advancedError || (props.fieldError?.field === 'advanced' ? props.fieldError.message : ''))
function toggleAdvanced(event: Event) {
  advancedOpen.value = (event.target as HTMLDetailsElement).open
  if (advancedOpen.value) advancedRevealed.value = true
}
watch(() => [props.advanced, completeDataError.value], () => {
  if (props.advanced !== null || completeDataError.value) { advancedOpen.value = true; advancedRevealed.value = true }
})
function updateAdvanced(event: Event) {
  if (!disposed && !props.disabled) emit('advanced', (event.target as HTMLTextAreaElement).value, owner)
}
const revealedSections = ref(new Set<string>())
const forcedOpen = ref(new Set<string>())
watch(() => props.fieldError?.field, path => {
  const section = fields.value.find(field => field.path === path)?.section
  if (section) { revealedSections.value.add(section); forcedOpen.value.add(section) }
}, { immediate: true })
function toggleSection(section: string, event: Event) {
  if ((event.target as HTMLDetailsElement).open) revealedSections.value.add(section)
  else forcedOpen.value.delete(section)
}
const generated = computed(() => !!fieldValue(record.value.data, 'generatedRecipe'))
const systemDocument = computed(() => record.value.kind === 'document' && !['curation', 'tags', 'tag-dictionary-policy'].includes(record.value.id))
const locked = (path: string) => (record.value.kind === 'outfit' && record.value.revision > 0 && ['characterId', 'outfit.id'].includes(path))
  || (generated.value && !['title', 'description', 'story', 'storyJa', 'category'].includes(path))
const sectionLabel = (section: string) => ({ 人物档案: '人物的故事', 视觉设定: '外观与识别细节', 提示词身份: '绘制时使用的人物描述', 服装绑定: '这套服装', 服装内容: '绘制时使用的服装描述', 基础信息: '故事与说明', 场景事实: '画面中的细节', 引擎提示词: '绘制时使用的画面描述' } as Record<string, string>)[section] || section
const defaultOpen = (section: string) => ['人物档案', '视觉设定', '服装绑定', '基础信息', '首套服装'].includes(section)
  || section === '提示词身份' && !!fieldValue(record.value.data, 'draftDefaultOutfit')
function selectionOptions(field: CatalogField) {
  let options: Array<{ value: string; label: string }> = []
  if (['characterId', 'char'].includes(field.path)) options = field.path === 'char'
    ? [{ value: 'nene', label: '绫地宁宁' }, { value: 'natsume', label: '四季夏目' }, { value: 'triad', label: '宁宁与夏目' }]
    : Object.entries(props.characterNames).map(([value, label]) => ({ value, label }))
  else if (['rating', 'sampleRating'].includes(field.path)) options = [{ value: 'All', label: '全年龄' }, { value: 'R15', label: '十五岁以上' }, { value: 'R18', label: '成人内容' }]
  else if (field.path === 'outfitId' && record.value.kind === 'blueprint') options = [{ value: '', label: outfitLoading.value ? '正在读取服装…' : outfitReadError.value ? '服装读取失败' : '选择已有服装' }, ...outfitChoices.value]
  else if (field.path === 'popular.adultEligibility') options = [{ value: 'adult', label: '已成年' }, { value: 'unknown', label: '尚未确认' }, { value: 'underage', label: '未成年' }]
  else if (field.path === 'popular.recommendedEngine') options = [{ value: 'anima-miaomiao-v1.6', label: '动漫插画引擎' }, { value: 'krea2-turbo-fp8', label: '通用图像引擎' }]
  if (!options.length) return options
  const value = String(fieldValue(record.value.data, field.path) ?? '')
  if (value && !options.some(o => o.value === value)) options.unshift({ value, label: '当前使用的设置' })
  return options
}
const fieldOptions = computed(() => new Map(fields.value.map(field => [field.path, selectionOptions(field)])))
function text(field: CatalogField) {
  const value = fieldValue(record.value.data, field.path)
  return field.type === 'list' && Array.isArray(value) ? value.join('\n') : value && typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value ?? '')
}
function placeholder(field: CatalogField) {
  return ({ title: '为这一刻起个名字', story: '发生了什么？人物此刻在想什么？', description: '写下这份画面方案的想法', 'profile.bg_story': '她从哪里来，又经历过什么？', 'profile.name': '这个角色叫什么？', 'outfit.name': '给这套服装一个好记的名字', location: '故事发生在哪里？', action: '人物正在做什么？' } as Record<string, string>)[field.path] || ''
}
function update(field: CatalogField, input: string | boolean) {
  if (disposed || fieldsDisabled.value) return
  emit('fieldInput')
  error.value = ''
  try {
    const before = fieldValue(record.value.data, field.path)
    if (before && typeof before === 'object' && field.type !== 'list') {
      const value: unknown = JSON.parse(String(input))
      if (!value || typeof value !== 'object') throw new Error('这项信息需要保留原有结构')
      const paths = field.path.split('.'), leaf = paths.pop()!
      const target = fieldValue(record.value.data, paths.join('.')) as Record<string, unknown>
      target[leaf] = value
    } else setField(record.value.data, field, input)
    if (record.value.kind === 'blueprint' && field.path === 'characterId' && before !== input) (record.value.data as Record<string, unknown>).outfitId = ''
    if (record.value.kind === 'scene' && field.path === 'char') (record.value.data as Record<string, unknown>).character = input === 'triad' ? ['nene', 'natsume'] : [String(input)]
    if (record.value.kind === 'character' && field.path === 'popular.recommendedEngine') {
      const popular = fieldValue(record.value.data, 'popular') as Record<string, unknown>
      const supported = Array.isArray(popular.supportedEngines) ? popular.supportedEngines as string[] : []
      if (!supported.includes(String(input))) popular.supportedEngines = [...supported, String(input)]
    }
    if (record.value.kind === 'scene' && field.path === 'rating') (record.value.data as Record<string, unknown>).mature = input === 'R18'
    if (record.value.kind === 'outfit' && !record.value.revision) record.value.id = String(fieldValue(record.value.data, 'characterId') ?? '') + '/' + String(fieldValue(record.value.data, 'outfit.id') ?? '')
  } catch (e) { error.value = (e as Error).message }
}
// Staging or applying complete data supersedes this session's structured-field error.
watch([record, () => record.value.data], () => { error.value = '' })
</script>

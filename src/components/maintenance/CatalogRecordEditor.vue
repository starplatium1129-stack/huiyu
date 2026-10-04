<template>
  <section class="catalog-editor" aria-label="编写内容">
    <header class="catalog-editor-head"><span class="catalog-editor-kind"><ArchiveIcon :name="icon" /></span><div><p>{{ CATALOG_LABELS[record.kind] }}</p><h2>{{ title }}</h2><span>{{ instruction }}</span></div><small v-if="!record.revision" class="catalog-new-badge">新内容</small></header>
    <template v-if="record.kind !== 'document'">
      <details v-for="section in sections" :key="section" class="catalog-writing-section" :open="defaultOpen(section)">
        <summary><span>{{ sectionLabel(section) }}</span><ArchiveIcon name="chevron-down" /></summary>
        <div class="form-grid">
          <label v-for="field in fields.filter(f => f.section === section && !technicalPaths.has(f.path))" :key="field.path" class="form-group" :class="{ 'form-group-full': field.type === 'long' || field.type === 'list' }">
            <span class="field-label">{{ field.label }}</span>
            <ToggleSwitch v-if="field.type === 'boolean'" :model-value="Boolean(fieldValue(record.data, field.path))" :label="field.label" :disabled="disabled || locked(field.path)" @update:model-value="update(field, $event)" />
            <StudioSelect v-else-if="selectionOptions(field).length" :model-value="String(fieldValue(record.data, field.path) ?? '')" :label="field.label" :disabled="disabled || locked(field.path)" :options="selectionOptions(field)" @update:model-value="update(field, String($event))" />
            <textarea v-else-if="field.type === 'long' || field.type === 'list'" class="input" :value="text(field)" :rows="field.path === 'story' || field.path === 'profile.bg_story' ? 7 : 4" :disabled="disabled || locked(field.path)" :placeholder="placeholder(field)" @input="update(field, ($event.target as HTMLTextAreaElement).value)"></textarea>
            <input v-else class="input" :value="text(field)" :disabled="disabled || locked(field.path)" :placeholder="placeholder(field)" @input="update(field, ($event.target as HTMLInputElement).value)" />
            <span v-if="field.type === 'list'" class="catalog-field-note">每行写一项就好</span>
          </label>
        </div>
      </details>
    </template>
    <CatalogDocumentEditor v-else v-model:record="record" :disabled="disabled" />
    <details class="catalog-advanced catalog-management-info" :open="!record.revision">
      <summary>管理信息</summary>
      <div class="form-grid">
        <label class="form-group"><span class="field-label">内部编号</span><input v-model="record.id" class="input" :disabled="!!record.revision || disabled || record.kind === 'outfit'" /><span class="catalog-field-note">用于关联资料，已有编号保持不变</span></label>
        <label class="form-group"><span class="field-label">展示位置</span><input v-model.number="record.sortOrder" class="input" type="number" step="1" :disabled="disabled" /><span class="catalog-field-note">数字越小，在列表中越靠前</span></label>
        <label v-for="field in fields.filter(f => technicalPaths.has(f.path))" :key="field.path" class="form-group"><span class="field-label">{{ field.label }}</span><textarea v-if="field.type === 'list'" class="input" rows="2" :value="text(field)" :disabled="disabled || locked(field.path)" @input="update(field, ($event.target as HTMLTextAreaElement).value)"></textarea><input v-else class="input" :value="text(field)" :disabled="disabled || locked(field.path)" @input="update(field, ($event.target as HTMLInputElement).value)" /></label>
      </div>
    </details>
    <details v-if="!systemDocument" class="catalog-advanced">
      <summary>完整数据与扩展设置</summary>
      <p class="catalog-note">只在需要调整表单之外的信息时使用。</p>
      <textarea v-model="advanced" class="input" rows="12" aria-label="完整内容数据" :disabled="disabled"></textarea>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="disabled" @click="applyAdvanced">应用这些设置</button>
    </details>
    <p v-if="error" role="alert" class="catalog-error">{{ error }}</p>
    <p v-if="generated" class="catalog-note">这份内容来自已有画面。名称和说明可以修改，原来的生成描述会保留。</p>
    <footer class="catalog-editor-footer">
      <span>{{ systemDocument ? '这份资料由专门流程维护，可在这里查看' : '暂存后，可以继续整理其他内容' }}</span>
      <div class="catalog-actions">
        <button v-if="record.revision && record.kind !== 'document'" class="catalog-text-button" type="button" :disabled="disabled" @click="$emit('remove')">归档</button>
        <button v-if="record.kind !== 'document'" class="btn btn-ghost" type="button" :disabled="disabled" @click="$emit('duplicate')">复制一份</button>
        <button class="btn btn-primary" type="button" :disabled="disabled || systemDocument || !!error" @click="$emit('stage')">暂存修改</button>
      </div>
    </footer>
  </section>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
import ArchiveIcon, { type ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import CatalogDocumentEditor from './CatalogDocumentEditor.vue'
import type { CatalogRecord } from '@/api/catalogApi'
import { CATALOG_FIELDS, fieldValue, setField, type CatalogField } from '@/composables/scene/catalogFields'
import { CATALOG_LABELS, recordTitle } from '@/composables/scene/catalogPresentation'
const props = defineProps<{ disabled: boolean; characterNames: Record<string, string> }>()
const record = defineModel<CatalogRecord>('record', { required: true })
defineEmits<{ stage: []; duplicate: []; remove: [] }>()
const fields = computed(() => CATALOG_FIELDS[record.value.kind]), sections = computed(() => [...new Set(fields.value.map(f => f.section))])
const title = computed(() => recordTitle(record.value) === '未命名内容' ? '从这里开始写' : recordTitle(record.value))
const icon = computed<ArchiveIconName>(() => ({ character: 'character', outfit: 'image', scene: 'scene', blueprint: 'spark', document: 'manager' } as const)[record.value.kind])
const instruction = computed(() => ({ character: '写下人物的来历、性格与外观。', outfit: '留住这套服装的样子，之后就容易找到了。', scene: '故事从一个瞬间开始，画面细节也可以慢慢补全。', blueprint: '把脑海中的画面整理成一份创作方案。', document: '整理常用资料，让创作更容易继续。' } as const)[record.value.kind])
const technicalPaths = new Set(['outfit.id', 'popular.exactTokens', 'popular.exactPrefixes', 'popular.supportedEngines', 'profile.portrait', 'compositionIntent', 'coverageTags'])
const advanced = ref(''), error = ref('')
const generated = computed(() => !!fieldValue(record.value.data, 'generatedRecipe'))
const systemDocument = computed(() => record.value.kind === 'document' && !['curation', 'tags', 'tag-dictionary-policy'].includes(record.value.id))
const locked = (path: string) => (record.value.kind === 'outfit' && record.value.revision > 0 && ['characterId', 'outfit.id'].includes(path))
  || (generated.value && !['title', 'description', 'story', 'storyJa', 'category'].includes(path))
const sectionLabel = (section: string) => ({ 人物档案: '人物的故事', 视觉设定: '外观与识别细节', 提示词身份: '绘制时使用的人物描述', 服装绑定: '这套服装', 服装内容: '绘制时使用的服装描述', 基础信息: '故事与说明', 场景事实: '画面中的细节', 引擎提示词: '绘制时使用的画面描述' } as Record<string, string>)[section] || section
const defaultOpen = (section: string) => ['人物档案', '视觉设定', '服装绑定', '基础信息'].includes(section)
function selectionOptions(field: CatalogField) {
  const value = String(fieldValue(record.value.data, field.path) ?? '')
  let options: Array<{ value: string; label: string }> = []
  if (['characterId', 'char'].includes(field.path)) options = field.path === 'char'
    ? [{ value: 'nene', label: '绫地宁宁' }, { value: 'natsume', label: '四季夏目' }, { value: 'triad', label: '宁宁与夏目' }]
    : Object.entries(props.characterNames).map(([value, label]) => ({ value, label }))
  else if (['rating', 'sampleRating'].includes(field.path)) options = [{ value: 'All', label: '全年龄' }, { value: 'R15', label: '十五岁以上' }, { value: 'R18', label: '成人内容' }]
  else if (field.path === 'popular.adultEligibility') options = [{ value: 'adult', label: '已成年' }, { value: 'unknown', label: '尚未确认' }, { value: 'underage', label: '未成年' }]
  else if (field.path === 'popular.recommendedEngine') options = [{ value: 'anima-miaomiao-v1.6', label: '动漫插画引擎' }, { value: 'krea2-turbo-fp8', label: '通用图像引擎' }]
  if (options.length && value && !options.some(o => o.value === value)) options.unshift({ value, label: '当前使用的设置' })
  return options
}
function text(field: CatalogField) {
  const value = fieldValue(record.value.data, field.path)
  return field.type === 'list' && Array.isArray(value) ? value.join('\n') : value && typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value ?? '')
}
function placeholder(field: CatalogField) {
  return ({ title: '为这一刻起个名字', story: '发生了什么？人物此刻在想什么？', description: '写下这份画面方案的想法', 'profile.bg_story': '她从哪里来，又经历过什么？', 'profile.name': '这个角色叫什么？', 'outfit.name': '给这套服装一个好记的名字', location: '故事发生在哪里？', action: '人物正在做什么？' } as Record<string, string>)[field.path] || ''
}
function update(field: CatalogField, input: string | boolean) {
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
    if (record.value.kind === 'outfit' && !record.value.revision) record.value.id = String(fieldValue(record.value.data, 'characterId') ?? '') + '/' + String(fieldValue(record.value.data, 'outfit.id') ?? '')
  } catch (e) { error.value = (e as Error).message }
}
function applyAdvanced() {
  try { const value: unknown = JSON.parse(advanced.value); if (!value || typeof value !== 'object' || (Array.isArray(value) && record.value.kind !== 'document')) throw new Error('请填写有效的内容数据'); record.value.data = value as Record<string, unknown> | unknown[]; error.value = '' }
  catch (e) { error.value = (e as Error).message }
}
watch(() => record.value.data, value => { advanced.value = JSON.stringify(value, null, 2) }, { immediate: true, deep: true })
</script>

<template>
  <StudioDialog
    v-model:open="dialogOpen"
    :title="editing ? '编辑智能画册' : '新建智能画册'"
    subtitle="按角色和标签持续收集作品，符合条件的新作品会自动出现。"
    heading-level="h2"
    size="lg"
    :closedby="busy ? 'none' : 'any'"
    :show-close="!busy"
    close-label="关闭智能画册窗口"
    :character="rule.characterId === 'nene' || rule.characterId === 'natsume' ? rule.characterId : ''"
    dialog-class="smart-album-dialog"
  >
    <form :id="formId" class="smart-album-form" :aria-busy="busy" novalidate @submit.prevent="save">
      <div class="smart-album-body">
        <div class="smart-album-name"><label :for="nameId">画册名称</label><input :id="nameId" ref="nameInput" v-model="title" class="input" :maxlength="ARTWORK_PROJECT_TITLE_LIMIT" :disabled="busy" :aria-invalid="!!nameError || undefined" :aria-describedby="nameError ? nameErrorId : undefined" required autocomplete="off" placeholder="例如：夏目的春日精选" @blur="nameTouched = true" /><p v-if="nameError" :id="nameErrorId" class="smart-album-error" role="alert">{{ nameError }}</p></div>
        <div class="smart-album-fields">
          <div class="smart-album-field"><span>角色</span><StudioSelect v-model="rule.characterId" label="智能画册角色" :disabled="busy" :options="roleOptions" /></div>
          <div class="smart-album-field"><span>作品范围</span><StudioSelect v-model="rule.projectId" label="智能画册作品范围" :disabled="busy" :options="projectOptions" /></div>
        </div>
        <div class="smart-album-field">
          <span>整理与生成标签</span>
          <div class="smart-album-tag-picker"><StudioSelect v-model="tagChoice" label="添加画册标签" :disabled="busy || rule.tags.length >= 64" :options="availableTags" /><StudioSelect v-model="rule.tagMatch" label="标签匹配方式" :disabled="busy || rule.tags.length < 2" :options="[{value:'all',label:'同时符合全部标签'},{value:'any',label:'符合任一标签'}]" /></div>
          <div v-if="rule.tags.length" class="smart-album-tag-list" aria-label="已选画册标签">
            <button v-for="tag in rule.tags" :key="tag" class="btn btn-quiet btn-sm smart-album-tag" type="button" :disabled="busy" :aria-label="`移除标签：${tag}`" @click="rule.tags = rule.tags.filter(value => value !== tag)"><span class="studio-control-label">{{ tag }}</span><ArchiveIcon name="close" /></button>
          </div>
        </div>
        <div class="smart-album-fields">
          <label class="smart-album-field"><span>搜索关键词</span><input v-model="rule.search" class="input" maxlength="500" :disabled="busy" placeholder="可沿用作品搜索条件" /></label>
          <StudioCheckbox class="smart-album-favorite" :checked="rule.favoriteOnly" :disabled="busy" label="仅收录收藏的作品" @update:checked="rule.favoriteOnly = $event">仅收录收藏的作品</StudioCheckbox>
        </div>
        <section class="smart-album-preview" aria-label="符合条件的作品预览">
          <div class="smart-album-preview-copy"><strong role="status">{{ previewError ? '匹配数量待确认' : previewLoading ? '正在整理匹配作品…' : `当前匹配 ${count} 幅作品` }}</strong><p v-if="previewError" class="smart-album-note">作品读取未完成，请返回展墙重新读取。</p><p v-if="!previewLoading && !previewError && !count" class="smart-album-note">后续匹配作品自动加入</p></div>
          <div v-if="covers.length" class="smart-album-preview-images" aria-hidden="true"><span v-for="cover in covers" :key="cover.id"><img v-if="resolveRuntimeUrl(cover.src)" :src="resolveRuntimeUrl(cover.src)" :crossorigin="runtimeResourceCors()" alt="" /><ArchiveIcon v-else name="image" /></span></div>
        </section>
        <p v-if="error" class="smart-album-error" role="alert">{{ error }}</p>
      </div>
    </form>
    <template #footer="{ close }">
      <button class="btn btn-ghost" type="button" :disabled="busy" @click="close('')">取消</button>
      <button class="btn btn-primary" type="submit" :form="formId" :disabled="busy">{{ busy ? '正在保存…' : editing ? '更新智能画册' : '保存智能画册' }}</button>
    </template>
  </StudioDialog>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioDialog from '@/components/ui/StudioDialog.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioCheckbox from '@/components/ui/StudioCheckbox.vue'
import { ARTWORK_PROJECT_TITLE_LIMIT } from '@/application/artwork/projects'
import type { SmartAlbumRule } from '@/application/artwork/smartAlbums'
import type { GalleryProject } from '@/composables/gallery/galleryStorage'
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'

const props = defineProps<{ open: boolean; editing: boolean; busy: boolean; error: string; count: number; previewLoading: boolean; previewError: string;
  characters: { value: string; label: string }[]; tags: { value: string; label: string }[]; projects: GalleryProject[];
  covers: { id: string | number; src: string }[] }>()
const emit = defineEmits<{ 'update:open': [value: boolean]; save: [] }>()
const dialogOpen = computed({
  get: () => props.open,
  set: value => { if (!props.busy) emit('update:open', value) },
})
async function save() {
  if (props.busy) return
  nameTouched.value = true
  if (nameError.value) {
    await nextTick()
    nameInput.value?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
    nameInput.value?.focus({ preventScroll: true })
    return
  }
  emit('save')
}
const title = defineModel<string>('title', { required: true })
const rule = defineModel<SmartAlbumRule>('rule', { required: true })
const nameInput = ref<HTMLInputElement | null>(null), nameTouched = ref(false)
const nameId = useId()
const formId = `${nameId}-form`
const nameErrorId = `${nameId}-error`
const nameError = computed(() => {
  if (!nameTouched.value) return ''
  const trimmed = title.value.trim()
  if (!trimmed) return '请填写画册名称（不能为空）。'
  if (trimmed.length > ARTWORK_PROJECT_TITLE_LIMIT) {
    return `画册名称不能超过 ${ARTWORK_PROJECT_TITLE_LIMIT} 个字（当前 ${trimmed.length} 字），请缩减名称。`
  }
  return ''
})
watch(() => props.open, open => { if (open) nameTouched.value = false })
const roleOptions = computed(() => [{ value: '', label: '全部角色' }, ...props.characters,
  ...(rule.value.characterId && !props.characters.some(item => item.value === rule.value.characterId) ? [{ value: rule.value.characterId, label: rule.value.characterId }] : [])])
const projectOptions = computed(() => [{ value: '', label: '全部作品' }, ...props.projects.map(project => ({ value: project.id, label: project.title })),
  ...(rule.value.projectId && !props.projects.some(project => project.id === rule.value.projectId) ? [{ value: rule.value.projectId, label: '原画册已不存在' }] : [])])
const availableTags = computed(() => [{ value: '', label: '选择已有标签…' }, ...props.tags.filter(tag => !rule.value.tags.includes(tag.value) && tag.value.length <= 64)])
const tagChoice = computed({ get: () => '', set: (value: string | number) => {
  if (typeof value === 'string' && value && !rule.value.tags.includes(value)) rule.value.tags = [...rule.value.tags, value]
} })
</script>

<style scoped>
@reference "../../assets/css/tailwind.css";
.smart-album-form { min-width:0; min-height:0; container-type:inline-size; }
.smart-album-body { min-width:0; min-height:0; display:grid; gap:var(--s-4); }
.smart-album-field,.smart-album-name { display:grid; gap:var(--s-2); min-width:0; }
.smart-album-field > span,.smart-album-name > label { color:var(--text-secondary); font:600 var(--fs-label)/var(--lh-label) var(--font-sans); }
.smart-album-fields,.smart-album-tag-picker { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--s-3); align-items:end; }
.smart-album-tag-list { @apply tw:flex tw:flex-wrap tw:gap-s-2; }
.smart-album-tag { min-width:0; max-width:100%; text-align:left; white-space:normal; overflow-wrap:anywhere; border-color:var(--border-soft); }
.smart-album-tag .archive-icon { width:16px; height:16px; flex:none; }
.smart-album-note { @apply tw:m-0 tw:text-secondary tw:text-label-sm tw:leading-body; }
.smart-album-favorite { border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-base); }
.smart-album-preview { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:var(--s-3); padding:var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-base); }
.smart-album-preview-copy { min-width:0; }
.smart-album-preview strong { @apply tw:block tw:mb-s-1 tw:text-primary tw:text-body-sm; font-variant-numeric:tabular-nums; }
.smart-album-preview-images { @apply tw:flex tw:gap-s-1 tw:shrink-0; }
.smart-album-preview-images > span { @apply tw:grid tw:overflow-hidden tw:rounded-sm; place-items:center; width:48px; height:64px; background:var(--bg-elevated); color:var(--text-secondary); }
.smart-album-preview-images img { @apply tw:w-full tw:h-full tw:object-cover; }
.smart-album-error { @apply tw:m-0 tw:text-danger-text tw:text-label-sm; line-height:var(--lh-label); }
.smart-album-form button:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.smart-album-form button:disabled,.smart-album-form input:disabled { color:var(--text-disabled); }
@container (max-width:480px) { .smart-album-fields,.smart-album-tag-picker { grid-template-columns:minmax(0,1fr); } }
@media (forced-colors:active) { .smart-album-preview { border-color:CanvasText; background:Canvas; color:CanvasText; } }
</style>

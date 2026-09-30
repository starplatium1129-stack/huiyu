<template>
  <section v-if="active || canUndo || busy || message || error" class="gallery-organization" aria-label="整理所选作品">
    <div class="organization-actions">
      <button v-if="active" class="btn btn-ghost btn-sm" type="button" :disabled="!ids.length || busy" :aria-expanded="opened" @click="opened = !opened"><ArchiveIcon name="book" />整理画册与标签</button>
      <button v-if="canUndo" class="btn btn-ghost btn-sm" type="button" :disabled="busy" @click="undo"><ArchiveIcon name="refresh" />撤销本次整理</button>
      <button v-if="busy && !stopping" class="btn btn-ghost btn-sm" type="button" @click="stop">停止后续整理</button>
      <p v-if="message" role="status">{{ message }}</p>
    </div>
    <p v-if="error" class="organization-error" role="alert">{{ error }}</p>
    <form v-if="active && opened" class="organization-form" @submit.prevent="submit">
      <div class="organization-field"><span>画册归属</span><StudioSelect v-model="albumChoice" label="整理到画册" :disabled="busy" :options="albumOptions" /></div>
      <label class="organization-field"><span>添加整理标签</span><input v-model="addText" placeholder="例如：壁纸、春日系列" :disabled="busy" autocomplete="off" /></label>
      <label class="organization-field"><span>移除整理标签</span><input v-model="removeText" placeholder="标签用逗号分隔" :disabled="busy" autocomplete="off" /></label>
      <button class="btn btn-primary" type="submit" :disabled="busy || !ids.length || !hasChange || overLimit">{{ busy ? '正在保存…' : `整理 ${ids.length} 幅作品` }}</button>
      <p v-if="overLimit" class="organization-error organization-note" role="alert">一次最多整理 {{ ARTWORK_ORGANIZATION_SELECTION_LIMIT.toLocaleString('zh-CN') }} 幅作品，请分批选择以保留完整撤销记录。</p>
      <p class="organization-note">整理标签用于找图；作品的生成词条和配方保持原记录。加入一本画册会移出其他画册。</p>
    </form>
  </section>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import { useGalleryOrganization } from '@/composables/gallery/useGalleryOrganization'
import type { GalleryProject } from '@/composables/gallery/galleryStorage'
import { ARTWORK_ORGANIZATION_SELECTION_LIMIT, type ArtworkOrganizationId, type ArtworkOrganizationRequest } from '@/application/artwork/organization'
const props = defineProps<{ active: boolean; ids: ArtworkOrganizationId[]; projects: GalleryProject[] }>()
const emit = defineEmits<{ changed: [] }>()
const opened = ref(false), albumChoice = ref('keep'), addText = ref(''), removeText = ref('')
const { busy, stopping, message, error, canUndo, apply, undo, tagsFromInput, stop } = useGalleryOrganization({ ids: () => props.ids, changed: () => emit('changed') })
const albumOptions = computed(() => [{ value: 'keep', label: '保留当前画册' }, { value: 'remove', label: '移出所有画册' },
  ...props.projects.map(project => ({ value: `album:${project.id}`, label: project.title }))])
const hasChange = computed(() => albumChoice.value !== 'keep' || !!tagsFromInput(addText.value).length || !!tagsFromInput(removeText.value).length)
const overLimit = computed(() => props.ids.length > ARTWORK_ORGANIZATION_SELECTION_LIMIT)
async function submit() {
  const add = tagsFromInput(addText.value), remove = tagsFromInput(removeText.value)
  const input: Omit<ArtworkOrganizationRequest, 'ids'> = {}
  if (albumChoice.value === 'remove') input.projectId = null
  else if (albumChoice.value !== 'keep') {
    const project = props.projects.find(value => `album:${value.id}` === albumChoice.value)
    if (!project) { error.value = '画册已不存在，请重新选择'; return }
    input.projectId = project.recordId ?? project.id
  }
  if (add.length || remove.length) input.collectionTags = { add, remove }
  await apply(input)
}
</script>
<style scoped>
@reference "../../assets/css/tailwind.css";
.gallery-organization { @apply tw:w-full tw:min-w-0 tw:rounded-md; border:1px solid var(--border-soft); padding:var(--s-3); margin-bottom:var(--s-3); background:var(--bg-surface); }
.organization-actions { @apply tw:flex tw:items-center tw:flex-wrap tw:gap-s-2; }
.organization-actions p,.organization-note { @apply tw:m-0 tw:text-secondary tw:text-label-sm; }
.organization-form { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)) auto; align-items:end; gap:var(--s-3); margin-top:var(--s-3); }
.organization-field { @apply tw:grid tw:gap-s-1 tw:min-w-0 tw:text-primary tw:text-label-sm; }
.organization-field input { @apply tw:w-full tw:min-w-0 tw:rounded-md tw:text-primary; min-height:40px; border:1px solid var(--border-soft); background:var(--bg-surface); padding:var(--s-2) var(--s-3); font:inherit; }
.organization-field input::placeholder { color:var(--text-secondary); }
.organization-field input:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.organization-field input:disabled { color:var(--text-disabled); }
.organization-note { grid-column:1 / -1; line-height:var(--lh-body); }
.organization-error { @apply tw:text-warning-text tw:text-label-sm; margin:var(--s-2) 0 0; }
@media (max-width:1200px) { .organization-form { grid-template-columns:repeat(2,minmax(0,1fr)); } }
</style>

<template>
  <DialogRoot :open="open" @update:open="!busy && emit('update:open', $event)">
    <DialogPortal>
      <DialogOverlay class="smart-album-overlay" />
      <DialogContent class="smart-album-editor" :aria-busy="busy" @escape-key-down="busy && $event.preventDefault()" @pointer-down-outside="busy && $event.preventDefault()">
        <header class="smart-album-heading">
          <div><DialogTitle>{{ editing ? '编辑智能画册' : '新建智能画册' }}</DialogTitle><DialogDescription>按角色和标签持续收集作品，符合条件的新作品会自动出现。</DialogDescription></div>
          <DialogClose class="btn btn-ghost btn-sm" :disabled="busy" aria-label="关闭智能画册窗口"><ArchiveIcon name="close" /></DialogClose>
        </header>
        <form class="smart-album-form" @submit.prevent="emit('save')">
          <label class="smart-album-name"><span>画册名称</span><input v-model="title" class="input" :maxlength="ARTWORK_PROJECT_TITLE_LIMIT" :disabled="busy" required autocomplete="off" placeholder="例如：夏目的春日精选" /></label>
          <div class="smart-album-fields">
            <div class="smart-album-field"><span>角色</span><StudioSelect v-model="rule.characterId" label="智能画册角色" :disabled="busy" :options="roleOptions" /></div>
            <div class="smart-album-field"><span>作品范围</span><StudioSelect v-model="rule.projectId" label="智能画册作品范围" :disabled="busy" :options="projectOptions" /></div>
          </div>
          <div class="smart-album-field">
            <span>整理与生成标签</span>
            <div class="smart-album-tag-picker"><StudioSelect v-model="tagChoice" label="添加画册标签" :disabled="busy || rule.tags.length >= 64" :options="availableTags" /><StudioSelect v-model="rule.tagMatch" label="标签匹配方式" :disabled="busy || rule.tags.length < 2" :options="[{value:'all',label:'同时符合全部标签'},{value:'any',label:'符合任一标签'}]" /></div>
            <div v-if="rule.tags.length" class="smart-album-tag-list" aria-label="已选画册标签">
              <button v-for="tag in rule.tags" :key="tag" class="smart-album-tag" type="button" :disabled="busy" :aria-label="`移除标签：${tag}`" @click="rule.tags = rule.tags.filter(value => value !== tag)">{{ tag }}<ArchiveIcon name="close" /></button>
            </div>
            <p v-else class="smart-album-note">不选标签时，收录符合其他条件的全部作品。</p>
          </div>
          <div class="smart-album-fields">
            <label class="smart-album-field"><span>搜索关键词</span><input v-model="rule.search" class="input" maxlength="500" :disabled="busy" placeholder="可沿用作品搜索条件" /></label>
            <button class="smart-album-favorite" :class="{ active: rule.favoriteOnly }" type="button" :disabled="busy" :aria-pressed="rule.favoriteOnly" @click="rule.favoriteOnly = !rule.favoriteOnly"><ArchiveIcon name="love" />仅收录收藏的作品<ArchiveIcon v-if="rule.favoriteOnly" name="success" /></button>
          </div>
          <section class="smart-album-preview" aria-label="符合条件的作品预览">
            <div class="smart-album-preview-copy"><strong role="status">当前匹配 {{ count }} 幅作品</strong><p class="smart-album-note">{{ count ? '修改条件时预览同步更新。' : '画册可以先保存，之后符合条件的作品会自动加入。' }}</p></div>
            <div v-if="covers.length" class="smart-album-preview-images" aria-hidden="true"><span v-for="cover in covers" :key="cover.id"><img v-if="resolveRuntimeUrl(cover.src)" :src="resolveRuntimeUrl(cover.src)" :crossorigin="runtimeResourceCors()" alt="" /><ArchiveIcon v-else name="image" /></span></div>
          </section>
          <p v-if="error" class="smart-album-error" role="alert">{{ error }}</p>
          <footer class="smart-album-actions"><DialogClose class="btn btn-ghost" :disabled="busy">取消</DialogClose><button class="btn btn-primary" type="submit" :disabled="busy || !title.trim()">{{ busy ? '正在保存…' : editing ? '更新智能画册' : '保存智能画册' }}</button></footer>
        </form>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { DialogRoot, DialogPortal, DialogOverlay, DialogContent, DialogTitle, DialogDescription, DialogClose } from 'reka-ui'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import { ARTWORK_PROJECT_TITLE_LIMIT } from '@/application/artwork/projects'
import type { SmartAlbumRule } from '@/application/artwork/smartAlbums'
import type { GalleryProject } from '@/composables/gallery/galleryStorage'
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'

const props = defineProps<{ open: boolean; editing: boolean; busy: boolean; error: string; count: number;
  characters: { value: string; label: string }[]; tags: { value: string; label: string }[]; projects: GalleryProject[];
  covers: { id: string | number; src: string }[] }>()
const emit = defineEmits<{ 'update:open': [value: boolean]; save: [] }>()
const title = defineModel<string>('title', { required: true })
const rule = defineModel<SmartAlbumRule>('rule', { required: true })
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
.smart-album-overlay { @apply tw:fixed; inset:0; z-index:var(--z-overlay); background:var(--art-scrim); }
.smart-album-editor { @apply tw:fixed tw:rounded-xl tw:text-primary; top:50%; left:50%; transform:translate(-50%,-50%); z-index:var(--z-overlay); width:min(680px,calc(100vw - 48px)); max-height:calc(100vh - 48px); overflow:auto; padding:var(--s-5); border:1px solid var(--border-strong); background:var(--bg-surface); box-shadow:var(--shadow-lg); }
.smart-album-heading { @apply tw:flex tw:justify-between tw:items-start tw:gap-s-3; margin-bottom:var(--s-5); }
.smart-album-heading h2 { @apply tw:m-0 tw:text-primary tw:text-body-lg tw:font-semibold; }
.smart-album-heading p { @apply tw:text-secondary tw:text-label-sm tw:leading-body; margin:var(--s-2) 0 0; }
.smart-album-heading > button { @apply tw:shrink-0; }
.smart-album-form,.smart-album-field,.smart-album-name { @apply tw:grid tw:gap-s-2 tw:min-w-0; }
.smart-album-form { gap:var(--s-4); }
.smart-album-field > span,.smart-album-name > span { @apply tw:text-primary tw:text-label-sm; }
.smart-album-fields,.smart-album-tag-picker { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--s-3); align-items:end; }
.smart-album-tag-list { @apply tw:flex tw:flex-wrap tw:gap-s-2; }
.smart-album-tag { @apply tw:flex tw:items-center tw:gap-s-2 tw:rounded-pill tw:text-primary tw:text-label-sm tw:cursor-pointer; min-height:36px; padding:var(--s-1) var(--s-3); border:1px solid var(--border-strong); background:var(--bg-base); overflow-wrap:anywhere; }
.smart-album-tag .archive-icon { @apply tw:w-[14px] tw:h-[14px] tw:shrink-0; }
.smart-album-note { @apply tw:m-0 tw:text-secondary tw:text-label-sm tw:leading-body; }
.smart-album-favorite { @apply tw:flex tw:items-center tw:gap-s-2 tw:rounded-md tw:text-secondary tw:text-label-sm tw:cursor-pointer; min-height:40px; padding:var(--s-2) var(--s-3); border:1px solid var(--border-soft); background:var(--bg-base); }
.smart-album-favorite.active { color:var(--accent); border-color:var(--accent); background:var(--accent-soft); }
.smart-album-favorite .archive-icon { @apply tw:w-[16px] tw:h-[16px] tw:shrink-0; }
.smart-album-preview { @apply tw:flex tw:items-center tw:justify-between tw:gap-s-3 tw:rounded-md; padding:var(--s-3); border:1px solid var(--border-soft); background:var(--bg-base); }
.smart-album-preview strong { @apply tw:block tw:mb-s-1 tw:text-primary tw:text-body-sm; }
.smart-album-preview-images { @apply tw:flex tw:gap-s-1 tw:shrink-0; }
.smart-album-preview-images > span { @apply tw:grid tw:overflow-hidden tw:rounded-sm; place-items:center; width:48px; height:64px; background:var(--bg-elevated); color:var(--text-secondary); }
.smart-album-preview-images img { @apply tw:w-full tw:h-full tw:object-cover; }
.smart-album-actions { @apply tw:flex tw:justify-end tw:gap-s-2; }
.smart-album-error { @apply tw:m-0 tw:text-warning-text tw:text-label-sm; }
.smart-album-editor button:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
.smart-album-editor button:disabled,.smart-album-editor input:disabled { color:var(--text-disabled); }
/* StudioSelect portals to body; its popup belongs above this editor's overlay. */
:global(body:has(.smart-album-editor) .studio-select-content) { z-index:calc(var(--z-overlay) + 1); }
</style>

<template>
  <DialogRoot :open="open" @update:open="!busy && emit('update:open', $event)">
    <DialogPortal>
      <FluidTransition panel=".smart-album-editor">
      <div v-if="open">
      <div class="smart-album-overlay" aria-hidden="true" />
      <DialogContent force-mount class="smart-album-editor" aria-modal="true" :aria-busy="busy" @open-auto-focus="rememberTrigger" @close-auto-focus="restoreTrigger" @escape-key-down="busy && $event.preventDefault()" @pointer-down-outside="busy && $event.preventDefault()">
        <header class="smart-album-heading">
          <div><DialogTitle>{{ editing ? '编辑智能画册' : '新建智能画册' }}</DialogTitle><DialogDescription>按角色和标签持续收集作品，符合条件的新作品会自动出现。</DialogDescription></div>
          <DialogClose class="btn btn-quiet btn-icon" :disabled="busy" aria-label="关闭智能画册窗口"><ArchiveIcon name="close" /></DialogClose>
        </header>
        <form class="smart-album-form" @submit.prevent="emit('save')">
          <div class="smart-album-body">
            <label class="smart-album-name"><span>画册名称</span><input v-model="title" class="input" :maxlength="ARTWORK_PROJECT_TITLE_LIMIT" :disabled="busy" required autocomplete="off" placeholder="例如：夏目的春日精选" /></label>
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
              <div class="smart-album-preview-copy"><strong role="status">当前匹配 {{ count }} 幅作品</strong><p v-if="!count" class="smart-album-note">后续匹配作品自动加入</p></div>
              <div v-if="covers.length" class="smart-album-preview-images" aria-hidden="true"><span v-for="cover in covers" :key="cover.id"><img v-if="resolveRuntimeUrl(cover.src)" :src="resolveRuntimeUrl(cover.src)" :crossorigin="runtimeResourceCors()" alt="" /><ArchiveIcon v-else name="image" /></span></div>
            </section>
            <p v-if="error" class="smart-album-error" role="alert">{{ error }}</p>
          </div>
          <footer class="smart-album-actions"><DialogClose class="btn btn-ghost" :disabled="busy">取消</DialogClose><button class="btn btn-primary" type="submit" :disabled="busy || !title.trim()">{{ busy ? '正在保存…' : editing ? '更新智能画册' : '保存智能画册' }}</button></footer>
        </form>
      </DialogContent>
      </div>
      </FluidTransition>
    </DialogPortal>
  </DialogRoot>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { DialogRoot, DialogPortal, DialogContent, DialogTitle, DialogDescription, DialogClose } from 'reka-ui'
import { usePageScrollLock } from '@/composables/usePageScrollLock'
import FluidTransition from '@/components/visual/FluidTransition.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioCheckbox from '@/components/ui/StudioCheckbox.vue'
import { ARTWORK_PROJECT_TITLE_LIMIT } from '@/application/artwork/projects'
import type { SmartAlbumRule } from '@/application/artwork/smartAlbums'
import type { GalleryProject } from '@/composables/gallery/galleryStorage'
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'

const props = defineProps<{ open: boolean; editing: boolean; busy: boolean; error: string; count: number;
  characters: { value: string; label: string }[]; tags: { value: string; label: string }[]; projects: GalleryProject[];
  covers: { id: string | number; src: string }[] }>()
const emit = defineEmits<{ 'update:open': [value: boolean]; save: [] }>()
usePageScrollLock(() => props.open)
let trigger: HTMLElement | null = null
function rememberTrigger() { trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null }
function restoreTrigger(event: Event) {
  event.preventDefault()
  const active = document.activeElement
  if (!props.open && (active === document.body || event.target instanceof HTMLElement && event.target.contains(active))
    && trigger?.isConnected && !trigger.closest('[inert], [hidden]') && trigger.getClientRects().length
    && !document.querySelector('dialog:modal')) trigger.focus({ preventScroll: true })
}
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
.smart-album-overlay { position:fixed; inset:var(--desktop-chrome-height,0px) 0 0; z-index:var(--z-overlay); background:var(--art-scrim); transition:opacity var(--motion-control) var(--ease-out); }
.smart-album-editor { position:fixed; inset:var(--desktop-chrome-height,0px) 0 0; z-index:var(--z-overlay); width:min(680px,calc(100vw - 2 * var(--s-4))); height:fit-content; max-height:calc(100dvh - var(--desktop-chrome-height,0px) - 2 * var(--s-4)); margin:auto; padding:0; display:grid; grid-template-rows:auto minmax(0,1fr); overflow:hidden; container-type:inline-size; border:1px solid var(--border-soft); border-radius:var(--r-xl); color:var(--text-primary); background:var(--bg-surface); box-shadow:var(--shadow-lg); transition:opacity var(--motion-control) var(--ease-out),transform var(--motion-surface) var(--spring-soft); }
.smart-album-heading { display:flex; justify-content:space-between; align-items:start; gap:var(--s-3); padding:var(--s-3) var(--s-4); border-bottom:1px solid var(--border-soft); }
.smart-album-heading > div { min-width:0; }
.smart-album-heading h2 { margin:0; color:var(--text-primary); font:600 var(--fs-title-sm)/var(--lh-tight) var(--font-sans); }
.smart-album-heading p { color:var(--text-secondary); font:400 var(--fs-label)/var(--lh-body) var(--font-sans); margin:var(--s-2) 0 0; overflow-wrap:anywhere; }
.smart-album-heading > button { @apply tw:shrink-0; }
.smart-album-form { min-width:0; min-height:0; display:grid; grid-template-rows:minmax(0,1fr) auto; }
.smart-album-body { min-width:0; min-height:0; display:grid; gap:var(--s-4); padding:var(--s-4); overflow:auto; overscroll-behavior:contain; scroll-padding-block:var(--s-3); }
.smart-album-field,.smart-album-name { display:grid; gap:var(--s-2); min-width:0; }
.smart-album-field > span,.smart-album-name > span { color:var(--text-secondary); font:600 var(--fs-label)/var(--lh-label) var(--font-sans); }
.smart-album-fields,.smart-album-tag-picker { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--s-3); align-items:end; }
.smart-album-tag-list { @apply tw:flex tw:flex-wrap tw:gap-s-2; }
.smart-album-tag { min-width:0; max-width:100%; text-align:left; white-space:normal; overflow-wrap:anywhere; border-color:var(--border-soft); }
.smart-album-tag .archive-icon { width:16px; height:16px; flex:none; }
.smart-album-note { @apply tw:m-0 tw:text-secondary tw:text-label-sm tw:leading-body; }
.smart-album-favorite { border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-base); }
.smart-album-preview { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:var(--s-3); padding:var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-base); }
.smart-album-preview-copy { min-width:0; }
.smart-album-preview strong { @apply tw:block tw:mb-s-1 tw:text-primary tw:text-body-sm; }
.smart-album-preview-images { @apply tw:flex tw:gap-s-1 tw:shrink-0; }
.smart-album-preview-images > span { @apply tw:grid tw:overflow-hidden tw:rounded-sm; place-items:center; width:48px; height:64px; background:var(--bg-elevated); color:var(--text-secondary); }
.smart-album-preview-images img { @apply tw:w-full tw:h-full tw:object-cover; }
.smart-album-actions { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:var(--s-2); padding:var(--s-3) var(--s-4); border-top:1px solid var(--border-soft); }
.smart-album-error { @apply tw:m-0 tw:text-warning-text tw:text-label-sm; }
.smart-album-editor button:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.smart-album-editor button:disabled,.smart-album-editor input:disabled { color:var(--text-disabled); }
@container (max-width:480px) { .smart-album-fields,.smart-album-tag-picker { grid-template-columns:minmax(0,1fr); } }
@media (prefers-reduced-motion:reduce) { :root:not([data-motion='full']) :is(.smart-album-editor,.smart-album-overlay) { animation:none; transition:none; } }
:root:is([data-motion='reduce'],[data-motion='reduced'],[data-reduced-motion='true']) :is(.smart-album-editor,.smart-album-overlay) { animation:none; transition:none; }
@media (forced-colors:active) { .smart-album-editor,.smart-album-preview { border-color:CanvasText; background:Canvas; color:CanvasText; box-shadow:none; } }
</style>

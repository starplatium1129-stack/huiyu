<script setup lang="ts">
import { ref, toRef, watch, defineAsyncComponent } from 'vue'
import type { ArtworkRecord } from '@/types/artwork'
import type { ResultSnapshot } from '@/composables/prompt/promptResultSnapshot'
import { useResultShelf } from '@/composables/prompt/useResultShelf'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import RuntimeImage from '@/components/visual/RuntimeImage.vue'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import ZoomableImageViewer from '@/components/visual/ZoomableImageViewer.vue'
const ImageSplitCompare = defineAsyncComponent(() => import('@/components/visual/ImageSplitCompare.vue'))
const props = defineProps<{ history: ArtworkRecord[]; previous?: ResultSnapshot | null; currentUrl: string; busy: boolean }>()
const emit = defineEmits<{ preview: [active: boolean]; resume: [entry: ArtworkRecord]; saved: [] }>()
const { category, items, selected, selectedKey, thumbnails, previewUrl, loading, error, retry } = useResultShelf(toRef(props, 'history'), toRef(props, 'previous'))
const comparing = ref(false), saving = ref(false), message = ref(''), savedKeys = ref(new Set<string>())
const returnButton = ref<HTMLButtonElement | null>(null)
watch(selectedKey, () => { comparing.value = false; message.value = ''; emit('preview', Boolean(selected.value)) })
watch(selected, value => { if (!value) { selectedKey.value = ''; emit('preview', false) } })
function returnToCurrent() { selectedKey.value = ''; returnButton.value?.focus({ preventScroll: true }) }
async function saveCandidate() {
  const item = selected.value
  if (!item?.taskId || saving.value) return
  saving.value = true
  try {
    const { archiveTaskResult } = await import('@/composables/tasks/taskArtwork')
    await archiveTaskResult(item.taskId, item.index)
    savedKeys.value.add(item.key); emit('saved')
    if (selectedKey.value === item.key) message.value = '已存入作品册'
  } catch (cause) { if (selectedKey.value === item.key) message.value = cause instanceof Error ? cause.message : '保存失败，请重试' }
  finally { saving.value = false }
}
</script>

<template>
  <section class="result-shelf tw:mt-s-3 tw:min-w-0 tw:rounded-lg tw:p-s-3" aria-label="结果选片" @keydown.esc.stop="returnToCurrent">
    <div v-if="selected" class="shelf-preview tw:pb-s-3 tw:mb-s-3">
      <header><div><small>{{ selected.kind === 'history' ? '历史作品预览' : '候选预览' }}</small><h3>{{ selected.title }}</h3></div><button class="btn btn-ghost" type="button" @click="returnToCurrent"><ArchiveIcon name="close" />返回当前画布</button></header>
      <p v-if="loading" class="shelf-state tw:min-h-[220px] tw:grid tw:text-secondary" role="status">正在读取原图…</p>
      <div v-else-if="error" class="shelf-state tw:min-h-[220px] tw:grid tw:text-secondary" role="alert"><p>{{ error }}</p><button class="btn btn-ghost" type="button" @click="retry++">重新读取</button></div>
      <ImageSplitCompare v-else-if="comparing && previewUrl && currentUrl" :before-src="previewUrl" :after-src="currentUrl" before-label="选中作品" after-label="当前成片" />
      <ZoomableImageViewer v-else-if="previewUrl" :src="previewUrl" :alt="selected.title" />
      <div class="shelf-actions tw:flex tw:flex-wrap tw:gap-s-2 tw:mt-s-3">
        <button v-if="currentUrl && previewUrl" class="btn btn-ghost" type="button" :aria-pressed="comparing" @click="comparing = !comparing">{{ comparing ? '退出对比' : '与当前成片对比' }}</button>
        <button v-if="selected.kind === 'task'" class="btn btn-primary" type="button" :disabled="saving || savedKeys.has(selected.key) || !previewUrl" @click="saveCandidate">{{ savedKeys.has(selected.key) ? '已入册' : saving ? '正在入册…' : '存入作品册' }}</button>
        <button v-if="selected.entry" class="btn btn-primary" type="button" :disabled="busy" @click="emit('resume', selected.entry); returnToCurrent()">沿用这幅配方</button>
        <span v-if="message" role="status">{{ message }}</span>
      </div>
      <p class="shelf-note">仅预览图片，当前创作参数保持不变。</p>
    </div>
    <header class="shelf-heading"><div class="shelf-tabs tw:relative tw:isolate tw:flex tw:p-s-1 tw:rounded-md" role="group" aria-label="结果来源"><AnimatedSelection /><button type="button" :aria-pressed="category === 'candidates'" @click="category = 'candidates'">候选成片</button><button type="button" :aria-pressed="category === 'history'" @click="category = 'history'">最近作品</button></div><RouterLink to="/gallery">打开作品册</RouterLink></header>
    <div class="shelf-strip tw:flex tw:gap-s-2 tw:overflow-x-auto" role="group" aria-label="选择预览图片">
      <button ref="returnButton" type="button" class="shelf-thumb tw:min-w-0 tw:p-s-1 tw:rounded-md tw:text-primary tw:cursor-pointer" :aria-pressed="!selected" aria-label="当前画布" @click="selectedKey = ''"><span class="shelf-picture tw:grid tw:h-[74px] tw:overflow-hidden tw:rounded-sm tw:text-secondary"><RuntimeImage v-if="currentUrl" :src="currentUrl" alt="当前成片" /><ArchiveIcon v-else name="image" /></span><strong>当前画布</strong></button>
      <button v-for="item in items" :key="item.key" type="button" class="shelf-thumb tw:min-w-0 tw:p-s-1 tw:rounded-md tw:text-primary tw:cursor-pointer" :aria-pressed="selectedKey === item.key" :aria-label="`预览：${item.title}`" @click="selectedKey = item.key"><span class="shelf-picture tw:grid tw:h-[74px] tw:overflow-hidden tw:rounded-sm tw:text-secondary"><RuntimeImage :src="thumbnails[item.key]" :alt="item.title"><template #fallback><ArchiveIcon name="image" /></template></RuntimeImage></span><strong>{{ item.title }}</strong></button>
    </div>
    <p v-if="!items.length" class="shelf-note">{{ category === 'history' ? '入册后的作品会出现在这里。' : '生成后的候选会出现在这里；桌面任务结果保留在收件箱。' }}</p>
  </section>
</template>

<style scoped>
@reference "../../assets/css/tailwind.css";
.result-shelf { border:1px solid var(--border-soft); background:var(--bg-surface); }
.shelf-heading,.shelf-preview header { @apply tw:flex tw:items-center tw:justify-between tw:gap-s-2 tw:flex-wrap; }
.shelf-heading a { @apply tw:text-secondary tw:text-label-xs; }
.shelf-tabs { background:var(--bg-base); }
.shelf-tabs button { @apply tw:relative; z-index:var(--z-raised); @apply tw:min-h-[40px]; padding:0 var(--s-3); border:0; background:transparent; @apply tw:text-secondary; font:inherit; @apply tw:text-label-sm tw:cursor-pointer; }
.shelf-tabs button[aria-pressed='true'] { @apply tw:text-accent; }
.shelf-strip { padding:var(--s-3) var(--s-1); overscroll-behavior-x:contain; }
.shelf-thumb { flex:0 0 104px; border:1px solid var(--border-soft); background:var(--bg-base); transition:transform var(--motion-hover); }
.shelf-thumb[aria-pressed='true'] { @apply tw:border-accent; box-shadow:inset 0 0 0 1px var(--accent); }
.shelf-picture { place-items:center; background:var(--bg-elevated); }
.shelf-picture :deep(img) { @apply tw:w-full tw:h-[74px] tw:object-contain; }
.shelf-thumb strong { @apply tw:block tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap tw:mt-s-2; font:500 var(--fs-label-xs) var(--font-sans); }
.result-shelf button:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.shelf-preview { border-bottom:1px solid var(--border-soft); }
.shelf-preview small,.shelf-note { @apply tw:text-secondary tw:text-label-xs tw:leading-body; }
.shelf-preview h3 { margin:var(--s-1) 0 var(--s-3); @apply tw:text-primary tw:text-body; overflow-wrap:anywhere; }
.shelf-preview :deep(.zoomable-image-viewer) { height:clamp(240px,36vh,440px); @apply tw:min-h-[240px]; }
.shelf-preview :deep(.zoomable-img) { @apply tw:max-h-[36vh]; }
.shelf-preview :deep(.zoom-hint) { @apply tw:hidden; }
.shelf-state { align-content:center; justify-items:center; }
.shelf-actions button:disabled { @apply tw:text-disabled; }
@media(hover:hover) and (pointer:fine) { .shelf-thumb:hover { transform:translateY(-2px); } }
@media(prefers-reduced-motion:reduce) { .shelf-thumb { transition:none; } }
</style>

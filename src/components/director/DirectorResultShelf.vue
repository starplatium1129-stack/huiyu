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
  <section class="result-shelf" aria-label="结果选片" @keydown.esc.stop="returnToCurrent">
    <div v-if="selected" class="shelf-preview">
      <header><div><small>{{ selected.kind === 'history' ? '历史作品预览' : '候选预览' }}</small><h3>{{ selected.title }}</h3></div><button class="btn btn-ghost" type="button" @click="returnToCurrent"><ArchiveIcon name="close" />返回当前画布</button></header>
      <p v-if="loading" class="shelf-state" role="status">正在读取原图…</p>
      <div v-else-if="error" class="shelf-state" role="alert"><p>{{ error }}</p><button class="btn btn-ghost" type="button" @click="retry++">重新读取</button></div>
      <ImageSplitCompare v-else-if="comparing && previewUrl && currentUrl" :before-src="previewUrl" :after-src="currentUrl" before-label="选中作品" after-label="当前成片" />
      <ZoomableImageViewer v-else-if="previewUrl" :src="previewUrl" :alt="selected.title" />
      <div class="shelf-actions">
        <button v-if="currentUrl && previewUrl" class="btn btn-ghost" type="button" :aria-pressed="comparing" @click="comparing = !comparing">{{ comparing ? '退出对比' : '与当前成片对比' }}</button>
        <button v-if="selected.kind === 'task'" class="btn btn-primary" type="button" :disabled="saving || savedKeys.has(selected.key) || !previewUrl" @click="saveCandidate">{{ savedKeys.has(selected.key) ? '已入册' : saving ? '正在入册…' : '存入作品册' }}</button>
        <button v-if="selected.entry" class="btn btn-primary" type="button" :disabled="busy" @click="emit('resume', selected.entry); returnToCurrent()">沿用这幅配方</button>
        <span v-if="message" role="status">{{ message }}</span>
      </div>
      <p class="shelf-note">仅预览图片，当前创作参数保持不变。</p>
    </div>
    <header class="shelf-heading"><div class="shelf-tabs" role="group" aria-label="结果来源"><AnimatedSelection /><button type="button" :aria-pressed="category === 'candidates'" @click="category = 'candidates'">候选成片</button><button type="button" :aria-pressed="category === 'history'" @click="category = 'history'">最近作品</button></div><RouterLink to="/gallery">打开作品册</RouterLink></header>
    <div class="shelf-strip" role="group" aria-label="选择预览图片">
      <button ref="returnButton" type="button" class="shelf-thumb" :aria-pressed="!selected" aria-label="当前画布" @click="selectedKey = ''"><span class="shelf-picture"><RuntimeImage v-if="currentUrl" :src="currentUrl" alt="当前成片" /><ArchiveIcon v-else name="image" /></span><strong>当前画布</strong></button>
      <button v-for="item in items" :key="item.key" type="button" class="shelf-thumb" :aria-pressed="selectedKey === item.key" :aria-label="`预览：${item.title}`" @click="selectedKey = item.key"><span class="shelf-picture"><RuntimeImage :src="thumbnails[item.key]" :alt="item.title"><template #fallback><ArchiveIcon name="image" /></template></RuntimeImage></span><strong>{{ item.title }}</strong></button>
    </div>
    <p v-if="!items.length" class="shelf-note">{{ category === 'history' ? '入册后的作品会出现在这里。' : '生成后的候选会出现在这里；桌面任务结果保留在收件箱。' }}</p>
  </section>
</template>

<style scoped>
.result-shelf { margin-top:var(--s-3); min-width:0; border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-surface); padding:var(--s-3); }
.shelf-heading,.shelf-preview header { display:flex; align-items:center; justify-content:space-between; gap:var(--s-2); flex-wrap:wrap; }
.shelf-heading a { color:var(--text-secondary); font-size:var(--fs-label-xs); }
.shelf-tabs { position:relative; isolation:isolate; display:flex; padding:var(--s-1); border-radius:var(--r-md); background:var(--bg-base); }
.shelf-tabs button { position:relative; z-index:var(--z-raised); min-height:40px; padding:0 var(--s-3); border:0; background:transparent; color:var(--text-secondary); font:inherit; font-size:var(--fs-label-sm); cursor:pointer; }
.shelf-tabs button[aria-pressed='true'] { color:var(--accent); }
.shelf-strip { display:flex; gap:var(--s-2); padding:var(--s-3) var(--s-1); overflow-x:auto; overscroll-behavior-x:contain; }
.shelf-thumb { flex:0 0 104px; min-width:0; padding:var(--s-1); border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-base); color:var(--text-primary); cursor:pointer; transition:transform var(--motion-hover); }
.shelf-thumb[aria-pressed='true'] { border-color:var(--accent); box-shadow:inset 0 0 0 1px var(--accent); }
.shelf-picture { display:grid; place-items:center; height:74px; overflow:hidden; border-radius:var(--r-sm); background:var(--bg-elevated); color:var(--text-secondary); }
.shelf-picture :deep(img) { width:100%; height:74px; object-fit:contain; }
.shelf-thumb strong { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-top:var(--s-2); font:500 var(--fs-label-xs) var(--font-sans); }
.result-shelf button:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.shelf-preview { padding-bottom:var(--s-3); margin-bottom:var(--s-3); border-bottom:1px solid var(--border-soft); }
.shelf-preview small,.shelf-note { color:var(--text-secondary); font-size:var(--fs-label-xs); line-height:var(--lh-body); }
.shelf-preview h3 { margin:var(--s-1) 0 var(--s-3); color:var(--text-primary); font-size:var(--fs-body); overflow-wrap:anywhere; }
.shelf-preview :deep(.zoomable-image-viewer) { height:clamp(240px,36vh,440px); min-height:240px; }
.shelf-preview :deep(.zoomable-img) { max-height:36vh; }
.shelf-preview :deep(.zoom-hint) { display:none; }
.shelf-state { min-height:220px; display:grid; align-content:center; justify-items:center; color:var(--text-secondary); }
.shelf-actions { display:flex; flex-wrap:wrap; gap:var(--s-2); margin-top:var(--s-3); }
.shelf-actions button:disabled { color:var(--text-disabled); }
@media(hover:hover) and (pointer:fine) { .shelf-thumb:hover { transform:translateY(-2px); } }
@media(prefers-reduced-motion:reduce) { .shelf-thumb { transition:none; } }
</style>

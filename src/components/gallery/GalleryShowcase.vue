<template>
  <Teleport to="body">
    <dialog ref="dialog" class="gallery-showcase" aria-labelledby="showcase-title" aria-describedby="showcase-help"
      @cancel.prevent="close" @keydown="onKeydown">
      <header class="showcase-heading">
        <div><p class="showcase-kicker">HUIYU / COLLECTION</p><h2 id="showcase-title">{{ title }}</h2></div>
        <button class="btn btn-ghost btn-sm" type="button" autofocus @click="close"><ArchiveIcon name="close" />返回画册</button>
      </header>
      <div class="showcase-stage">
        <button v-for="entry in neighbors" :key="entry.item.id" class="showcase-work" type="button"
          :data-side="entry.offset" :aria-label="entry.offset ? `${entry.offset < 0 ? '上一幅' : '下一幅'}：${label(entry.item)}` : label(entry.item)"
          :aria-current="entry.offset === 0 ? 'true' : undefined" @click="move(entry.offset)">
          <img v-if="source(entry.item) && !failed.has(source(entry.item))" :src="resolveRuntimeUrl(source(entry.item))"
            :crossorigin="runtimeResourceCors()" :alt="label(entry.item)" decoding="async" referrerpolicy="no-referrer"
            @error="failed.add(source(entry.item))" />
          <span v-else class="showcase-placeholder"><ArchiveIcon name="image" />{{ loading ? '正在读取作品' : '图片暂不可用' }}</span>
        </button>
      </div>
      <footer class="showcase-footer">
        <div class="showcase-caption" aria-live="polite" aria-atomic="true"><h3>{{ current ? label(current) : '没有可展示的作品' }}</h3><p>{{ index + 1 }} / {{ items.length }}</p></div>
        <nav class="showcase-navigation" aria-label="切换展示作品">
          <button class="btn btn-ghost" type="button" aria-label="上一幅" :disabled="index <= 0" @click="move(-1)"><ArchiveIcon name="chevron-down" class="showcase-prev" /></button>
          <p id="showcase-help">← → 切换 · Esc 返回</p>
          <button class="btn btn-ghost" type="button" aria-label="下一幅" :disabled="index >= items.length - 1" @click="move(1)"><ArchiveIcon name="chevron-down" class="showcase-next" /></button>
        </nav>
      </footer>
    </dialog>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onDeactivated, onMounted, onUnmounted, ref, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { useFluidDialog } from '@/composables/useFluidDialog'
import { useCandidateMedia } from '@/composables/gallery/useCandidateMedia'
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'
import type { ArtworkRecord } from '@/types/artwork'

const props = defineProps<{ items: ArtworkRecord[]; title: string; cardUrls: Record<string, string>; thumbUrls: Record<string, string> }>()
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement | null>(null)
const motion = useFluidDialog(dialog)
const { urls, loading, load, cancel, release } = useCandidateMedia()
const index = ref(0), failed = ref(new Set<string>())
const current = computed(() => props.items[index.value])
const neighbors = computed(() => [-1, 0, 1].flatMap(offset => {
  const item = props.items[index.value + offset]
  return item ? [{ item, offset }] : []
}))
const label = (item: ArtworkRecord) => item.sceneTitle || item.scene || '未命名作品'
const source = (item: ArtworkRecord) => props.cardUrls[item.id] || urls[item.id] || props.thumbUrls[item.id] || ''
let closing = false
function move(offset: number) {
  if (!closing) index.value = Math.max(0, Math.min(props.items.length - 1, index.value + offset))
}
function close() {
  if (closing) return
  closing = true; cancel()
  motion.close(() => { release(); emit('close') })
}
function onKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault(); event.stopPropagation(); move(event.key === 'ArrowLeft' ? -1 : 1)
  }
}
watch(() => props.items, () => {
  if (!props.items.length) close()
  else index.value = Math.min(index.value, props.items.length - 1)
})
watch(() => neighbors.value.map(({ item }) => [item.id, item.image_id, item.image_url, item.image_data, props.cardUrls[item.id]]), () => {
  if (!closing) { failed.value.clear(); load(neighbors.value.map(entry => entry.item).filter(item => !props.cardUrls[item.id])) }
}, { immediate: true })
onMounted(() => motion.open())
onDeactivated(() => { closing = true; release(); emit('close') })
onUnmounted(release)
</script>

<style scoped>
@reference "../../assets/css/tailwind.css";
.gallery-showcase { width:min(1640px,calc(100vw - 32px)); height:calc(100dvh - 32px); max-width:none; max-height:none; margin:auto; padding:var(--s-4) var(--s-5); border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-base); color:var(--text-primary); overflow:hidden; }
.gallery-showcase[open] { display: flex; flex-direction: column; }
.gallery-showcase::backdrop { background: var(--art-scrim); }
.showcase-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--s-3); position: relative; z-index: 2; }
.showcase-kicker { margin:0 0 var(--s-1); color:var(--text-secondary); font:500 var(--fs-mono-xs) var(--font-mono); letter-spacing:.1em; }
.showcase-heading h2 { margin: 0; @apply tw:text-title-xs; }
.showcase-stage { position:relative; flex:1; min-height:0; margin:var(--s-4) 0; isolation:isolate; }
.showcase-work { position:absolute; inset:0 14%; display:flex; align-items:center; justify-content:center; padding:var(--s-2); border:1px solid var(--border-soft); border-radius:var(--r-sm); background:var(--art-mat); color:var(--on-art-secondary); transition:transform var(--motion-route) var(--ease-out),opacity var(--motion-route) var(--ease-out); cursor:default; z-index:2; }
.showcase-work[data-side="-1"] { transform:translateX(-68%) scale(.76); opacity:.5; z-index:1; cursor:pointer; }
.showcase-work[data-side="1"] { transform:translateX(68%) scale(.76); opacity:.5; z-index:1; cursor:pointer; }
.showcase-work img { width: 100%; height: 100%; object-fit: contain; border-radius: var(--r-sm); }
.showcase-work:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
.showcase-placeholder { display: flex; flex-direction: column; align-items: center; gap: var(--s-3); }
.showcase-footer { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:var(--s-3); padding-top:var(--s-3); border-top:1px solid var(--border-soft); }
.showcase-caption { min-width:0; text-align:left; }
.showcase-caption h3 { margin: 0; @apply tw:text-body-sm; overflow-wrap: anywhere; }
.showcase-caption p, .showcase-navigation p { margin: var(--s-2) 0; color: var(--text-secondary); @apply tw:text-label-sm; }
.showcase-navigation { display:flex; justify-content:center; align-items:center; gap:var(--s-3); }
.showcase-prev { transform: rotate(90deg); }
.showcase-next { transform: rotate(-90deg); }
@media (max-width:900px) { .gallery-showcase { padding:var(--s-3); } .showcase-work { inset-inline:8%; } .showcase-work[data-side="-1"] { transform:translateX(-74%) scale(.7); } .showcase-work[data-side="1"] { transform:translateX(74%) scale(.7); } }
@media (prefers-reduced-motion: reduce) { .showcase-work { transition: none; } }
:root:is([data-motion='reduce'],[data-motion='reduced']) .showcase-work { transition:none; }
</style>

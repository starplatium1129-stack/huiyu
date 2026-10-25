<template>
  <span class="manga-launcher">
    <button class="btn" :class="variant === 'row' ? 'btn-quiet image-tool-action' : 'btn-ghost'" type="button" :disabled="disabled" :aria-busy="loading" @click="open">
      <ArchiveIcon name="book" /><span>{{ loading ? '打开中…' : loadError ? '重试打开漫画化' : '漫画化' }}</span>
      <ArchiveIcon v-if="variant === 'row'" name="chevron-down" class="image-tool-chevron" />
    </button>
    <span v-if="loadError" class="manga-launcher-error" role="alert">面板加载失败，请重试。</span>
    <component :is="panel" v-if="shown && panel" :source-url="capturedUrl" :artwork="capturedArtwork" :opener="opener" @closed="shown = false" @saved="emit('saved')" />
  </span>
</template>
<script setup lang="ts">
import { onDeactivated, onScopeDispose, ref, shallowRef, toRaw } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import type { ArtworkRecord } from '@/types/artwork'
const props = defineProps<{ sourceUrl?: string; artwork?: ArtworkRecord; disabled?: boolean; variant?: 'button' | 'row' }>()
const emit = defineEmits<{ saved: [] }>()
const panel = shallowRef<typeof import('./MangaScreenDialog.vue')['default'] | null>(null)
const loading = ref(false), loadError = ref(false), shown = ref(false), capturedUrl = ref('')
const capturedArtwork = shallowRef<ArtworkRecord | undefined>(), opener = shallowRef<HTMLElement | null>(null)
let revision = 0
async function open(event: MouseEvent) {
  if (loading.value || props.disabled || shown.value) return
  const sequence = ++revision
  opener.value = event.currentTarget as HTMLElement
  capturedUrl.value = props.sourceUrl || ''
  capturedArtwork.value = props.artwork ? structuredClone(toRaw(props.artwork)) : undefined
  loading.value = true; loadError.value = false
  try {
    const component = panel.value || (await import('./MangaScreenDialog.vue')).default
    if (sequence !== revision) return
    panel.value = component; shown.value = true
  } catch { if (sequence === revision) loadError.value = true }
  finally { if (sequence === revision) loading.value = false }
}
function release() { revision++; shown.value = false; loading.value = false }
onDeactivated(release); onScopeDispose(release)
</script>
<style scoped>
.manga-launcher { display:inline-flex; flex-wrap:wrap; align-items:center; gap:var(--s-2); }
.manga-launcher-error { color:var(--text-secondary); font-size:var(--fs-label-sm); }
</style>

<template>
  <StudioDialog
    v-if="activeEntry"
    ref="lightbox"
    v-model:open="lightboxOpen"
    size="md"
    :character="activeEntry?.id"
    :title="activeEntry?.name"
    :subtitle="activeEntry?.subtitle"
    close-label="关闭拍立得灯箱"
    @close="onDialogClose"
  >
    <div v-if="activeEntry" class="chibi-lightbox" :data-character="activeEntry.id">
      <figure class="chibi-lightbox-polaroid">
        <div class="chibi-lightbox-media">
          <img
            :src="activeEntry.full"
            :alt="activeEntry.alt"
            width="960"
            height="576"
            decoding="async"
            draggable="false"
          />
          <span class="chibi-stamp chibi-stamp--lightbox" aria-hidden="true">{{ activeEntry.stamp }}</span>
        </div>
        <figcaption class="chibi-lightbox-note">
          <span class="chibi-index">{{ activeEntry.noteCode }}</span>
          <span>{{ activeEntry.caption }}</span>
        </figcaption>
      </figure>

      <div class="chibi-dialogue">
        <p class="chibi-dialogue-cn">{{ activeEntry.dialogue }}</p>
        <p v-if="activeEntry.jpQuote" class="chibi-dialogue-jp" lang="ja">{{ activeEntry.jpQuote }}</p>
      </div>
    </div>

    <template v-if="activeEntry" #footer="{ close }">
      <RouterLink
        class="btn btn-ghost"
        :to="`/character?character=${activeEntry.id}`"
        @click="close('navigate')"
      >
        <ArchiveIcon name="character" />角色档案
      </RouterLink>
      <RouterLink
        class="btn btn-primary"
        :to="`/chat?character=${activeEntry.id}`"
        @click="close('navigate')"
      >
        <ArchiveIcon name="chat" />进入角色房间
      </RouterLink>
    </template>
  </StudioDialog>
</template>

<script setup lang="ts">
import { defineAsyncComponent, onDeactivated, ref, shallowRef, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import type { ChibiPolaroidEntry } from './chibiPolaroidData'

const StudioDialog = defineAsyncComponent(() => import('@/components/ui/StudioDialog.vue'))
const lightbox = ref<InstanceType<typeof StudioDialog> | null>(null)
const lightboxOpen = ref(false)
const activeEntry = shallowRef<ChibiPolaroidEntry | null>(null)
let opening: { source: HTMLElement; focus: Element | null } | null = null

function showLightbox() {
  if (!lightbox.value || !opening) return
  const { source, focus } = opening
  opening = null
  if (source.isConnected && (document.activeElement === source || document.activeElement === focus)) {
    lightbox.value.openDialog(source)
  }
}
watch(lightbox, showLightbox, { flush: 'post' })

function open(entry: ChibiPolaroidEntry, source: HTMLElement, focus: Element | null) {
  opening = { source, focus }
  activeEntry.value = entry
  showLightbox()
}

function onDialogClose() {
  lightboxOpen.value = false
}

onDeactivated(() => {
  opening = null
  lightbox.value?.closeDialog('')
  lightboxOpen.value = false
})

defineExpose({ open })
</script>

<style scoped>
.chibi-stamp {
  position: absolute;
  top: var(--s-2);
  right: var(--s-2);
  padding: 2px 8px;
  border: 1.5px solid color-mix(in srgb, var(--stamp-color) 76%, transparent);
  outline: 1px dashed color-mix(in srgb, var(--stamp-color) 42%, transparent);
  outline-offset: -4px;
  border-radius: var(--r-xs);
  background: color-mix(in srgb, var(--bg-surface) 92%, transparent);
  color: var(--stamp-color);
  font: 700 var(--fs-mono-xs)/1.3 var(--font-mono);
  letter-spacing: 0.14em;
  transform: rotate(8deg);
  pointer-events: none;
  box-shadow: var(--shadow-sm);
}

.chibi-index {
  color: var(--text-muted);
  font: 500 var(--fs-mono-xs)/var(--lh-flush) var(--font-mono);
  letter-spacing: 0.06em;
  white-space: nowrap;
}

.chibi-lightbox {
  --stamp-color: var(--accent);
  display: grid;
  gap: var(--s-4);
}

.chibi-lightbox[data-character='nene'] {
  --stamp-color: var(--nene-violet);
}

.chibi-lightbox[data-character='natsume'] {
  --stamp-color: var(--natsume-amber);
}

.chibi-lightbox-polaroid {
  margin: 0;
  padding: var(--s-3) var(--s-3) var(--s-4);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-md);
  background: var(--bg-elevated);
  box-shadow: inset 0 1px 0 var(--glass-highlight);
}

:root[data-theme='light'] .chibi-lightbox-polaroid {
  background: var(--bg-base);
}

.chibi-lightbox-media {
  position: relative;
  aspect-ratio: 5 / 3;
  overflow: hidden;
  border: 1px solid var(--border-soft);
  border-radius: var(--r-xs);
  background: var(--art-mat);
}

.chibi-lightbox-media img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center 35%;
}

.chibi-stamp--lightbox {
  top: var(--s-3);
  right: var(--s-3);
}

.chibi-lightbox-note {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--s-2);
  padding: var(--s-3) var(--s-1) 0;
  color: var(--text-secondary);
  font: 400 var(--fs-label-sm)/var(--lh-body) var(--font-serif);
}

.chibi-dialogue {
  display: grid;
  gap: var(--s-2);
  padding: var(--s-3) var(--s-4);
  border: 1px solid color-mix(in srgb, var(--stamp-color) 24%, var(--border-soft));
  border-left: 3px solid var(--stamp-color);
  border-radius: var(--r-md);
  background: linear-gradient(135deg, color-mix(in srgb, var(--stamp-color) 8%, transparent), transparent 72%), var(--bg-base);
}

.chibi-dialogue-cn {
  margin: 0;
  color: var(--text-primary);
  font: 500 var(--fs-body)/var(--lh-loose) var(--font-serif);
}

.chibi-dialogue-jp {
  margin: 0;
  color: var(--text-secondary);
  font: 400 var(--fs-body-sm)/var(--lh-body) var(--font-serif-jp);
  letter-spacing: 0.03em;
}

@media (forced-colors: active) {
  .chibi-stamp {
    background: Canvas;
    color: CanvasText;
    border-color: CanvasText;
    outline-color: CanvasText;
  }
}
</style>

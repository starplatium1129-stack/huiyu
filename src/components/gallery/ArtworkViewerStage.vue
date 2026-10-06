<template>
  <section class="viewer-stage" @click.self="emit('dismiss-info')">
    <button :ref="element => emit('close-button', element as HTMLButtonElement | null)" class="viewer-close" data-fluid-glass type="button" aria-label="关闭" @click="emit('close')"><ArchiveIcon name="close" /></button>
    <button class="viewer-nav viewer-prev" data-fluid-glass type="button" aria-label="上一幅" :disabled="index <= 0" @click="emit('select', index - 1)"><ArchiveIcon name="chevron-down" /></button>
    <slot name="image">
      <GalleryOrbitStage v-if="!original && items[index]" :items="items" :index="index" :active="active"
        :current-src="src" :preview-src="previewSrc" :card-urls="cardUrls" :thumb-urls="thumbUrls" :neighbor-urls="neighborUrls"
        :title="title" @select="emit('select', $event)" @load="emit('load')" @error="emit('error')"
        @pointerdown.capture="emit('interact')" @wheel.capture="emit('interact')" />
      <ZoomableImageViewer v-else-if="src || previewSrc" :src="src || previewSrc" :preview-src="previewSrc"
        :alt="items[index] ? title(items[index]) : ''" @load="emit('load', $event)" @error="emit('error')">
        <template #fallback><div class="viewer-fallback"><ArchiveIcon name="image" /><span>图片暂时无法读取</span></div></template>
      </ZoomableImageViewer>
      <div v-else class="viewer-fallback"><ArchiveIcon name="image" /></div>
    </slot>
    <button class="viewer-nav viewer-next" data-fluid-glass type="button" aria-label="下一幅" :disabled="index >= items.length - 1" @click="emit('select', index + 1)"><ArchiveIcon name="chevron-down" /></button>
    <button class="viewer-mode-switch" data-fluid-glass type="button" :aria-pressed="original" @click="emit('toggle-original')"><ArchiveIcon name="image" />{{ original ? '立体观画' : '原图 / 缩放' }}</button>
    <slot name="tools" />
    <div class="viewer-position">{{ index + 1 }} / {{ items.length }}</div>
  </section>
</template>

<script setup lang="ts" generic="T extends Pick<ArtworkRecord, 'id' | 'width' | 'height' | 'image_width' | 'image_height' | 'actual'>">
import type { ArtworkRecord } from '@/types/artwork'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ZoomableImageViewer from '@/components/visual/ZoomableImageViewer.vue'
import GalleryOrbitStage from './GalleryOrbitStage.vue'
import '@/assets/css/viewer.css'
import '@/assets/css/gallery-viewer.css'

withDefaults(defineProps<{
  items: T[]; index: number; active: boolean; original: boolean; src: string; previewSrc?: string;
  cardUrls?: Record<string, string>; thumbUrls?: Record<string, string>; neighborUrls?: Record<string, string>;
  title: (item: T) => string;
}>(), { previewSrc: '', cardUrls: () => ({}), thumbUrls: () => ({}), neighborUrls: () => ({}) })
const emit = defineEmits<{
  close: []; select: [index: number]; 'toggle-original': []; 'dismiss-info': []; interact: [];
  'close-button': [element: HTMLButtonElement | null]; load: [event?: Event]; error: [];
}>()
</script>

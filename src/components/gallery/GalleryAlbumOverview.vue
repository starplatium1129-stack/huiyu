<template>
  <div>
    <div v-if="!characters && !loading && !error" class="album-overview-actions">
      <button class="btn btn-ghost" type="button" @click="emit('smart')"><ArchiveIcon name="pin" />新建智能画册</button><button v-if="albums.length" class="btn btn-primary" type="button" @click="emit('manual')"><ArchiveIcon name="book" />新建画册</button>
    </div>
    <GalleryProjectAlbums v-if="!loading && (!error || albums.length)" :albums="albums" :selected-id="selectedId" :characters="characters" :busy="busy || !!error" @select="emit('select',$event)" @edit="emit('edit',$event)" @remove="emit('remove',$event)" @visible="emit('visible',$event)" />
    <ArchiveStatePanel v-if="!loading && !error && !albums.length" class="album-empty-state" compact kind="empty" :title="characters ? '还没有角色作品' : '还没有成册的作品'">
      <template #illustration><img class="album-empty-art" :src="characters ? characterArt : collectionArt" width="512" height="512" alt="" decoding="async" draggable="false" /></template>
      <button v-if="!characters" class="btn btn-primary" type="button" :disabled="!hasHistory" @click="emit('manual')">选择作品成册</button><button class="btn btn-ghost" type="button" @click="emit('images')">查看作品展墙</button>
    </ArchiveStatePanel>
    <ArchiveStatePanel v-if="loading || error" :kind="error ? 'error' : 'loading'" :title="error ? '画册读取失败' : '正在整理画册'" :message="error">
      <button v-if="error" class="btn btn-primary" type="button" @click="emit('retry')">重新读取</button>
    </ArchiveStatePanel>
  </div>
</template>
<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ArchiveStatePanel from '@/components/visual/ArchiveStatePanel.vue'
import GalleryProjectAlbums from './GalleryProjectAlbums.vue'
import type { GalleryProjectAlbum } from '@/composables/gallery/useGalleryProjectAlbums'
import characterOriginal from '@/assets/illustrations/atelier-character-spot.webp'
import collectionOriginal from '@/assets/illustrations/atelier-collection-spot.webp'
import { useThemeIllustration } from '@/composables/useThemeIllustration'
const characterArt = useThemeIllustration(characterOriginal, 'character')
const collectionArt = useThemeIllustration(collectionOriginal, 'collection')
defineProps<{ albums: readonly GalleryProjectAlbum[]; selectedId: string; characters: boolean; loading: boolean; error: string; busy: boolean; hasHistory: boolean }>()
const emit = defineEmits<{ select: [id: string]; edit: [id: string]; remove: [id: string]; visible: [ids: string[]]; smart: []; manual: []; images: []; retry: [] }>()
</script>
<style scoped>
@reference "../../assets/css/tailwind.css";
.album-overview-actions { @apply tw:flex tw:items-center tw:justify-end tw:flex-wrap tw:gap-s-2 tw:mb-s-4; }
.album-empty-state { width:100%; max-width:none; }
.album-empty-art { display:block; width:clamp(180px,20vw,260px); height:auto; margin:auto; }
</style>

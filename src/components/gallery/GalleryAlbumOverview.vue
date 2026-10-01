<template>
  <div>
    <div v-if="!loading && !error" class="album-overview-actions">
      <p>{{ characters ? '按保存的角色信息自动归集，换装和场景变化仍收在同一角色下。' : '手动精选与智能画册，一起收在这里。' }}</p>
      <template v-if="!characters"><button class="btn btn-ghost" type="button" @click="emit('smart')"><ArchiveIcon name="pin" />新建智能画册</button><button v-if="albums.length" class="btn btn-primary" type="button" @click="emit('manual')"><ArchiveIcon name="book" />新建画册</button></template>
    </div>
    <GalleryProjectAlbums v-if="!loading && !error" :albums="albums" :selected-id="selectedId" :characters="characters" :busy="busy" @select="emit('select',$event)" @edit="emit('edit',$event)" @remove="emit('remove',$event)" @visible="emit('visible',$event)" />
    <ArchiveStatePanel v-if="!loading && !error && !albums.length" compact kind="empty" :title="characters ? '还没有角色作品' : '还没有成册的作品'" :message="characters ? '保存作品后，会根据角色信息自动显示在这里。' : '选择作品手动成册，或保存角色与标签条件，让画册持续自动更新。'">
      <button v-if="!characters" class="btn btn-primary" type="button" :disabled="!hasHistory" @click="emit('manual')">选择作品成册</button><button class="btn btn-ghost" type="button" @click="emit('images')">查看作品展墙</button>
    </ArchiveStatePanel>
    <ArchiveStatePanel v-if="loading || error" :kind="error ? 'error' : 'loading'" :title="error ? '画册读取失败' : '正在整理画册'" :message="error || '正在读取角色与作品目录。'" />
  </div>
</template>
<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ArchiveStatePanel from '@/components/visual/ArchiveStatePanel.vue'
import GalleryProjectAlbums from './GalleryProjectAlbums.vue'
import type { GalleryProjectAlbum } from '@/composables/gallery/useGalleryProjectAlbums'
defineProps<{ albums: readonly GalleryProjectAlbum[]; selectedId: string; characters: boolean; loading: boolean; error: string; busy: boolean; hasHistory: boolean }>()
const emit = defineEmits<{ select: [id: string]; edit: [id: string]; remove: [id: string]; visible: [ids: string[]]; smart: []; manual: []; images: [] }>()
</script>
<style scoped>
@reference "../../assets/css/tailwind.css";
.album-overview-actions { @apply tw:flex tw:items-center tw:justify-end tw:flex-wrap tw:gap-s-2 tw:mb-s-4; }
.album-overview-actions p { @apply tw:m-0 tw:text-secondary tw:text-label-sm tw:leading-body; margin-right:auto; flex:1 1 260px; }
</style>

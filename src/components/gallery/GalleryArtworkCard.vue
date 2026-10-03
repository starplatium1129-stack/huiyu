<template>
<article
  class="artwork"
  :class="{ 'artwork-pending': confirmingDelete, 'artwork-selectable': selectionMode, 'artwork-selected': selectionMode && selected }"
  :data-card-id="String(item.id)"
  :style="{ '--art-ratio': String(ratio) }"
>
  <!-- 多选勾选标记：只在选择模式出现，纯视觉，状态由按钮的 aria-pressed 承载 -->
  <span v-if="selectionMode" class="artwork-check" aria-hidden="true">
    <ArchiveIcon v-if="selected" name="success" />
  </span>
  <!--
    快捷工具条：选择模式下让位给右上角的勾选标记。此时点卡片是勾选而非
    进大图，把收藏/沿用配方/删除留在原位会与勾选标记叠在一起，且容易误触。
  -->
  <div v-if="!selectionMode" class="artwork-tools">
    <template v-if="confirmingDelete">
      <button class="artwork-tool danger" type="button" :disabled="deleting"
        @click="emit('delete')">{{ deleting ? '删除中…' : '确认删除' }}</button>
      <button class="artwork-tool" type="button" :disabled="deleting"
        @click="emit('cancelDelete')">取消</button>
    </template>
    <template v-else>
      <StudioTooltip content="收藏后可在顶部按「收藏」筛选">
        <button class="artwork-tool" type="button"
          :class="{ 'artwork-tool-on': item.favorite }"
          :aria-pressed="!!item.favorite"
          :aria-label="`${item.favorite ? '取消收藏' : '收藏'}：${title}`"
          @click="emit('favorite')">
          <ArchiveIcon name="love" />
        </button>
      </StudioTooltip>
      <StudioTooltip content="以此作品配方回填创作台">
        <RouterLink class="artwork-tool" :aria-label="`沿用配方：${title}`" :to="`/prompt-builder?remix=${encodeURIComponent(item.id || '')}`">
          <ArchiveIcon name="spark" />
        </RouterLink>
      </StudioTooltip>
      <StudioTooltip content="删除作品">
        <button class="artwork-tool danger" type="button"
          :aria-label="`删除作品：${title}`"
          @click="emit('requestDelete')">
          <ArchiveIcon name="trash" />
        </button>
      </StudioTooltip>
    </template>
  </div>
  <button
    class="artwork-button"
    type="button"
    :aria-pressed="selectionMode ? selected : undefined"
    :aria-label="selectionMode
      ? `${selected ? '取消选择' : '选择'}作品：${title}`
      : `欣赏作品：${title}`"
    @click="selectionMode ? emit('select') : emit('open', $event)"
  >
    <div class="artwork-media" :style="{ '--art-ratio': String(ratio) }">
      <!-- 底层：缩略图垫底（HD 就绪前先出图，也避免 LRU 淘汰 HD 后回退成骨架屏） -->
      <img :crossorigin="cors"
        v-if="thumbUrl"
        class="artwork-image"
        :src="thumbUrl"
        :alt="title"
        loading="lazy"
        decoding="async"
        referrerpolicy="no-referrer"
        @load="emit('measure', $event)"
      />
      <!-- 上层：HD 原图，解码完成后淡入覆盖缩略图，消除「闪一下变高清」的硬切 -->
      <img :crossorigin="cors"
        v-if="imageUrl"
        class="artwork-image artwork-image-hd"
        :src="imageUrl"
        :alt="title"
        decoding="async"
        referrerpolicy="no-referrer"
        @load="emit('load', $event)"
      />
      <div v-if="!imageUrl && !thumbUrl && missing" class="artwork-placeholder"><ArchiveIcon name="image" /></div>
      <div v-else-if="!imageUrl && !thumbUrl" class="artwork-skeleton" aria-hidden="true"></div>
    </div>
      <div class="artwork-caption">
        <span class="artwork-caption-copy tw:min-w-0">
          <span class="artwork-name">{{ title }}</span>
          <span class="artwork-date">{{ character }} · {{ formattedDate }}</span>
        </span>
        <span v-if="item.favorite" class="artwork-mark"><ArchiveIcon name="love" /></span>
      </div>
  </button>
</article>
</template>

<script setup lang="ts">
import type { ArtworkRecord } from '@/types/artwork'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
defineProps<{
  item: ArtworkRecord; title: string; character: string; formattedDate: string; ratio: number;
  thumbUrl: string; imageUrl: string; cors?: 'anonymous'; missing: boolean;
  selectionMode: boolean; selected: boolean; confirmingDelete: boolean; deleting: boolean;
}>()
const emit = defineEmits<{
  select: []; open: [event: MouseEvent]; favorite: []; requestDelete: []; cancelDelete: []; delete: [];
  measure: [event: Event]; load: [event: Event];
}>()
</script>

<style scoped src="@/assets/css/gallery-artwork-card.css"></style>

<template>
<article
  class="artwork"
  :class="{ 'artwork-pending': confirmingDelete, 'artwork-selectable': selectionMode, 'artwork-selected': selectionMode && selected }"
  :data-card-id="String(item.id)"
  data-reveal :data-reveal-key="`artwork:${item.id}`"
  :data-thumb-ready="thumbLoaded"
  :style="{ '--art-ratio': String(ratio) }"
>
  <StudioCheckbox v-if="selectionMode" ref="artworkCheckbox" class="artwork-check"
    :checked="selected" :label="`选择作品：${title}`" @click.capture="selectShift = $event.shiftKey"
    @keydown.capture="selectShift = $event.shiftKey" @update:checked="emit('select', selectShift)" />
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
        <StudioFavoriteButton class="artwork-tool" :active="!!item.favorite" :label="`${item.favorite ? '取消收藏' : '收藏'}：${title}`"
          :class="{ 'artwork-tool-on': item.favorite }"
          :aria-pressed="!!item.favorite"
          :aria-label="`${item.favorite ? '取消收藏' : '收藏'}：${title}`"
          @click="emit('favorite')">
        </StudioFavoriteButton>
      </StudioTooltip>
      <StudioTooltip v-if="item.engine !== 'manga-screen'" :content="continueTarget.label">
        <RouterLink class="artwork-tool" :aria-label="`${continueTarget.label}：${title}`" :to="continueTarget.to">
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
  <component
    :is="selectionMode ? 'div' : 'button'"
    ref="artworkButton"
    class="artwork-button"
    :type="selectionMode ? undefined : 'button'"
    :aria-label="selectionMode ? undefined : `欣赏作品：${title}`"
    @click="!selectionMode && emit('open', $event)"
  >
    <div class="artwork-media" :style="{ '--art-ratio': String(ratio) }">
      <!-- 底层：缩略图垫底（HD 就绪前先出图，也避免 LRU 淘汰 HD 后回退成骨架屏） -->
      <img :crossorigin="cors"
        ref="thumbImage"
        v-if="thumbUrl && !thumbFailed"
        :key="`thumb:${thumbAttempt}`"
        :data-image-attempt="thumbAttempt"
        class="artwork-image"
        :src="thumbUrl"
        :alt="title"
        loading="lazy"
        decoding="async"
        referrerpolicy="no-referrer"
        @load="onImageLoad($event, 'thumb')"
        @error="onImageError($event, 'thumb')"
      />
      <!-- 上层：HD 原图，解码完成后淡入覆盖缩略图，消除「闪一下变高清」的硬切 -->
      <img :crossorigin="cors"
        ref="hdImage"
        v-if="imageUrl && !imageFailed"
        :key="`image:${imageAttempt}`"
        :data-image-attempt="imageAttempt"
        class="artwork-image artwork-image-hd"
        :class="{ 'is-loaded': imageLoaded, 'artwork-image-hd-crossfade': thumbLoaded }"
        :src="imageUrl"
        :alt="title"
        decoding="async"
        referrerpolicy="no-referrer"
        @load="onImageLoad($event, 'image')"
        @error="onImageError($event, 'image')"
      />
      <Transition name="artwork-skeleton"><div v-if="previewPending" class="artwork-skeleton" aria-hidden="true"></div></Transition>
    </div>
      <div class="artwork-caption">
        <span class="artwork-caption-copy tw:min-w-0">
          <span class="artwork-name">{{ title }}</span>
          <span class="artwork-date">{{ character }} · {{ formattedDate }}</span>
        </span>
        <span v-if="item.favorite" class="artwork-mark"><ArchiveIcon name="love" /></span>
      </div>
  </component>
  <div v-if="previewFailed || (!imageUrl && !thumbUrl && missing)" class="artwork-recovery" role="status">
    <ArchiveIcon name="image" />
    <span>作品图片暂时无法读取</span>
    <button v-if="previewFailed" class="artwork-retry" type="button" :aria-label="`重新读取图片：${title}`" @click="retryPreview">重新读取</button>
  </div>
</article>
</template>

<script setup lang="ts">
import type { ArtworkRecord } from '@/types/artwork'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import StudioCheckbox from '@/components/ui/StudioCheckbox.vue'
import StudioFavoriteButton from '@/components/ui/StudioFavoriteButton.vue'
import { artworkContinueTarget } from '@/utils/artworkNavigation'
const props = defineProps<{
  item: ArtworkRecord; title: string; character: string; formattedDate: string; ratio: number;
  thumbUrl: string; imageUrl: string; cors?: 'anonymous'; missing: boolean;
  selectionMode: boolean; selected: boolean; confirmingDelete: boolean; deleting: boolean;
}>()
const continueTarget = computed(() => artworkContinueTarget(props.item, 'remix'))
const artworkButton = ref<HTMLElement | null>(null)
let selectShift = false
const artworkCheckbox = ref<InstanceType<typeof StudioCheckbox> | null>(null)
const thumbImage = ref<HTMLImageElement | null>(null)
const hdImage = ref<HTMLImageElement | null>(null)
const thumbFailed = ref(false), imageFailed = ref(false)
const thumbLoaded = ref(false), imageLoaded = ref(false)
const thumbAttempt = ref(0), imageAttempt = ref(0)
let alive = true
onBeforeUnmount(() => { alive = false })
watch([() => props.thumbUrl, () => props.cors], () => {
  thumbAttempt.value++; thumbFailed.value = false; thumbLoaded.value = false
}, { flush: 'sync' })
watch([() => props.imageUrl, () => props.cors], () => {
  imageAttempt.value++; imageFailed.value = false; imageLoaded.value = false
}, { flush: 'sync' })
const previewFailed = computed(() => Boolean((props.imageUrl || props.thumbUrl)
  && (!props.imageUrl || imageFailed.value) && (!props.thumbUrl || thumbFailed.value)))
const previewPending = computed(() => !previewFailed.value && !thumbLoaded.value && !imageLoaded.value
  && Boolean(props.imageUrl || props.thumbUrl || !props.missing))
type ImageKind = 'thumb' | 'image'
function imageRequest(event: Event, kind: ImageKind) {
  const image = event.target
  if (!(image instanceof HTMLImageElement)) return
  const element = kind === 'thumb' ? thumbImage : hdImage
  const token = kind === 'thumb' ? thumbAttempt : imageAttempt
  const source = () => kind === 'thumb' ? props.thumbUrl : props.imageUrl
  const attempt = token.value, url = source()
  const current = () => alive && !!url && element.value === image && source() === url && token.value === attempt
    && image.getAttribute('src') === url && image.getAttribute('data-image-attempt') === String(attempt)
  return current() ? { image, current } : undefined
}
async function onImageLoad(event: Event, kind: ImageKind) {
  const request = imageRequest(event, kind)
  if (!request || !request.image.naturalWidth || !request.image.naturalHeight) return
  const failed = kind === 'thumb' ? thumbFailed : imageFailed
  // The card's reading frame enters independently. Its skeleton holds until a
  // current image is decoded; an already decoded thumbnail stays beneath HD.
  try { if (typeof request.image.decode === 'function') await request.image.decode() }
  catch { if (request.current()) failed.value = true; return }
  if (!request.current() || failed.value) return
  if (kind === 'thumb') { thumbLoaded.value = true; emit('measure', event) }
  else { imageLoaded.value = true; emit('load', event) }
}
function onImageError(event: Event, kind: ImageKind) {
  if (!imageRequest(event, kind)) return
  if (kind === 'thumb') { thumbLoaded.value = false; thumbFailed.value = true }
  else { imageLoaded.value = false; imageFailed.value = true }
}
function retryPreview() {
  thumbFailed.value = false; imageFailed.value = false
  thumbLoaded.value = false; imageLoaded.value = false
  thumbAttempt.value++; imageAttempt.value++
  void nextTick(() => { if (alive) (props.selectionMode ? artworkCheckbox.value : artworkButton.value)?.focus({ preventScroll: true }) })
}
const emit = defineEmits<{
  select: [extend: boolean]; open: [event: MouseEvent]; favorite: []; requestDelete: []; cancelDelete: []; delete: [];
  measure: [event: Event]; load: [event: Event];
}>()
</script>

<style scoped src="@/assets/css/gallery-artwork-card.css"></style>

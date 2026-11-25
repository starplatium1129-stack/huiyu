<template>
  <section class="video-panel shot-reference-panel" aria-labelledby="shotReferencesTitle">
    <div class="shot-reference-section">
      <div class="shot-reference-header-row">
        <div class="shot-reference-title-group">
          <h2 id="shotReferencesTitle">角色参考卡</h2>
          <span class="field-hint">角色与服装设定 · 参考图片按需上传</span>
          <span v-if="loadingCardIndex !== null" class="shot-ref-loading">
            <ArchiveIcon name="spark" /> 正在为角色 {{ (loadingCardIndex ?? 0) + 1 }} 读取角色资料或上传参考图片…
          </span>
        </div>
        <button
          v-if="cards.length < 4"
          class="btn btn-ghost btn-xs"
          type="button"
          :disabled="disabled"
          @click="emit('addCard')"
        ><ArchiveIcon name="gallery" />添加角色</button>
      </div>
      <div class="shot-reference-grid">
        <div v-for="(card, cardIndex) in cards" :key="cardIndex" class="shot-reference-card">
          <div class="shot-reference-head">
            <strong>角色 {{ cardIndex + 1 }}</strong>
            <input
              :value="card.label"
              :disabled="disabled"
              :aria-label="`角色 ${cardIndex + 1} 名称`"
              class="input input-tight"
              maxlength="20"
              placeholder="角色名（如 宁宁 / 夏目）"
              @input="emit('updateLabel', cardIndex, ($event.target as HTMLInputElement).value)"
            />
            <StudioSelect
              class="shot-card-quick-select"
              size="sm"
              label="选择角色资料"
              :groups="characterGroups"
              :model-value="card.characterId || ''"
              :disabled="disabled"
              @update:model-value="(value) => emit('selectCharacter', cardIndex, String(value))"
            />
            <StudioTooltip v-if="cards.length > 1" anchor content="移除此角色卡">
              <button
                class="btn btn-ghost btn-xs shot-card-remove-btn"
                type="button"
                :disabled="disabled"
                :aria-label="`移除角色 ${cardIndex + 1} 参考卡`"
                @click="emit('removeCard', cardIndex)"
              ><ArchiveIcon name="close" /></button>
            </StudioTooltip>
          </div>

          <p v-if="profileFailed(card)" class="shot-reference-hint" role="status">
            角色资料尚未读取。
            <button
              class="btn btn-ghost btn-sm"
              type="button"
              :disabled="disabled || loadingAssets"
              @click="emit('retryProfile', cardIndex)"
            >重试角色资料</button>
          </p>
          <!-- 服装形态药丸选择器 (Outfit Pills) -->
          <div v-if="getCharOutfits(card.characterId).length > 1" class="shot-card-outfit-pills">
            <button
              v-for="outfit in getCharOutfits(card.characterId)"
              :key="outfit.id"
              type="button"
              class="shot-card-outfit-pill"
              :class="{ active: (card.outfitId || 'default') === outfit.id || (!card.outfitId && outfit.default) }"
              :aria-pressed="(card.outfitId || 'default') === outfit.id || (!card.outfitId && outfit.default)"
              :disabled="disabled"
              @click="emit('switchOutfit', cardIndex, outfit.id)"
            >
              <ArchiveIcon name="wardrobe" />
              <span>{{ outfit.name }}</span>
            </button>
          </div>

          <div class="shot-reference-images">
            <StudioTooltip
              v-for="(image, imageIndex) in card.images"
              :key="image.id"
              anchor
              content="移除参考图"
            >
              <button
                type="button"
                class="shot-reference-remove"
                :disabled="disabled"
                :aria-label="`移除角色 ${cardIndex + 1} 的第 ${imageIndex + 1} 张参考图`"
                @click="removeReferenceWithFocus(cardIndex, imageIndex, $event)"
              >
                <img
                  v-if="image.url"
                  class="shot-reference-thumb"
                  :src="image.url"
                  :alt="`角色 ${cardIndex + 1} 参考图 ${imageIndex + 1}`"
                  loading="lazy"
                />
              </button>
            </StudioTooltip>
            <button
              v-if="card.images.length < 4"
              class="btn btn-ghost btn-sm"
              type="button"
              :disabled="disabled"
              @click="emit('pickReference', cardIndex)"
            ><ArchiveIcon name="upload" />本地上传</button>
            <button
              v-if="card.images.some(image => !image.name)"
              class="btn btn-ghost btn-sm"
              type="button"
              :disabled="disabled || loadingAssets"
              @click="emit('retryReferences', cardIndex)"
            >
              重试参考图上传
            </button>
          </div>
          <p class="shot-reference-hint">
            参考图 {{ card.images.length }} / 4<span v-if="card.images.some(image => !image.name)"> · 有图片待上传</span>
          </p>
          <p v-if="card.images.length" class="shot-reference-hint">参考图片保留在当前窗口；刷新后需重新选择。</p>
          <input
            :ref="(el) => setReferenceInput(el, cardIndex)"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            class="shot-frame-input"
            @change="emit('referencePicked', cardIndex, $event)"
          />
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { nextTick, type ComponentPublicInstance } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioSelect, { type StudioSelectGroup } from '@/components/ui/StudioSelect.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import type { PopularOutfit } from '@/types/character'
import type { ReferenceCard } from './useReferenceCards'

defineProps<{
  cards: ReferenceCard[]
  disabled: boolean
  loadingAssets: boolean
  loadingCardIndex: number | null
  characterGroups: StudioSelectGroup[]
  profileFailed: (card: ReferenceCard) => boolean
  getCharOutfits: (characterId?: string) => PopularOutfit[]
  setReferenceInput: (el: Element | ComponentPublicInstance | null, index: number) => void
}>()

const emit = defineEmits<{
  addCard: []
  removeCard: [cardIndex: number]
  updateLabel: [cardIndex: number, label: string]
  selectCharacter: [cardIndex: number, characterId: string]
  retryProfile: [cardIndex: number]
  switchOutfit: [cardIndex: number, outfitId: string]
  removeReference: [cardIndex: number, imageIndex: number]
  pickReference: [cardIndex: number]
  retryReferences: [cardIndex: number]
  referencePicked: [cardIndex: number, event: Event]
}>()

async function removeReferenceWithFocus(cardIndex: number, imageIndex: number, event: MouseEvent) {
  const group = (event.currentTarget as HTMLElement).closest('.shot-reference-images')
  emit('removeReference', cardIndex, imageIndex)
  await nextTick()
  const buttons = group?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
  buttons?.[Math.min(imageIndex, buttons.length - 1)]?.focus({ preventScroll: true })
}
</script>

<style scoped>
@reference "../../assets/css/tailwind.css";
.shot-reference-section { @apply tw:grid tw:gap-s-3; }
.shot-reference-header-row { @apply tw:flex tw:items-center tw:justify-between tw:gap-s-2 tw:flex-wrap; }
.shot-reference-title-group { @apply tw:grid tw:gap-s-1 tw:min-w-0; }
.shot-reference-title-group h2 { margin:0; font-size:var(--fs-title-sm); font-weight:600; }
.shot-ref-loading { @apply tw:text-accent tw:text-label-xs tw:font-semibold; }
.shot-reference-grid { @apply tw:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); @apply tw:gap-s-3; }
.shot-card-remove-btn { @apply tw:text-danger-text; padding: 1px 6px; font-weight: bold; }
.shot-reference-card { @apply tw:grid tw:gap-s-3 tw:p-s-3; border:0; @apply tw:rounded-md; background:var(--bg-base); }
.shot-reference-head { @apply tw:flex tw:items-center tw:gap-s-2 tw:flex-wrap; }
.shot-reference-head strong { @apply tw:text-body-sm tw:whitespace-nowrap; }
.shot-card-quick-select { flex: 1 1 140px; }
.input-tight { @apply tw:min-h-[28px]; padding: 2px var(--s-2); @apply tw:text-label-xs; }
.shot-card-outfit-pills { @apply tw:flex tw:flex-wrap tw:gap-[4px]; padding: 2px 0; }
.shot-card-outfit-pill {
  @apply tw:inline-flex tw:items-center tw:gap-[3px];
  min-height:32px; padding:var(--s-1) var(--s-2); border:1px solid transparent;
  @apply tw:rounded-pill; background: var(--bg-surface);
  @apply tw:text-label-xs tw:text-secondary tw:cursor-pointer;
}
.shot-card-outfit-pill:hover:not(:disabled) { @apply tw:border-strong tw:text-primary; }
.shot-card-outfit-pill.active { @apply tw:border-strong; background:var(--bg-elevated); @apply tw:text-primary tw:font-semibold; }
.shot-card-outfit-pill:disabled { color:var(--text-disabled); background:var(--bg-elevated); border-color:var(--border-soft); cursor:not-allowed; }
.shot-reference-images { @apply tw:flex tw:flex-wrap tw:gap-s-2 tw:items-center; }
.shot-reference-remove { @apply tw:inline-flex tw:p-0; border: 0; @apply tw:rounded-sm; background: transparent; @apply tw:cursor-pointer; }
.shot-reference-remove:focus-visible { outline: none; box-shadow: var(--focus-shadow); }
.shot-reference-remove:disabled { @apply tw:cursor-not-allowed; }
.shot-reference-thumb { @apply tw:w-[64px] tw:h-[80px] tw:object-contain tw:rounded-sm; border:1px solid var(--border-soft); background:var(--bg-surface); @apply tw:cursor-pointer; }
.shot-reference-hint { @apply tw:m-0 tw:text-muted tw:text-label-xs; }
.shot-frame-input { @apply tw:hidden; }
@media (max-width: 768px) {
  .shot-reference-grid { grid-template-columns: 1fr; }
}
@container (max-width:620px) {
  .shot-reference-grid { grid-template-columns:minmax(0,1fr); }
}
</style>

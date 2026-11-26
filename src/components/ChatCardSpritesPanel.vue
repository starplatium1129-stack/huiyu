<template>
  <section class="chat-sprites-panel room-tool-panel" aria-labelledby="chatSpritesTitle">
    <header class="room-tool-heading">
      <div>
        <h2 id="chatSpritesTitle">情绪差分立绘 · {{ character.name }}</h2>
      </div>
      <button type="button" class="btn btn-quiet btn-icon" aria-label="关闭表情差分面板" @click="emit('close')">
        <ArchiveIcon name="close" />
      </button>
    </header>
    <div class="room-tool-body sprites-panel-body">
      <p class="sprites-help">
        为导入的角色卡生成 6 种情绪立绘；对话情绪变化时将自动切换舞台立绘。
        <template v-if="catalogId">已关联素材库角色「{{ catalogId }}」，将沿用其角色外观配方。</template>
      </p>

      <section v-if="!catalogId" class="sprites-appearance-box">
        <div class="sprites-appearance-head">
          <label class="studio-field-label" for="card-appearance-tags">英文外观特征（用于未绑定卡片生图）</label>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            :disabled="busy || inferring"
            @click="inferFromAvatar"
          >
            <ArchiveIcon name="eye" />
            <span>{{ inferring ? '反推中…' : '自动反推头像外观' }}</span>
          </button>
        </div>
        <textarea
          id="card-appearance-tags"
          v-model="appearanceTags"
          class="textarea sprites-tags-input"
          maxlength="1200"
          rows="2"
          placeholder="例如：1girl, silver hair, twin tails, violet eyes, black hair ribbon"
          @change="persistAppearanceTags"
        ></textarea>
      </section>

      <div class="sprites-toolbar">
        <button
          type="button"
          class="btn btn-primary btn-sm"
          :disabled="busy || !missingEmotions.length"
          @click="generateMissing"
        >
          <ArchiveIcon name="spark" />
          <span>{{ missingEmotions.length ? `一键补齐缺失（${missingEmotions.length} 张）` : '6 种表情已全部就绪' }}</span>
        </button>
        <button v-if="busy" type="button" class="btn btn-ghost btn-sm" @click="cancelGeneration">停止生成</button>
        <span v-if="statusText" class="sprites-status" role="status">{{ statusText }}</span>
      </div>

      <div class="sprites-grid">
        <article v-for="meta in CARD_SPRITE_EMOTIONS" :key="meta.id" class="sprite-slot-card">
          <div class="sprite-slot-preview">
            <img v-if="previews[meta.id]" :src="previews[meta.id]" :alt="`${character.name} ${meta.label}立绘`" />
            <div v-else class="sprite-slot-empty">
              <ArchiveIcon name="image" />
              <span>未生成</span>
            </div>
          </div>
          <div class="sprite-slot-foot">
            <strong>{{ meta.label }}</strong>
            <div class="sprite-slot-actions">
              <button
                v-if="record.sprites[meta.id]"
                type="button"
                class="btn btn-quiet btn-sm"
                @click="emit('preview-emotion', meta.id)"
              >
                预览
              </button>
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                :disabled="busy"
                @click="generateSingle(meta.id)"
              >
                {{ record.sprites[meta.id] ? '重绘' : '生成' }}
              </button>
              <button
                v-if="record.sprites[meta.id]"
                type="button"
                class="btn btn-quiet btn-sm"
                :disabled="busy"
                @click="deleteSlot(meta.id)"
              >
                移除
              </button>
            </div>
          </div>
        </article>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import type { CharacterConfig } from '@/config/characters'
import { getCompanionCharacter } from '@/utils/companionRegistry'
import { artworkRepository } from '@/storage/artworkRepository'
import { fetchRuntimeResult, isRuntimeResultPath } from '@/api/runtimeTasks'
import {
  CARD_SPRITE_EMOTIONS,
  getCardSpriteRecord,
  removeCardSpriteSlot,
  saveCardSpriteSlot,
  setCardAppearanceTags,
  type CardSpriteEmotion,
} from '@/utils/chatCardSprites'
import { dispatchChatCardSpritesChanged } from '@/utils/chatCardSpriteEvents'

const props = defineProps<{
  character: CharacterConfig
}>()

const emit = defineEmits<{
  close: []
  'preview-emotion': [emotion: CardSpriteEmotion]
  notice: [message: string, kind?: 'info' | 'warning' | 'error']
}>()

const catalogId = computed(() => getCompanionCharacter(props.character.id)?.catalogId)
const record = ref(getCardSpriteRecord(props.character.id))
const appearanceTags = ref(record.value.appearanceTags)
const previews = ref<Partial<Record<CardSpriteEmotion, string>>>({})
const busy = ref(false)
const inferring = ref(false)
const statusText = ref('')

let activeController: AbortController | null = null
let previewController: AbortController | null = null
let disposed = false

const missingEmotions = computed(() =>
  CARD_SPRITE_EMOTIONS.map(item => item.id).filter(id => !record.value.sprites[id]),
)

async function loadSlotPreviews() {
  previewController?.abort()
  const controller = new AbortController()
  previewController = controller
  const next: Partial<Record<CardSpriteEmotion, string>> = {}
  for (const meta of CARD_SPRITE_EMOTIONS) {
    const sprite = record.value.sprites[meta.id]
    if (!sprite) continue
    const id = sprite.imageId || (/^(?:image-|img_|task-)/.test(sprite.path) ? sprite.path : '')
    try {
      let thumb = id ? await artworkRepository.getThumbnail(id).catch(() => null) : null
      if (controller.signal.aborted || disposed) return
      if (!thumb?.startsWith('data:image/') && isRuntimeResultPath(sprite.path)) {
        const blob = await fetchRuntimeResult(sprite.path, controller.signal).catch(() => null)
        if (controller.signal.aborted || disposed) return
        if (blob && blob.size && blob.type.startsWith('image/')) {
          const { blobThumbDataUrl } = await import('@/utils/imageThumb')
          thumb = await blobThumbDataUrl(blob)
        }
      }
      if (controller.signal.aborted || disposed) return
      if (thumb?.startsWith('data:image/')) next[meta.id] = thumb
    } catch {
      /* ignore individual preview failure */
    }
  }
  if (!controller.signal.aborted && !disposed) previews.value = next
}

function reloadRecord() {
  record.value = getCardSpriteRecord(props.character.id)
  appearanceTags.value = record.value.appearanceTags
  void loadSlotPreviews()
}

watch(() => props.character.id, reloadRecord, { immediate: true })

onScopeDispose(() => {
  disposed = true
  activeController?.abort()
  previewController?.abort()
})

function persistAppearanceTags() {
  record.value = setCardAppearanceTags(props.character.id, appearanceTags.value)
}

async function inferFromAvatar() {
  if (busy.value || inferring.value) return
  const controller = new AbortController()
  activeController = controller
  inferring.value = true
  statusText.value = '正在识别角色头像特征…'
  try {
    const { inferCardAppearanceTags } = await import('@/composables/chat/cardSpriteGeneration')
    const tags = await inferCardAppearanceTags(props.character.image, controller.signal)
    if (disposed || controller.signal.aborted) return
    appearanceTags.value = tags
    persistAppearanceTags()
    statusText.value = '已提取外观特征词条，可按需微调后生成差分。'
  } catch (error) {
    if (!disposed && !controller.signal.aborted) {
      const msg = error instanceof Error ? error.message : '外观反推失败'
      statusText.value = msg
      emit('notice', msg, 'warning')
    }
  } finally {
    if (activeController === controller) activeController = null
    inferring.value = false
  }
}

async function generateSingle(emotion: CardSpriteEmotion) {
  if (busy.value) return
  persistAppearanceTags()
  const controller = new AbortController()
  activeController = controller
  busy.value = true
  try {
    const { generateCardEmotionSprite } = await import('@/composables/chat/cardSpriteGeneration')
    const image = await generateCardEmotionSprite({
      cardId: props.character.id,
      cardName: props.character.name,
      catalogId: catalogId.value,
      appearanceTags: appearanceTags.value,
      emotion,
      signal: controller.signal,
      onProgress: text => { if (!disposed) statusText.value = text },
    })
    if (disposed || controller.signal.aborted) return
    record.value = saveCardSpriteSlot(props.character.id, emotion, image)
    dispatchChatCardSpritesChanged()
    await loadSlotPreviews()
    statusText.value = '立绘已保存。'
    emit('preview-emotion', emotion)
  } catch (error) {
    if (!disposed && !controller.signal.aborted) {
      const msg = error instanceof Error ? error.message : '生成失败'
      statusText.value = msg
      emit('notice', msg, 'error')
    }
  } finally {
    if (activeController === controller) activeController = null
    busy.value = false
  }
}

async function generateMissing() {
  if (busy.value || !missingEmotions.value.length) return
  persistAppearanceTags()
  const controller = new AbortController()
  activeController = controller
  busy.value = true
  try {
    const { generateCardSpriteSet } = await import('@/composables/chat/cardSpriteGeneration')
    const count = await generateCardSpriteSet({
      cardId: props.character.id,
      cardName: props.character.name,
      catalogId: catalogId.value,
      appearanceTags: appearanceTags.value,
      emotions: [...missingEmotions.value],
      signal: controller.signal,
      onProgress: text => { if (!disposed) statusText.value = text },
      onSlotReady: (emotion, image) => {
        if (disposed) return
        record.value = saveCardSpriteSlot(props.character.id, emotion, image)
        dispatchChatCardSpritesChanged()
        void loadSlotPreviews()
      },
    })
    if (!disposed) statusText.value = `已完成 ${count} 张情绪差分立绘。`
  } catch (error) {
    if (!disposed && !controller.signal.aborted) {
      const msg = error instanceof Error ? error.message : '批量生成未完成'
      statusText.value = msg
      emit('notice', msg, 'warning')
    }
  } finally {
    if (activeController === controller) activeController = null
    busy.value = false
  }
}

function cancelGeneration() {
  activeController?.abort('user-cancel')
  statusText.value = '已停止生成。'
}

function deleteSlot(emotion: CardSpriteEmotion) {
  record.value = removeCardSpriteSlot(props.character.id, emotion)
  dispatchChatCardSpritesChanged()
  void loadSlotPreviews()
}
</script>

<style scoped>
.sprites-panel-body { gap: var(--s-3); }
.sprites-help { margin: 0; color: var(--text-secondary); font: 400 var(--fs-label-xs)/var(--lh-body) var(--font-sans); }
.sprites-appearance-box { display: grid; gap: var(--s-2); padding: var(--s-3); border: 1px solid var(--border-soft); border-radius: var(--r-lg); background: var(--bg-base); }
.sprites-appearance-head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--s-2); }
.sprites-tags-input { width: 100%; height: auto; min-block-size: 2lh; max-block-size: 6lh; }
@supports (field-sizing:content) { .sprites-tags-input { field-sizing: content; resize: none; } }
.sprites-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: var(--s-2); }
.sprites-status { color: var(--text-secondary); font: 400 var(--fs-label-xs)/var(--lh-label) var(--font-sans); }
.sprites-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: var(--s-3); }
.sprite-slot-card { display: grid; grid-template-rows: minmax(0, 1fr) auto; border: 1px solid var(--border-soft); border-radius: var(--r-lg); background: var(--bg-base); overflow: hidden; }
.sprite-slot-preview { aspect-ratio: 3 / 4; display: grid; place-items: center; background: var(--bg-surface); overflow: hidden; }
.sprite-slot-preview img { width: 100%; height: 100%; object-fit: cover; }
.sprite-slot-empty { display: grid; place-items: center; gap: var(--s-1); color: var(--text-secondary); font: 400 var(--fs-label-xs)/var(--lh-label) var(--font-sans); }
.sprite-slot-empty .archive-icon { width: 22px; height: 22px; opacity: 0.7; }
.sprite-slot-foot { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--s-1); padding: var(--s-2); border-top: 1px solid var(--border-soft); }
.sprite-slot-foot strong { font: 600 var(--fs-label)/var(--lh-tight) var(--font-sans); }
.sprite-slot-actions { display: flex; align-items: center; gap: 2px; }
</style>

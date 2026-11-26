<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue'
import RuntimeImage from './visual/RuntimeImage.vue'
import ArchiveIcon from './visual/ArchiveIcon.vue'
import type { CharacterConfig } from '@/config/characters'
import { artworkRepository } from '@/storage/artworkRepository'
import { fetchRuntimeResult, isRuntimeResultPath } from '@/api/runtimeTasks'
import { CHAT_CARD_SPRITES_KEY } from '@/utils/storageKeys'
import {
  cardEmotionLabel,
  getCardSpriteRecord,
  type CardSpriteEmotion,
  type CardSpriteRecord,
} from '@/utils/chatCardSprites'
import { onChatCardSpritesChanged } from '@/utils/chatCardSpriteEvents'

const props = defineProps<{
  character: CharacterConfig
  canManageSprites?: boolean
}>()
const emit = defineEmits<{
  load: []
  error: []
  'open-sprites': []
}>()

const emotion = ref<string>('neutral')
const record = ref<CardSpriteRecord>(getCardSpriteRecord(props.character.id))
const resolvedUrl = ref('')
let activeObjectUrl = ''
let resolveController: AbortController | null = null
let disposed = false

function refreshRecord() {
  record.value = getCardSpriteRecord(props.character.id)
}

function onStorage(event: StorageEvent) {
  if (event.key === null || event.key === CHAT_CARD_SPRITES_KEY) {
    refreshRecord()
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', onStorage)
}
const stopLocalSpriteSync = onChatCardSpritesChanged(refreshRecord)

function releaseObjectUrl() {
  if (activeObjectUrl) {
    URL.revokeObjectURL(activeObjectUrl)
    activeObjectUrl = ''
  }
  resolvedUrl.value = ''
}

const activeSprite = computed(() => {
  const sprites = record.value.sprites
  return sprites[emotion.value as CardSpriteEmotion] || sprites.neutral || null
})

async function resolveSprite() {
  resolveController?.abort()
  const sprite = activeSprite.value
  if (!sprite) {
    releaseObjectUrl()
    return
  }
  const controller = new AbortController()
  resolveController = controller
  try {
    const id = sprite.imageId || (/^(?:image-|img_|task-)/.test(sprite.path) ? sprite.path : '')
    let blob = id ? await artworkRepository.getImage(id, controller.signal).catch(() => null) : null
    if (controller.signal.aborted || disposed) return
    if (!blob && isRuntimeResultPath(sprite.path)) {
      blob = await fetchRuntimeResult(sprite.path, controller.signal).catch(() => null)
    }
    if (controller.signal.aborted || disposed) return
    if (blob && blob.size && blob.type.startsWith('image/')) {
      const nextUrl = URL.createObjectURL(blob)
      releaseObjectUrl()
      activeObjectUrl = nextUrl
      resolvedUrl.value = nextUrl
      return
    }
    const thumb = id ? await artworkRepository.getThumbnail(id).catch(() => null) : null
    if (controller.signal.aborted || disposed) return
    releaseObjectUrl()
    resolvedUrl.value = thumb?.startsWith('data:image/') ? thumb : ''
  } catch {
    if (!controller.signal.aborted && !disposed) releaseObjectUrl()
  }
}

watch(() => props.character.id, () => {
  emotion.value = 'neutral'
  refreshRecord()
})
watch(activeSprite, () => { void resolveSprite() }, { immediate: true })

onScopeDispose(() => {
  disposed = true
  resolveController?.abort()
  releaseObjectUrl()
  stopLocalSpriteSync()
  if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage)
})

const displaySrc = computed(() => resolvedUrl.value || props.character.image)
const emotionBadge = computed(() => (emotion.value !== 'neutral' ? cardEmotionLabel(emotion.value) : ''))
const spriteCount = computed(() => Object.keys(record.value.sprites).length)

defineExpose({
  setEmotion(next: string) {
    emotion.value = next || 'neutral'
  },
  setSpeaking() {},
  setMouth() {},
  setAudioLevel() {},
  setUserMessage() {},
  refreshSprites: refreshRecord,
})
</script>

<template>
  <aside class="character-card card-portrait" :aria-label="character.name" :data-emotion="emotion">
    <div class="card-portrait-stage">
      <RuntimeImage
        :key="displaySrc"
        :src="displaySrc"
        :alt="character.name"
        class="card-portrait-image"
        @load="emit('load')"
        @error="emit('error')"
      />
      <span v-if="emotionBadge" class="card-emotion-badge" role="status">{{ emotionBadge }}</span>
    </div>
    <div class="character-info card-portrait-info">
      <strong class="character-name">{{ character.name }}</strong>
      <button
        v-if="canManageSprites"
        type="button"
        class="btn btn-ghost btn-sm"
        @click="emit('open-sprites')"
      >
        <ArchiveIcon name="spark" />
        <span>{{ spriteCount ? `表情差分 (${spriteCount}/6)` : '生成表情差分' }}</span>
      </button>
    </div>
  </aside>
</template>

<style scoped>
.card-portrait { display: grid; grid-template-rows: minmax(0, 1fr) auto; min-height: 0; }
.card-portrait-stage { position: relative; min-height: 0; display: grid; place-items: center; overflow: hidden; background: radial-gradient(ellipse at 50% 36%, color-mix(in srgb, var(--character-accent) 9%, var(--bg-elevated)), var(--bg-surface) 68%); }
.card-portrait-image { width: 100%; height: 100%; min-height: 0; object-fit: contain; animation: cardSpriteFade .24s var(--ease-out); }
.card-emotion-badge { position: absolute; left: var(--s-3); bottom: var(--s-3); padding: 2px var(--s-2); border: 1px solid var(--border-soft); border-radius: var(--r-pill); background: var(--bg-surface); color: var(--text-primary); font: 500 var(--fs-label-xs)/var(--lh-label) var(--font-sans); }
.card-portrait-info { display: flex; align-items: center; justify-content: space-between; gap: var(--s-2); }
@keyframes cardSpriteFade { from { opacity: 0.72; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  :root:not([data-motion='full']) .card-portrait-image { animation: none; }
}
:root:is([data-motion='reduce'], [data-motion='reduced']) .card-portrait-image { animation: none; }
</style>

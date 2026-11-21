<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { TooltipProvider } from 'reka-ui'
import { scrollBehavior } from '@/utils/motionPreference'
import GuestArtworkLightbox from './GuestArtworkLightbox.vue'
import GuestCanvasStage from './GuestCanvasStage.vue'
import GuestComposerPanel from './GuestComposerPanel.vue'
import GuestHelpDialog from './GuestHelpDialog.vue'
import GuestMasthead from './GuestMasthead.vue'
import {
  DEFAULT_GUEST_EXAMPLE,
  GUEST_IDEAS,
  toggleMoodSnippet,
  type GuestIdea,
  type GuestSection,
} from './guestPresets'
import { useGuestTheme } from './guestTheme'
import { useGuestCatalog, type CatalogItem } from './useGuestCatalog'
import { useGuestGeneration, type GuestResultPayload } from './useGuestGeneration'
import { useGuestHistory, type GuestArtworkMeta, type GuestHistoryItem } from './useGuestHistory'

const { theme, toggleTheme } = useGuestTheme()

const section = ref<GuestSection>('character')
const prompt = ref('')
const character = shallowRef<CatalogItem>()
const scene = shallowRef<CatalogItem>()
const browsingCharacterScenes = ref(false)
const helpOpen = ref(false)
const lightboxOpen = ref(false)

const composerRef = ref<InstanceType<typeof GuestComposerPanel>>()
const canvasRoot = ref<HTMLElement>()
let pendingMeta: GuestArtworkMeta | null = null

const {
  history,
  currentArtwork,
  recordResult,
  selectItem,
  removeItem,
  clearCurrent,
  downloadArtwork,
} = useGuestHistory()

const generation = useGuestGeneration(handleGenerationResult)
const {
  attempt,
  busy,
  cancelling,
  checking,
  connected,
  ready,
  notice,
  error,
  progress,
  elapsedSeconds,
} = generation

const catalog = reactive(
  useGuestCatalog(() => connected.value && (section.value === 'character' || section.value === 'scene')),
)

const activeCharacterId = computed(() => scene.value?.characterId || character.value?.id || '')
const activeCharacterTitle = computed(() => {
  if (character.value && (!scene.value?.characterId || scene.value.characterId === character.value.id)) {
    return character.value.title
  }
  return undefined
})
const contextTitle = computed(() => scene.value?.title || character.value?.title || '自由创作')
const hasPromptOrSelection = computed(() => Boolean(character.value || scene.value || prompt.value.trim()))
const canDraw = computed(() => !cancelling.value && !checking.value && (ready.value || Boolean(attempt.value)))

watch(section, next => {
  if (next === 'character') {
    browsingCharacterScenes.value = false
    catalog.browseCharacters()
  } else if (next === 'scene') {
    browsingCharacterScenes.value = false
    catalog.browseScenes(undefined)
  }
})

onMounted(() => {
  void reconnect()
})

function handleGenerationResult(payload: GuestResultPayload) {
  const meta = pendingMeta ?? {
    title: contextTitle.value,
    prompt: prompt.value.trim(),
    character: character.value,
    scene: scene.value,
  }
  pendingMeta = null
  recordResult(payload, meta)
}

async function reconnect() {
  if (await generation.connect() && attempt.value) {
    await generation.draw()
  }
}

async function generate() {
  if (busy.value) return generation.cancel()
  if (attempt.value) return reconnect()
  if (!ready.value || cancelling.value) return

  const description = prompt.value.trim()
  const recipe = scene.value
  const effectivePrompt = description || (recipe || character.value ? '' : DEFAULT_GUEST_EXAMPLE)

  pendingMeta = {
    title: scene.value?.title || character.value?.title || (description ? '自由创作' : '雨夜暖灯书店'),
    prompt: effectivePrompt,
    character: character.value,
    scene: scene.value,
  }

  if (typeof window !== 'undefined' && window.innerWidth < 960) {
    canvasRoot.value?.scrollIntoView({ behavior: scrollBehavior(), block: 'start' })
  }

  return generation.draw({
    prompt: effectivePrompt,
    characterId: character.value?.id,
    scene: recipe && recipe.kind !== 'character' ? { id: recipe.id, kind: recipe.kind } : undefined,
  })
}

function showCharactersTab() {
  section.value = 'character'
  browsingCharacterScenes.value = false
  catalog.browseCharacters()
  void nextTick(() => composerRef.value?.focusSearch())
}

function backToCharacterGrid() {
  browsingCharacterScenes.value = false
  catalog.browseCharacters()
  void nextTick(() => composerRef.value?.focusSearch())
}

function openCharacterScenes(item: CatalogItem) {
  section.value = 'character'
  browsingCharacterScenes.value = true
  catalog.browseScenes(item)
  void nextTick(() => composerRef.value?.focusSearch())
}

function toggleSceneCharacterScope() {
  if (!character.value) return
  if (catalog.character?.id === character.value.id) {
    catalog.browseScenes(undefined)
  } else {
    catalog.browseScenes(character.value)
  }
}

function chooseItem(item: CatalogItem) {
  if (item.kind === 'character') {
    character.value = item
    scene.value = undefined
    browsingCharacterScenes.value = true
    catalog.browseScenes(item)
    return
  }
  if (character.value?.id !== item.characterId) {
    character.value = catalog.character?.id === item.characterId ? catalog.character : undefined
  }
  scene.value = item
}

function clearSelection() {
  character.value = undefined
  scene.value = undefined
  if (section.value === 'character' && browsingCharacterScenes.value) {
    backToCharacterGrid()
  }
}

function resetSceneFilters(includeCharacter: boolean) {
  if (includeCharacter) {
    catalog.browseScenes(undefined)
  } else {
    catalog.search = ''
  }
  catalog.setRating('')
}

function applyIdea(idea: GuestIdea) {
  character.value = undefined
  scene.value = undefined
  browsingCharacterScenes.value = false
  prompt.value = idea.prompt
}

function pickRandomIdea(activeId: string) {
  const candidates = GUEST_IDEAS.filter(item => item.id !== activeId)
  const pool = candidates.length ? candidates : GUEST_IDEAS
  const chosen = pool[Math.floor(Math.random() * pool.length)]
  if (chosen) applyIdea(chosen)
}

function tryExamplePrompt() {
  section.value = 'free'
  applyIdea(GUEST_IDEAS[0])
  void nextTick(() => composerRef.value?.focusPrompt())
}

function toggleMood(snippet: string) {
  prompt.value = toggleMoodSnippet(prompt.value, snippet)
}

function applyHistorySettings(item: GuestHistoryItem) {
  character.value = item.character
  scene.value = item.scene
  prompt.value = item.prompt
  if (item.scene) {
    section.value = item.character ? 'character' : 'scene'
    if (item.character) {
      browsingCharacterScenes.value = true
      catalog.browseScenes(item.character)
    }
  } else if (item.character) {
    section.value = 'character'
    browsingCharacterScenes.value = false
    catalog.browseCharacters()
  } else {
    section.value = 'free'
  }
}
</script>

<template>
  <TooltipProvider :delay-duration="350" :skip-delay-duration="200">
    <div class="guest-page" :data-character="activeCharacterId || undefined">
      <div class="guest-atmosphere" aria-hidden="true" />

      <GuestMasthead
        :checking="checking"
        :connected="connected"
        :ready="ready"
        :theme="theme"
        @reconnect="reconnect"
        @open-help="helpOpen = true"
        @toggle-theme="toggleTheme"
      />

      <main
        class="pb journal-workspace atelier-workspace guest-workspace"
        :data-character="activeCharacterId || undefined"
      >
        <div class="guest-desk">
          <GuestComposerPanel
            ref="composerRef"
            v-model:section="section"
            v-model:prompt="prompt"
            :character="character"
            :scene="scene"
            :browsing-character-scenes="browsingCharacterScenes"
            :catalog-items="catalog.items"
            :catalog-total="catalog.total"
            :catalog-page="catalog.page"
            :catalog-pages="catalog.pages"
            :catalog-loading="catalog.loading"
            :catalog-error="catalog.error"
            :catalog-search="catalog.search"
            :catalog-rating="catalog.rating"
            :catalog-character="catalog.character"
            :connected="connected"
            :checking="checking"
            :ready="ready"
            :busy="busy"
            :cancelling="cancelling"
            :has-attempt="Boolean(attempt)"
            :error="error"
            :context-title="contextTitle"
            @clear-selection="clearSelection"
            @back-to-character-grid="backToCharacterGrid"
            @open-character-scenes="openCharacterScenes"
            @toggle-scene-character-scope="toggleSceneCharacterScope"
            @choose-item="chooseItem"
            @apply-idea="applyIdea"
            @pick-random-idea="pickRandomIdea"
            @toggle-mood="toggleMood"
            @generate="generate"
            @cancel-attempt="generation.cancel"
            @reconnect="reconnect"
            @update:catalog-search="catalog.search = $event"
            @update:catalog-rating="catalog.setRating($event)"
            @load-catalog-page="catalog.load($event)"
            @reset-scene-filters="resetSceneFilters"
          />

          <div ref="canvasRoot" class="guest-canvasMount">
            <GuestCanvasStage
              :current="currentArtwork"
              :history="history"
              :busy="busy"
              :cancelling="cancelling"
              :checking="checking"
              :ready="ready"
              :has-attempt="Boolean(attempt)"
              :progress="progress"
              :notice="notice"
              :elapsed-seconds="elapsedSeconds"
              :active-character-id="activeCharacterId"
              :active-character-title="activeCharacterTitle"
              :context-title="contextTitle"
              :has-prompt-or-selection="hasPromptOrSelection"
              :can-draw="canDraw"
              @open-lightbox="lightboxOpen = true"
              @download="downloadArtwork"
              @redraw="generate"
              @clear-canvas="clearCurrent"
              @cancel="generation.cancel"
              @select-history="selectItem"
              @apply-history="applyHistorySettings"
              @remove-history="removeItem"
              @pick-character="showCharactersTab"
              @try-example="tryExamplePrompt"
              @draw-now="generate"
            />
          </div>
        </div>
      </main>

      <footer class="guest-footer">
        <span>绘遇 · 好友试玩画室</span>
        <span aria-hidden="true">·</span>
        <span>画面由房主电脑实时生成，关闭页面后记录不保留</span>
      </footer>

      <GuestHelpDialog v-model:open="helpOpen" :character-id="activeCharacterId" />
      <GuestArtworkLightbox
        v-model:open="lightboxOpen"
        :artwork="currentArtwork"
        :character-id="activeCharacterId"
        @download="downloadArtwork"
      />
    </div>
  </TooltipProvider>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from 'reka-ui'
import StudioPagination from '@/components/ui/StudioPagination.vue'
import StudioSearch from '@/components/ui/StudioSearch.vue'
import StudioSkeleton from '@/components/ui/StudioSkeleton.vue'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import GuestScenePicker from './GuestScenePicker.vue'
import {
  GUEST_IDEAS,
  GUEST_MOOD_CHIPS,
  hasMoodSnippet,
  type GuestIdea,
  type GuestSection,
} from './guestPresets'
import type { CatalogItem, GuestRatingFilter } from './useGuestCatalog'
import './guestCatalog.css'
import './guestComposer.css'

const section = defineModel<GuestSection>('section', { required: true })
const prompt = defineModel<string>('prompt', { required: true })

const props = defineProps<{
  character?: CatalogItem
  scene?: CatalogItem
  browsingCharacterScenes: boolean
  catalogItems: readonly CatalogItem[]
  catalogTotal: number
  catalogPage: number
  catalogPages: number
  catalogLoading: boolean
  catalogError: string
  catalogSearch: string
  catalogRating: GuestRatingFilter
  catalogCharacter?: CatalogItem
  connected: boolean
  checking: boolean
  ready: boolean
  busy: boolean
  cancelling: boolean
  hasAttempt: boolean
  error: string
  contextTitle: string
}>()

const emit = defineEmits<{
  clearSelection: []
  backToCharacterGrid: []
  openCharacterScenes: [item: CatalogItem]
  toggleSceneCharacterScope: []
  chooseItem: [item: CatalogItem]
  applyIdea: [idea: GuestIdea]
  pickRandomIdea: [activeId: string]
  toggleMood: [snippet: string]
  generate: []
  cancelAttempt: []
  reconnect: []
  'update:catalogSearch': [value: string]
  'update:catalogRating': [value: GuestRatingFilter]
  loadCatalogPage: [page: number]
  resetSceneFilters: [includeCharacter: boolean]
}>()

const promptBox = ref<HTMLTextAreaElement>()
const characterSearchBox = ref<InstanceType<typeof StudioSearch>>()
const characterScenePicker = ref<InstanceType<typeof GuestScenePicker>>()
const globalScenePicker = ref<InstanceType<typeof GuestScenePicker>>()

const characterSearchModel = computed({
  get: () => props.catalogSearch,
  set: value => emit('update:catalogSearch', value),
})

const hasSelection = computed(() => Boolean(props.character || props.scene))
const hasPromptOrSelection = computed(() => hasSelection.value || prompt.value.trim().length > 0)

const activeIdeaId = computed(() => {
  if (hasSelection.value) return ''
  const trimmed = prompt.value.trim()
  return GUEST_IDEAS.find(idea => trimmed.startsWith(idea.prompt))?.id ?? ''
})

const primaryActionLabel = computed(() => {
  if (props.cancelling) return '正在停止…'
  if (props.busy) return '停止绘制'
  if (props.checking) return '正在连接…'
  if (props.hasAttempt) return '继续读取原图'
  return '开始绘制'
})

const promptPlaceholder = computed(() => {
  if (props.scene) return '想给这一幕微调动作、表情或光影，可以写在这里（中英文均可）'
  if (props.character) return `想让 ${props.character.title} 穿什么、在哪里、做什么，可以写在这里（留空将画默认造型）`
  return '写下你想画的画面，例如：黄昏微雨中的温暖小书店（留空将直接试画「雨夜暖灯书店」）'
})

function onPromptKeydown(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault()
    emit('generate')
  }
}

function characterMonogram(title: string): string {
  return title.trim().slice(0, 1) || '角'
}

function focusSearch() {
  if (section.value === 'scene') {
    globalScenePicker.value?.focusSearch()
  } else if (props.browsingCharacterScenes && props.catalogCharacter) {
    characterScenePicker.value?.focusSearch()
  } else {
    characterSearchBox.value?.focus({ preventScroll: true })
  }
}

function focusPrompt() {
  promptBox.value?.focus({ preventScroll: true })
}

defineExpose({ focusSearch, focusPrompt })
</script>

<template>
  <section class="material-drawer guest-composer" aria-label="创作台">
    <div class="guest-targetBar">
      <div class="guest-targetSummary">
        <span
          class="guest-targetDot"
          :class="{ 'is-active': hasSelection }"
          aria-hidden="true"
        />
        <div class="guest-targetText">
          <strong>{{ contextTitle }}</strong>
          <small v-if="scene && character">已选角色「{{ character.title }}」与当前场景</small>
          <small v-else-if="scene">已选场景蓝图</small>
          <small v-else-if="character">将使用默认造型绘制，也可继续挑她的场景</small>
          <small v-else>{{ prompt.trim() ? '按下方描述自由绘制' : '不选角色也能直接画，点下方灵感或试画一张' }}</small>
        </div>
      </div>
      <button
        v-if="hasSelection"
        class="btn btn-quiet btn-sm"
        type="button"
        @click="emit('clearSelection')"
      >
        清除
      </button>
    </div>

    <TabsRoot v-model="section" class="guest-tabsRoot">
      <TabsList class="workbench-tabs guest-tabsList" aria-label="创作起点">
        <AnimatedSelection variant="underline" tone="character" />
        <TabsTrigger value="character" as-child>
          <button type="button" @click="browsingCharacterScenes && emit('backToCharacterGrid')">
            <ArchiveIcon name="character" />选角色
          </button>
        </TabsTrigger>
        <TabsTrigger value="scene" as-child>
          <button type="button"><ArchiveIcon name="scene" />挑场景</button>
        </TabsTrigger>
        <TabsTrigger value="free" as-child>
          <button type="button"><ArchiveIcon name="spark" />自由画</button>
        </TabsTrigger>
      </TabsList>

      <div class="guest-picker">
        <TabsContent value="character" class="guest-tabPane">
          <GuestScenePicker
            v-if="browsingCharacterScenes && catalogCharacter"
            ref="characterScenePicker"
            :items="catalogItems"
            :total="catalogTotal"
            :page="catalogPage"
            :pages="catalogPages"
            :loading="catalogLoading"
            :error="catalogError"
            :search="catalogSearch"
            :rating="catalogRating"
            :filter-character="catalogCharacter"
            :connected="connected"
            :checking="checking"
            :selected-scene-id="scene?.id"
            :selected-character="character"
            show-back
            search-label="搜索该角色的场景"
            search-placeholder="搜关键词，例如：雨夜、校园、海边"
            :empty-hint="`${catalogCharacter.title}暂时没有符合条件的场景，可直接用默认造型绘制。`"
            @update:search="emit('update:catalogSearch', $event)"
            @update:rating="emit('update:catalogRating', $event)"
            @load-page="emit('loadCatalogPage', $event)"
            @choose="emit('chooseItem', $event)"
            @back="emit('backToCharacterGrid')"
            @reconnect="emit('reconnect')"
            @switch-to-free="section = 'free'"
            @reset-filters="emit('resetSceneFilters', false)"
          />

          <template v-else>
            <StudioSearch
              ref="characterSearchBox"
              v-model="characterSearchModel"
              size="sm"
              label="搜索角色"
              placeholder="搜角色名或作品，例如：宁宁、夏目"
            >
              <template #input="{ inputProps }">
                <input v-bind="inputProps" v-model="characterSearchModel" maxlength="160" />
              </template>
            </StudioSearch>

            <div v-if="character" class="guest-selectedBanner">
              <span>已选 <strong>{{ character.title }}</strong></span>
              <button
                class="btn btn-ghost btn-sm"
                type="button"
                @click="emit('openCharacterScenes', character)"
              >
                挑她的场景
              </button>
            </div>

            <div v-if="!connected && checking" class="guest-skeletonGrid">
              <StudioSkeleton v-for="n in 6" :key="n" variant="line" height="52px" />
            </div>
            <div v-else-if="!connected" class="guest-inlineState">
              <p>连上房主画室后即可浏览全部角色与场景蓝图。</p>
              <div class="guest-inlineActions">
                <button class="btn btn-ghost btn-sm" type="button" @click="emit('reconnect')">重新连接</button>
                <button class="btn btn-quiet btn-sm" type="button" @click="section = 'free'">先看自由画灵感</button>
              </div>
            </div>
            <div v-else-if="catalogError" class="guest-inlineState is-error" role="alert">
              <p>{{ catalogError }}</p>
              <button class="btn btn-ghost btn-sm" type="button" @click="emit('loadCatalogPage', catalogPage)">重试</button>
            </div>
            <div v-else-if="catalogLoading" class="guest-skeletonGrid">
              <StudioSkeleton v-for="n in 6" :key="n" variant="line" height="52px" />
            </div>
            <div v-else-if="!catalogItems.length" class="guest-inlineState">
              <p>没有找到匹配的角色。</p>
              <button
                v-if="catalogSearch"
                class="btn btn-quiet btn-sm"
                type="button"
                @click="emit('update:catalogSearch', '')"
              >
                清空搜索
              </button>
            </div>
            <div v-else class="guest-characterGrid">
              <button
                v-for="item in catalogItems"
                :key="`${item.kind}:${item.id}`"
                type="button"
                class="guest-characterCard"
                :data-char-id="item.id"
                :aria-pressed="character?.id === item.id"
                @click="emit('chooseItem', item)"
              >
                <span class="guest-characterBadge" aria-hidden="true">{{ characterMonogram(item.title) }}</span>
                <span class="guest-characterMeta">
                  <strong>{{ item.title }}</strong>
                  <small v-if="item.category">{{ item.category }}</small>
                </span>
                <ArchiveIcon
                  v-if="character?.id === item.id"
                  name="success"
                  class="guest-itemCheck"
                />
              </button>
            </div>

            <StudioPagination
              v-if="catalogPages > 1"
              compact
              label="角色分页"
              :model-value="catalogPage"
              :pages="catalogPages"
              :disabled="catalogLoading"
              @update:model-value="emit('loadCatalogPage', $event)"
            />
          </template>
        </TabsContent>

        <TabsContent value="scene" class="guest-tabPane">
          <GuestScenePicker
            ref="globalScenePicker"
            :items="catalogItems"
            :total="catalogTotal"
            :page="catalogPage"
            :pages="catalogPages"
            :loading="catalogLoading"
            :error="catalogError"
            :search="catalogSearch"
            :rating="catalogRating"
            :filter-character="catalogCharacter"
            :connected="connected"
            :checking="checking"
            :selected-scene-id="scene?.id"
            :selected-character="character"
            allow-character-scope-toggle
            search-label="搜索场景蓝图"
            search-placeholder="搜场景关键词，例如：夜景、雨天、咖啡馆"
            @update:search="emit('update:catalogSearch', $event)"
            @update:rating="emit('update:catalogRating', $event)"
            @load-page="emit('loadCatalogPage', $event)"
            @choose="emit('chooseItem', $event)"
            @toggle-character-scope="emit('toggleSceneCharacterScope')"
            @reconnect="emit('reconnect')"
            @switch-to-free="section = 'free'"
            @reset-filters="emit('resetSceneFilters', true)"
          />
        </TabsContent>

        <TabsContent value="free" class="guest-tabPane">
          <div class="guest-paneBar">
            <span class="guest-paneHint">点一下就能填入高质量画面描述</span>
            <button class="btn btn-quiet btn-sm" type="button" @click="emit('pickRandomIdea', activeIdeaId)">
              <ArchiveIcon name="dice" />随机灵感
            </button>
          </div>

          <div class="guest-ideaGrid">
            <button
              v-for="idea in GUEST_IDEAS"
              :key="idea.id"
              type="button"
              class="guest-ideaCard"
              :aria-pressed="activeIdeaId === idea.id"
              @click="emit('applyIdea', idea)"
            >
              <span class="guest-ideaIcon" aria-hidden="true">
                <ArchiveIcon :name="idea.icon" />
              </span>
              <span class="guest-ideaCopy">
                <strong>{{ idea.title }}</strong>
                <small>{{ idea.caption }}</small>
              </span>
            </button>
          </div>
        </TabsContent>
      </div>
    </TabsRoot>

    <div class="guest-promptSection">
      <div class="guest-promptHeader">
        <label for="guest-description">{{ hasSelection ? '补充画面细节（可选）' : '画面描述' }}</label>
        <div class="guest-promptMeta">
          <span class="guest-charCount">{{ prompt.length }} / 4000</span>
          <button
            v-if="prompt"
            class="btn btn-quiet btn-sm guest-clearPromptBtn"
            type="button"
            @click="prompt = ''"
          >
            清空
          </button>
        </div>
      </div>

      <textarea
        id="guest-description"
        ref="promptBox"
        v-model="prompt"
        class="textarea guest-textarea"
        maxlength="4000"
        rows="3"
        :placeholder="promptPlaceholder"
        @keydown="onPromptKeydown"
      />

      <div class="guest-moodSection">
        <span class="guest-moodLabel">一键加氛围</span>
        <div class="guest-moodRow" role="group" aria-label="快捷氛围词">
          <button
            v-for="chip in GUEST_MOOD_CHIPS"
            :key="chip.id"
            type="button"
            class="guest-moodChip"
            :aria-pressed="hasMoodSnippet(prompt, chip.snippet)"
            @click="emit('toggleMood', chip.snippet)"
          >
            <ArchiveIcon :name="chip.icon" />{{ chip.label }}
          </button>
        </div>
      </div>
    </div>

    <footer class="guest-submitBar">
      <div v-if="error" class="guest-statusBanner is-error" role="alert">
        <ArchiveIcon name="warning" />
        <span>{{ error }}</span>
        <button
          v-if="!connected && !checking"
          class="btn btn-quiet btn-sm"
          type="button"
          @click="emit('reconnect')"
        >
          重连
        </button>
      </div>
      <div v-else-if="hasAttempt && !busy && !cancelling" class="guest-statusBanner" role="status">
        <ArchiveIcon name="info" />
        <span>还有未取回的上一张图，可直接读取或取消。</span>
        <button class="btn btn-quiet btn-sm" type="button" @click="emit('cancelAttempt')">取消原任务</button>
      </div>
      <div v-else-if="connected && !ready && !busy" class="guest-statusBanner" role="status">
        <ArchiveIcon name="info" />
        <span>房主正在准备 MiaoMiao Anima 1.6，就绪后即可开始绘制。</span>
      </div>

      <button
        class="btn btn-lg guest-submitBtn"
        :class="busy ? 'btn-danger' : 'btn-primary'"
        type="button"
        :disabled="cancelling || checking || (!ready && !busy && !hasAttempt)"
        @click="emit('generate')"
      >
        <ArchiveIcon :name="busy ? 'stop' : hasAttempt ? 'refresh' : 'spark'" />
        <span>{{ primaryActionLabel }}</span>
      </button>

      <p class="guest-submitHint">
        <template v-if="busy">正在实时绘制中，可随时点上方「停止绘制」</template>
        <template v-else-if="!hasPromptOrSelection">不填写描述也可直接点击「开始绘制」，默认画雨夜书店</template>
        <template v-else>已准备好「{{ contextTitle }}」，在输入框按 Ctrl + Enter 也能开画</template>
      </p>
    </footer>
  </section>
</template>

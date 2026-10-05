<template>
  <article ref="archiveRoot" class="page character-page library-page character-editorial" style="--page-max:1600px">
    <header class="library-header"><div><div class="page-kicker">HUIYU / CHARACTER ARCHIVE</div><h1>角色档案</h1><p>{{ showShelf ? '翻开画卷，与下一位心动主角相遇。' : '读懂她的心事，让相遇成为故事。' }}</p></div><div class="archive-header-actions"><button v-if="!showShelf" type="button" class="btn btn-ghost" @click="showBookshelf"><ArchiveIcon name="gallery" />返回作品书架</button><CharacterContextNav v-if="current" :character-id="current.id" active="profile" :scene-path="isPopular ? '/popular-scenes' : '/scene-explorer'" /><RouterLink v-else to="/popular-scenes" class="btn btn-ghost"><ArchiveIcon name="image" />浏览角色场景</RouterLink></div></header>

    <ArchiveStatePanel
      v-if="loading"
      kind="loading"
      title="正在读取角色档案"
      message="主角资料与立绘正在轻声载入…"
    />
    <ArchiveStatePanel
      v-else-if="loadError"
      kind="error"
      title="角色档案读取失败"
      message="本地角色资料暂时无法读取，请稍后重试。"
    >
      <button class="btn btn-primary" type="button" @click="loadProfiles">重新读取</button>
    </ArchiveStatePanel>
    <ArchiveStatePanel
      v-else-if="!characters.length"
      kind="empty"
      title="角色档案暂未收录"
      message="本地角色资料已就绪，当前暂无可浏览的角色记录。"
    />
    <template v-else>
      <Transition :css="false" @enter="archiveMotion.enter" @enter-cancelled="archiveMotion.dispose" @after-leave="archiveMotion.dispose">
        <CharacterBookshelf v-show="showShelf" ref="bookshelf" :items="directoryItems" :selected-id="lastViewedId" @select="selectCharacter" />
      </Transition>
      <Transition :css="false" @enter="archiveMotion.enter" @enter-cancelled="archiveMotion.dispose" @after-leave="archiveMotion.dispose">
      <div v-if="!showShelf" class="library-layout">
        <BrowsingCharacterDirectory :items="directoryItems" :selected-id="current?.id || ''" @select="selectCharacter" />
        <div class="library-detail">
      <section v-if="current" ref="profileAnchor" class="character-hero card-direct card-level-3">
        <CharacterParticleStage :character-id="current.id" :name="current.name" :initial-original="preferOriginal">
        <div class="portrait" :class="{ natsume: current.id === 'natsume' }" :data-portrait-state="portraitView.state">
          <img :crossorigin="runtimeResourceCors()" v-if="portraitView.state !== 'missing'" :key="portraitView.token" class="portrait-image"
            :src="resolveRuntimeUrl(portraitView.src)" :data-attempt-token="portraitView.token"
            :alt="current.portrait?.alt || current.name"
            loading="eager" decoding="async" @load="measurePortrait"
            @error="onPortraitError" />
          <div v-else class="portrait-missing" role="status">
            <ArchiveIcon name="image" class="portrait-missing-icon" />
            <strong class="portrait-missing-title">{{ portraitView.reason === 'empty' ? '立绘未登记' : '立绘缺失' }}</strong>
            <span class="portrait-missing-text">{{ portraitMissingText }}</span>
          </div>
          <div class="portrait-footer">
            <RouterLink v-if="isLocalStudioHost()" class="btn btn-ghost btn-sm" :to="{ path: '/scene-manager', query: { tab: 'portraits', character: current.id } }"><ArchiveIcon name="image" />更换立绘</RouterLink>
            <span class="portrait-badge"><ArchiveIcon name="image" /> {{ characterArtEntry(current.id) ? '自定义立绘' : isPopularPortraitPending(current.id) ? '立绘待补' : isPopular ? '角色场景样张' : '角色立绘' }}</span>
            <span v-if="showFallbackNote" class="portrait-fallback-note">原图无法读取，已显示现有缩略图</span>
            <StudioTooltip :content="current.source">
              <span class="portrait-source">{{ franchiseLabel(franchiseKey(current.source)) }}</span>
            </StudioTooltip>
          </div>
        </div>
        </CharacterParticleStage>
        <div class="character-profile">
          <div class="profile-kicker">人物档案</div>
          <h2 class="character-name">{{ current.name }}</h2>
          <div v-if="hasIdentity" class="identity-row">
            <span v-if="current.identity?.role" class="item role">{{ current.identity.role }}</span>
            <span v-if="current.identity?.age" class="item">{{ current.identity.age }}</span>
            <span v-if="current.identity?.occupation" class="item">{{ current.identity.occupation }}</span>
            <span v-if="current.identity?.faction" class="item">{{ current.identity.faction }}</span>
          </div>
          <div v-if="current.alias?.length" class="character-alias">{{ current.alias.join(' / ') }}</div>
          <div class="character-actions" aria-label="角色快捷操作">
            <RouterLink class="btn btn-primary" :to="isPopular
              ? `/prompt-builder?popular=${encodeURIComponent(current.id)}`
              : `/prompt-builder?char=${encodeURIComponent(current.id)}`"><ArchiveIcon name="spark" />以她开始绘制</RouterLink>
            <RouterLink v-if="!isPopular" class="btn btn-ghost" :to="`/chat?character=${encodeURIComponent(current.id)}`">进入她的房间</RouterLink>
            <RouterLink class="btn btn-ghost" :to="isPopular
              ? `/popular-scenes?character=${encodeURIComponent(current.id)}`
              : `/scene-explorer?character=${encodeURIComponent(current.id)}`">{{ isPopular ? '浏览相关场景' : '查看核心场景' }}</RouterLink>
          </div>
          <div v-if="current.voice" class="voice-block">
            <span class="voice-label">语气示例</span>{{ current.voice }}
          </div>
          <div class="tags-grid">
            <span v-for="(t,i) in current.tags" :key="t" class="tag-chip" :class="tagClass(i)">{{ t }}</span>
          </div>
          <section v-if="current.bg_story" class="character-story" aria-label="角色故事">
            <h3 class="lab">角色故事</h3>
            <p id="character-background" class="profile-story" :class="{ expanded: bgExpanded }">{{ current.bg_story }}</p>
            <button class="profile-story-toggle" type="button" :aria-expanded="bgExpanded" aria-controls="character-background" @click="bgExpanded = !bgExpanded">{{ bgExpanded ? '收起介绍' : '展开介绍' }}</button>
          </section>
          <div class="detail-grid">
            <section class="detail-section"><div class="lab">性格标签</div><div class="chips"><span v-for="p in current.personality" :key="p" class="chip trait">{{ p }}</span></div></section>
            <section class="detail-section"><div class="lab">喜欢的事</div><div class="chips"><span v-for="l in current.likes" :key="l" class="chip">{{ l }}</span></div></section>
          </div>
        </div>
      </section>

      <details v-if="current?.lora" :key="current.id" class="character-production">
        <summary><span><ArchiveIcon name="image" />模型信息</span><span class="production-hint">LoRA 与触发词</span></summary>
        <div class="production-content">
          <section v-if="current.lora" class="detail-section">
            <h3 class="lab">绑定 LoRA</h3>
            <div v-if="current.lora.name" class="char-lora">档案登记：<code>{{ current.lora.name }}</code></div>
            <div v-if="current.lora.trigger_words?.length" class="char-lora">触发词：<code>{{ current.lora.trigger_words.join(', ') }}</code></div>
            <div v-else class="char-lora">当前模型与触发词请在绘图工作台查看。</div>
          </section>
        </div>
      </details>

      <section v-if="recommendations.length" class="recommend-section" data-reveal data-reveal-delay="2">
        <div class="recommend-head">
          <div>
            <div class="page-kicker">Persona core</div>
            <h2 class="recommend-title">人设核心场景</h2>
            <p>先从最像她的瞬间开始；其他换装、AU 与成人向变体仍可在完整场景库中找到。</p>
          </div>
          <a v-if="officialProfileUrl" class="official-link" :href="officialProfileUrl" target="_blank" rel="noreferrer">查看官方人设依据 ↗</a>
        </div>
        <div class="recommend-grid">
          <article v-for="s in recommendations" :key="s.id" class="recommend-card card-info">
            <h3 class="cg-title">{{ s.title }}</h3>
            <div v-if="recommendationReason(s.id)" class="cg-reason">{{ recommendationReason(s.id) }}</div>
            <p class="cg-story">{{ s.story }}</p>
            <footer class="cg-actions">
              <button v-if="s.story" class="btn btn-ghost btn-sm" type="button" :aria-label="`阅读「${s.title}」完整故事`" @click="openRecommendationStory(s, $event)">阅读故事</button>
              <RouterLink class="btn btn-primary btn-sm" :to="recommendationDrawUrl(s)">绘制这一幕</RouterLink>
            </footer>
          </article>
        </div>
      </section>
        </div>
      </div>
      </Transition>
    </template>
    <Teleport to="body">
      <dialog ref="recommendationDialog" class="recommendation-story-dialog" aria-labelledby="recommendation-story-title"
        @cancel.prevent.stop="recommendationStoryDialog.close()" @keydown.esc.stop @click="closeRecommendationBackdrop">
        <header class="recommendation-story-head">
          <div><div class="page-kicker">PERSONA CORE / 场景故事</div><h2 id="recommendation-story-title">{{ activeStory?.title }}</h2></div>
          <button class="btn btn-ghost btn-sm btn-icon" type="button" aria-label="关闭故事" autofocus @click="recommendationStoryDialog.close()"><ArchiveIcon name="close" /></button>
        </header>
        <p ref="recommendationStoryBody" class="recommendation-story-body" tabindex="0">{{ activeStory?.story }}</p>
        <footer class="recommendation-story-actions">
          <RouterLink v-if="activeStory" class="btn btn-primary" :to="recommendationDrawUrl(activeStory)"><ArchiveIcon name="spark" />绘制这一幕</RouterLink>
        </footer>
      </dialog>
    </Teleport>
  </article>
</template>

<script setup lang="ts">
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'
import { popularPortraitFullSrc } from '@/utils/popularPortraitSource'
import { characterArtEntry } from '@/platform/characterArtState'

import { useCharacterPortraitTransition } from '@/composables/useCharacterPortraitTransition'
import CharacterParticleStage from '@/components/library/CharacterParticleStage.vue'
import { ref, computed, nextTick, onMounted, watch } from 'vue'
import { isBackdropClick, useFluidDialog } from '@/composables/useFluidDialog'
import { useSceneStore } from '@/stores/sceneStore'
import CharacterBookshelf from '@/components/library/CharacterBookshelf.vue'
import CharacterContextNav from '@/components/library/CharacterContextNav.vue'
import { useCharacterArchiveNavigation } from '@/composables/useCharacterArchiveNavigation'
import BrowsingCharacterDirectory from '@/components/library/BrowsingCharacterDirectory.vue'
import ArchiveStatePanel from '@/components/visual/ArchiveStatePanel.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import { usePortraitFallback } from '@/composables/usePortraitFallback'
import { useScrollReveal } from '@/composables/useScrollReveal'
import { franchiseLabel, franchiseKey } from '@/utils/franchiseLabel'
import {
  parseCharacterProfiles, popularPortraitSrc, isPopularPortraitPending,
  parseCharacterScenes,
  type CharacterProfile,
  type CharacterScene,
} from '@/utils/characterProfiles'

const sceneStore = useSceneStore()
const characters = ref<CharacterProfile[]>([])
const scenes = ref<CharacterScene[]>([])
const loading = ref(true)
const profileAnchor = ref<HTMLElement | null>(null)
const archiveRoot = ref<HTMLElement | null>(null)
const bookshelf = ref<InstanceType<typeof CharacterBookshelf> | null>(null)
const { current, showShelf, lastViewedId, selectCharacter, showBookshelf } = useCharacterArchiveNavigation(
  characters, profileAnchor, () => bookshelf.value?.focusSelected(),
)
const archiveMotion = useCharacterPortraitTransition(archiveRoot, showShelf, () => current.value?.id || lastViewedId.value)
const { preferOriginal } = archiveMotion
const bgExpanded = ref(false)
useScrollReveal()

const directoryItems = computed(() => characters.value.map(character => ({
  id: character.id, name: character.name, source: character.source, aliases: character.alias,
  image: character.type === 'popular' ? popularPortraitSrc(character.id) : character.portrait?.image,
})))

const portraitSources = computed(() => {
  const profile = current.value
  const main = resolveRuntimeUrl(profile?.type === 'popular' ? popularPortraitFullSrc(profile.id)
    : (characterArtEntry(profile?.id || '')?.portraitUrl || profile?.portrait?.image))
  return { id: profile?.id || '', main,
    thumb: profile?.type === 'popular' ? resolveRuntimeUrl(popularPortraitSrc(profile.id)) : '' }
})
const { view: portraitView, fail: failPortrait,
  loaded: loadPortrait, isLoaded: portraitLoaded } = usePortraitFallback(portraitSources)
function onPortraitError(event: Event) {
  failPortrait((event.target as HTMLImageElement).dataset.attemptToken || '')
}
function measurePortrait(event: Event) {
  const image = event.target as HTMLImageElement
  loadPortrait(image.dataset.attemptToken || '', image.naturalWidth, image.naturalHeight)
}
const portraitMissingText = computed(() => ({
  empty: '该角色档案暂未登记立绘图源。',
  broken: '原图与缩略图均无法读取，本机暂无可显示的立绘。',
  nothumb: '原图无法读取，该角色也没有已登记的缩略图。',
})[portraitView.value.reason])
const showFallbackNote = computed(() => portraitView.value.state === 'fallback' && portraitLoaded.value
  && !!current.value && !isPopularPortraitPending(current.value.id))

function tagClass(index: unknown) { return 'm' + (Number(index) % 6) }

const hasIdentity = computed(() => {
  const id = current.value?.identity || {}
  return id.role || id.age || id.occupation || id.faction
})
const isPopular = computed(() => current.value?.type === 'popular')
const recommendations = computed(() => {
  if (!current.value) return []
  if (current.value.type === 'popular') {
    // 热门角色：人设核心场景 = 该角色的原型场景（scene-blueprints 按 characterId）
    return sceneStore.sceneBlueprints
      .filter(bp => bp.characterId === current.value?.id)
      .slice(0, 6)
      .map(bp => ({
        id: bp.id,
        title: bp.title,
        story: bp.description,
        char: current.value?.id ?? '',
      }))
  }
  const core = sceneStore.curation.personaCoreSceneIds
  const ids = Array.isArray(core) && core.length ? core : current.value.lora?.recommended_scene
  if (!Array.isArray(ids)) return []
  return ids
    .map((id: string) => scenes.value.find(s => s.id === id))
    .filter((scene): scene is CharacterScene =>
      Boolean(scene && [current.value?.id, 'triad', 'both'].includes(scene.char)))
    .slice(0, 6)
})
const officialProfileUrl = computed(() => current.value?.id === 'nene'
  ? 'https://www.yuzu-soft.com/products/sothewitch/character.html'
  : current.value?.id === 'natsume'
    ? 'https://www.yuzu-soft.com/products/stella/character.html'
    : '')
function recommendationReason(id: string) {
  return sceneStore.curation.personaCoreReasons?.[id] || ''
}
function recommendationDrawUrl(scene: CharacterScene) {
  return isPopular.value && current.value
    ? `/prompt-builder?popular=${encodeURIComponent(current.value.id)}&blueprint=${encodeURIComponent(scene.id)}`
    : `/prompt-builder?scene=${encodeURIComponent(scene.id)}`
}
const activeStory = ref<CharacterScene | null>(null)
const recommendationDialog = ref<HTMLDialogElement | null>(null)
const recommendationStoryBody = ref<HTMLElement | null>(null)
const recommendationStoryDialog = useFluidDialog(recommendationDialog)
async function openRecommendationStory(scene: CharacterScene, event: MouseEvent) {
  const source = event.currentTarget as HTMLElement
  activeStory.value = scene
  await nextTick()
  recommendationStoryDialog.open(source)
  // Reset after showModal restores the body's layout box, including same-story revisits.
  if (recommendationStoryBody.value) recommendationStoryBody.value.scrollTop = 0
}
function closeRecommendationBackdrop(event: MouseEvent) {
  if (isBackdropClick(event, recommendationDialog.value)) recommendationStoryDialog.close()
}

const loadError = ref('')

async function loadProfiles() {
  loading.value = true
  loadError.value = ''
  try {
    // 角色档案首屏只需要目录壳；场景/蓝图画布随后后台补齐，不能阻塞粒子展台挂载。
    await sceneStore.loadCharacterShell()
    characters.value = parseCharacterProfiles(sceneStore.characters)
  } catch (e) {
    console.warn('character data load failed', e)
    loadError.value = String(e instanceof Error ? e.message : e)
  }
  loading.value = false
}

watch(() => current.value?.id, id => {
  bgExpanded.value = false
  recommendationStoryDialog.close()
  if (!id) return
  // The bookshelf needs only the character shell; load scene details on entry.
  void Promise.all([sceneStore.loadBrowserScenes('all'), sceneStore.loadBlueprintCatalog()]).then(([catalog]) => {
    scenes.value = parseCharacterScenes(catalog.scenes)
  }).catch(e => console.warn('character scene data load failed', e))
})
onMounted(() => {
  void loadProfiles()
})
</script>

<style scoped src="@/assets/css/character-view.css"></style>
<style scoped src="@/assets/css/character-editorial.css"></style>

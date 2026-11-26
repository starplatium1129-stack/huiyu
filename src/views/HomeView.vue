<template>
  <article class="home-page" :style="museThemeStyle">
    <section class="container home-opening tw:pt-s-4" aria-label="画室序章">
      <div class="home-hero" :data-muse="homeMuse" :data-immediate="heroImmediate" @keydown.capture="heroImmediate = true" @pointerdown.capture="heroImmediate = false">
        <div class="hero-copy" data-route-arrive>
          <h1 class="hero-title">把喜欢的角色，<span class="hero-title-accent">画进你的故事。</span></h1>
          <div class="ctas tw:flex tw:flex-wrap tw:gap-s-3">
            <StudioActionLink id="continueCta" :to="continueLink.to" class="btn-primary" :icon="continueIconName" :label="continueLink.label" />
          </div>
          <p class="continue-hint" v-if="continueHint">{{ continueHint }}</p>
          <div class="hero-muses studio-segments" data-fluid-glass role="group" aria-label="首页角色视觉">
            <AnimatedSelection />
            <button type="button" :aria-pressed="homeMuse === 'nene'" @click="selectMuse('nene', $event)"><span class="muse-marker muse-marker-nene" aria-hidden="true"></span> 绫地宁宁</button>
            <button type="button" :aria-pressed="homeMuse === 'natsume'" @click="selectMuse('natsume', $event)"><span class="muse-marker muse-marker-natsume" aria-hidden="true"></span> 四季夏目</button>
          </div>
        </div>
        <aside class="hero-orbit" :class="{ 'has-fallback': heroFailed && !displayedMuse }" :data-portrait-dir="museDirection" :aria-label="`${portraitName}的角色视觉`" :aria-busy="!heroFailed && !heroLoaded">
          <img v-if="heroImage.src && !heroFailed" v-bind="heroImage" class="hero-preload"
            alt="" aria-hidden="true" loading="eager" fetchpriority="high" decoding="async" />
          <Transition :name="heroImmediate ? '' : 'anime-portrait'">
            <img
              v-if="displayedMuse && paintedHeroes[displayedMuse]"
              :key="displayedMuse"
              :src="paintedHeroes[displayedMuse]!.src"
              :crossorigin="paintedHeroes[displayedMuse]!.crossorigin"
              class="hero-character"
              :class="displayedMuse"
              :alt="displayedMuse === 'nene' ? '绫地宁宁' : '四季夏目'"
              width="1600"
              height="900"
              fetchpriority="high"
              decoding="async"
            />
          </Transition>
          <div v-if="heroFailed" class="hero-fallback is-current" :class="[homeMuse, { 'over-art': displayedMuse }]">
            <ArchiveIcon name="image" />
            <div role="status" class="hero-fallback-copy"><strong class="hero-fallback-text">主视觉暂未加载</strong><p>{{ heroName }}的主视觉暂时无法加载。</p></div>
            <button type="button" class="btn btn-ghost btn-sm" @click="retryHero"><ArchiveIcon name="refresh" />重新加载</button>
          </div>
          <p v-else-if="!heroLoaded" class="hero-loading" :class="{ 'over-art': displayedMuse }" role="status">正在加载{{ heroName }}的主视觉…</p>
        </aside>
      </div>
    </section>

    <!-- 最近创作 -->
    <section class="container home-section home-resume" data-route-arrive v-if="recentWorks.length || recentWorksLoading || recentWorksError">
      <div class="home-section-head">
        <h2 data-screentone-furniture>最近创作</h2>
        <RouterLink to="/gallery" class="link">查看全部 →</RouterLink>
      </div>
      <div ref="recentGrid" class="recent-grid stagger-container">
        <ArchiveStatePanel v-if="(recentWorksLoading && !recentWorks.length) || recentWorksError" class="recent-empty-state" compact :kind="recentWorksLoading ? 'loading' : 'error'" :title="recentWorksLoading ? '正在更新最近创作…' : '最近创作暂未更新'" :message="recentWorksError">
          <button v-if="recentWorksError" type="button" class="btn btn-ghost" @click="retryRecentWorks"><ArchiveIcon name="refresh" />重新加载</button>
        </ArchiveStatePanel>
        <button
          v-for="h in recentWorks"
          :key="h.id"
          class="recent-card"
          type="button" :aria-label="'查看完整作品：' + (h.sceneTitle || h.scene || '未命名')" @click="openRecentPreview(h, $event)"
        >
          <div class="recent-cover" :data-artwork-id="h.id" :data-image-id="h.image_id">
            <HomeArtworkCover :key="h.image_id" :src="coverUrl(h)" @painted="markPainted(h, $event)" @retired="releaseUnusedCovers" />
          </div>
          <div class="recent-body">
            <div class="recent-title">{{ h.sceneTitle || h.scene || '未命名' }}</div>
            <div class="recent-meta">{{ charName(h.character) }} · {{ fmtDate(h.timestamp) }}</div>
          </div>
        </button>
      </div>
      <SavedArtworkPreview v-if="recentPreview" :item="recentPreview" :items="recentWorks" :source="recentPreviewSource" :source-for="recentImageSource" :thumbnail="previewUrl" :request="recentPreviewRequest"
        @close="recentPreview = null" @resume="resumeRecent" />
    </section>
    <!-- 最近用过的场景 -->
    <section class="container home-section" v-if="recentScenes.length" data-reveal>
      <div class="home-section-head">
        <h2 data-screentone-furniture>最近用过的场景</h2>
        <RouterLink to="/scene-explorer" class="link">查看全部 →</RouterLink>
      </div>
      <div class="recent-scenes-row">
        <!-- 同上：进场景，不自动开跑 -->
        <RouterLink
          v-for="s in recentScenes"
          :key="s.id"
          class="sc-link"
          :to="`/prompt-builder?scene=${encodeURIComponent(s.id)}&step=4`"
        >
          <SceneCard :scene="s" mode="strip" :clickable="false" :sample-rating="sampleEntryFor(s.id)?.rating" :thumb-url="sampleThumbUrl(s.id)" />
        </RouterLink>
      </div>
    </section>

    <HomeArtJournal :scenes="featuredScenes" :loading="!journalReady || journalLoading" :error="journalError" :can-refresh="canRefreshJournal" @approach="journalReady = true" @refresh="refreshJournal" />

    <section ref="inspirationSection" class="container home-inspiration" aria-label="场景与角色灵感">
        <!-- 热门角色：样张立绘横条，点击进入该角色的场景库 -->
        <ArchiveStatePanel v-if="artworkReady.characters && sceneStore.metaFailedFiles.has('popular-directory.json')" compact kind="error" title="角色目录暂时无法读取">
          <button type="button" class="btn btn-ghost btn-sm" @click="loadPopularCharacters"><ArchiveIcon name="refresh" />重新读取</button>
        </ArchiveStatePanel>
        <div v-if="popularCharacters.length" class="pop-strip" aria-labelledby="popStripLabel">
          <div class="home-section-head pop-strip-head">
            <div class="pop-strip-title-row">
              <h2 id="popStripLabel" data-screentone-furniture>角色发现</h2>
              <span class="pop-strip-count">{{ popularCharacters.length }} 位角色</span>
            </div>
            <RouterLink to="/popular-scenes" class="link">查看全部 →</RouterLink>
          </div>
          <div class="pop-scroll">
            <RouterLink
              v-for="c in popularCharacters.slice(0, 12)"
              :key="c.id"
              class="pop-card-mini"
              :to="`/popular-scenes?character=${encodeURIComponent(c.id)}`"
            >
              <RuntimeImage
                :src="artworkReady.characters ? portraitSrc(c.id) : undefined"
                :alt="c.displayName"
                loading="lazy"
                decoding="async"
              ><template #fallback><span class="pop-portrait-fallback" aria-hidden="true"><ArchiveIcon name="image" /></span></template></RuntimeImage>
              <span class="pop-cap">
                <span class="pop-cap-name">{{ c.displayName }}</span>
                <span class="pop-cap-franchise">{{ franchiseLabel(c.franchise) }}</span>
              </span>
            </RouterLink>
          </div>
        </div>
    </section>

    <!-- 画室章节入口（主创作章节 + 资料与收藏附页） -->
    <section ref="atelierSection" class="container home-section home-atelier" aria-labelledby="home-atelier-title" data-reveal>
      <div class="home-section-head">
        <h2 id="home-atelier-title" data-screentone-furniture>画室章节</h2>
        <RouterLink to="/guide" class="link">使用指南 →</RouterLink>
      </div>
      <div class="atelier-entries">
        <StudioIllustratedCard v-for="entry in creationEntries" :key="entry.id" :to="entry.to" :title="entry.title" :action="entry.action" :lead="entry.id === 'make'">
          <template #art><img v-if="artworkReady.entries" :srcset="entrySrcset(entry.art)" sizes="(max-width: 1000px) 46vw, min(33vw, 520px)" :src="entry.art" width="1536" height="1024" alt="" loading="lazy" decoding="async" draggable="false" /></template>
        </StudioIllustratedCard>
      </div>
      <div ref="toolsSection" class="atelier-archive-band" aria-label="资料与作品">
        <div class="tools-grid">
          <StudioIllustratedCard to="/character" title="角色档案" icon="character" compact><template #art><img v-if="artworkReady.tools" :src="characterSpot" width="512" height="512" alt="" loading="lazy" decoding="async" draggable="false" /></template></StudioIllustratedCard>
          <StudioIllustratedCard to="/style" title="画风" icon="palette" compact><template #art><img v-if="artworkReady.tools" :src="paletteSpot" width="512" height="512" alt="" loading="lazy" decoding="async" draggable="false" /></template></StudioIllustratedCard>
          <StudioIllustratedCard to="/lora" title="模型" icon="model" compact><template #art><img v-if="artworkReady.tools" :src="modelSpot" width="512" height="512" alt="" loading="lazy" decoding="async" draggable="false" /></template></StudioIllustratedCard>
          <StudioIllustratedCard to="/gallery" title="我的作品" icon="gallery" compact><template #art><img v-if="artworkReady.tools" :src="collectionSpot" width="512" height="512" alt="" loading="lazy" decoding="async" draggable="false" /></template></StudioIllustratedCard>
        </div>
      </div>
    </section>
    <HomeChibiStrip />
  </article>
</template>

<script setup lang="ts">
import { resolveRuntimeUrl, runtimeResourceIdentity } from '@/platform/runtimeUrl'
import { useRuntimeImage } from '@/composables/useRuntimeImage'
import { useHomeHeroes } from '@/composables/useHomeHeroes'
import { useHomeRecentWorks } from '@/composables/useHomeRecentWorks'
import { useHomeSceneHighlights } from '@/composables/useHomeSceneHighlights'
import { useShowcaseAssets } from '@/composables/scene/useShowcaseAssets'
import RuntimeImage from '@/components/visual/RuntimeImage.vue'
import StudioIllustratedCard from '@/components/ui/StudioIllustratedCard.vue'

import { profileLocalStorage as localStorage } from '../platform/web/profileStorage.ts'
import { popularPortraitSrc } from '@/utils/popularPortraitSource'
import { ref, reactive, computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, onDeactivated, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { ArtworkRecord } from '@/types/artwork'
import { artworkContinueTarget } from '@/utils/artworkNavigation'
const SavedArtworkPreview = defineAsyncComponent(() => import('@/components/gallery/SavedArtworkPreview.vue'))
const recentPreview = shallowRef<ArtworkRecord | null>(null), recentPreviewSource = shallowRef<HTMLImageElement | null>(null)
const recentPreviewRequest = ref(0)
const recentGrid = ref<HTMLElement | null>(null)
const router = useRouter()
function recentImageSource(id: string | number) {
  return recentGrid.value?.querySelector<HTMLImageElement>(`.recent-cover[data-artwork-id="${CSS.escape(String(id))}"] img[data-painted]`) ?? null
}
function openRecentPreview(item: ArtworkRecord, event: MouseEvent) {
  recentPreviewSource.value = (event.currentTarget as HTMLElement).querySelector('img[data-painted]')
  recentPreview.value = item
  recentPreviewRequest.value++
}
function resumeRecent(item: ArtworkRecord) { void router.push(artworkContinueTarget(item).to) }
onDeactivated(() => { recentPreview.value = null })
const SceneCard = defineAsyncComponent(() => import('@/components/SceneCard.vue'))
import { franchiseLabel } from '@/utils/franchiseLabel'
import { useCharacterAtmosphere } from '@/composables/useCharacterAtmosphere'
import HomeArtJournal from '@/components/home/HomeArtJournal.vue'
import HomeArtworkCover from '@/components/home/HomeArtworkCover.vue'
import HomeChibiStrip from '@/components/home/HomeChibiStrip.vue'
import StudioActionLink from '@/components/ui/StudioActionLink.vue'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import ArchiveStatePanel from '@/components/visual/ArchiveStatePanel.vue'
import ArchiveIcon, { type ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'
import studioOriginal from '@/assets/illustrations/atelier-studio.webp'
import studioPreview from '@/assets/illustrations/atelier-studio-768.webp'
import scenePreview from '@/assets/illustrations/home-scene-768.webp'
import motionPreview from '@/assets/illustrations/home-motion-768.webp'
import roomPreview from '@/assets/illustrations/home-room-768.webp'
import archivePreview from '@/assets/illustrations/home-archive-768.webp'
import sceneOriginal from '@/assets/illustrations/home-scene.webp'
import motionOriginal from '@/assets/illustrations/home-motion.webp'
import roomOriginal from '@/assets/illustrations/home-room.webp'
import archiveOriginal from '@/assets/illustrations/home-archive.webp'
import characterOriginal from '@/assets/illustrations/atelier-character-spot.webp'
import paletteOriginal from '@/assets/illustrations/atelier-palette-spot.webp'
import modelOriginal from '@/assets/illustrations/atelier-model-spot.webp'
import collectionOriginal from '@/assets/illustrations/atelier-collection-spot.webp'
import { useThemeIllustration } from '@/composables/useThemeIllustration'
import { useScrollReveal } from '@/composables/useScrollReveal'
import { useSceneStore } from '@/stores/sceneStore'

useScrollReveal()
const inspirationSection = ref<HTMLElement | null>(null)
const atelierSection = ref<HTMLElement | null>(null)
const toolsSection = ref<HTMLElement | null>(null)
const artworkReady = reactive({ characters: false, entries: false, tools: false })
let artworkObserver: IntersectionObserver | undefined
onMounted(() => {
  if (!('IntersectionObserver' in window)) {
    artworkReady.characters = artworkReady.entries = artworkReady.tools = true
    loadPopularCharacters()
    return
  }
  const sections = new Map<HTMLElement | null, keyof typeof artworkReady>([
    [inspirationSection.value, 'characters'], [atelierSection.value, 'entries'], [toolsSection.value, 'tools'],
  ])
  // Native lazy loading eagerly fetches several screens ahead. Keep links and
  // reserved artwork space immediately available, then warm images near view.
  artworkObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const section = sections.get(entry.target as HTMLElement)
      if (entry.isIntersecting && section) {
        artworkReady[section] = true
        if (section === 'characters') loadPopularCharacters()
        artworkObserver?.unobserve(entry.target)
      }
    }
  }, { rootMargin: '100px' })
  for (const section of sections.keys()) if (section) artworkObserver.observe(section)
})
onUnmounted(() => artworkObserver?.disconnect())
const studioArt = useThemeIllustration(studioOriginal, 'draw')
const sceneArt = useThemeIllustration(sceneOriginal, 'scene')
const motionArt = useThemeIllustration(motionOriginal, 'motion')
const roomArt = useThemeIllustration(roomOriginal, 'room')
const archiveArt = useThemeIllustration(archiveOriginal, 'collection')
const characterSpot = useThemeIllustration(characterOriginal, 'character')
const paletteSpot = useThemeIllustration(paletteOriginal, 'palette')
const modelSpot = useThemeIllustration(modelOriginal, 'model')
const collectionSpot = useThemeIllustration(collectionOriginal, 'collection')

const DRAFT_KEY = 'aics_pb_last_draft'

const continueIconName = ref<ArchiveIconName>('spark')
const continueLink = ref({ to: '/scene-explorer', label: '选场景，开始创作' })
const continueHint = ref('')

const { recentWorks, loading: recentWorksLoading, error: recentWorksError, sourceRevision: recentSourceRevision,
  coverUrl, previewUrl, load: loadRecentWorks, markPainted, releaseUnusedCovers } = useHomeRecentWorks(recentGrid)
watch(recentSourceRevision, () => {
  // Also retire the click while the async preview component is still loading.
  recentPreview.value = null; recentPreviewSource.value = null; recentPreviewRequest.value++
}, { flush: 'sync' })
async function retryRecentWorks(event: MouseEvent) {
  const origin = event.currentTarget, revision = recentSourceRevision.value
  const page = origin instanceof HTMLElement && document.activeElement === origin ? origin.closest('.home-page') : null
  await loadRecentWorks()
  await nextTick()
  if (revision === recentSourceRevision.value && page?.isConnected && document.activeElement === document.body) {
    page.querySelector<HTMLElement>('.home-resume .recent-card, .recent-empty-state .btn')?.focus({ preventScroll: true })
  }
}
const journalReady = ref(false)
const { recentScenes, featuredScenes, loading: journalLoading, error: journalError, canRefresh: canRefreshJournal, refresh: refreshJournal } = useHomeSceneHighlights(() => journalReady.value)
const { entryFor: sampleEntryFor, thumbUrl: sampleThumbUrl } = useShowcaseAssets(undefined, () => journalReady.value)
const sceneStore = useSceneStore()
const homeMuse = ref<'nene' | 'natsume'>('nene')
const museDirection = ref<'next' | 'prev'>('next')
const museThemeStyle = useCharacterAtmosphere(() => homeMuse.value, () => sceneStore.characters)
const entryPreviews = new Map([[studioOriginal, studioPreview], [sceneOriginal, scenePreview],
  [motionOriginal, motionPreview], [roomOriginal, roomPreview], [archiveOriginal, archivePreview]])
function entrySrcset(source: string) {
  const preview = entryPreviews.get(source)
  return preview ? `${preview} 768w, ${source} 1536w` : undefined
}
const creationEntries = computed(() => [
  { id: 'make', title: '开始绘制', action: '走进绘制台', to: '/prompt-builder', art: studioArt.value },
  { id: 'scene', title: '灵感场景', action: '寻找灵感', to: '/scene-explorer', art: sceneArt.value },
  { id: 'motion', title: '故事短片', action: '开始创作', to: '/studio-projects?tool=video', art: motionArt.value },
  { id: 'room', title: '角色房间', action: '进入房间', to: `/chat?character=${homeMuse.value}`, art: roomArt.value },
  { id: 'archive', title: '参考画册', action: '翻开画册', to: '/showcase', art: archiveArt.value },
])
const heroImmediate = ref(false)
const heroName = computed(() => homeMuse.value === 'nene' ? '绫地宁宁' : '四季夏目')
const { heroes } = useHomeHeroes()
const { image: heroImage, loaded: heroLoaded, failed: heroFailed, retry: reloadHero } = useRuntimeImage(() => heroes.value[homeMuse.value].image)
const displayedMuse = ref<'nene' | 'natsume' | null>(null)
const paintedHeroes = reactive<Partial<Record<'nene' | 'natsume', { src: string; crossorigin?: '' | 'anonymous' | 'use-credentials' }>>>({})
const portraitName = computed(() => (displayedMuse.value || homeMuse.value) === 'nene' ? '绫地宁宁' : '四季夏目')
// Prioritize the chosen portrait, keeping the last decoded image during swaps.
watch([homeMuse, heroLoaded], ([muse, loaded]) => {
  if (loaded) paintedHeroes[muse] = { src: heroImage.value.src, crossorigin: heroImage.value.crossorigin }
  if (paintedHeroes[muse]?.src === heroImage.value.src) displayedMuse.value = muse
}, { immediate: true })
watch(runtimeResourceIdentity, () => { delete paintedHeroes.nene; delete paintedHeroes.natsume; displayedMuse.value = null }, { flush: 'sync' })
function selectMuse(muse: 'nene' | 'natsume', event: MouseEvent) {
  if (muse !== homeMuse.value) {
    museDirection.value = muse === 'natsume' ? 'next' : 'prev'
  }
  heroImmediate.value = event.detail === 0
  homeMuse.value = muse
}
function retryHero(event: MouseEvent) {
  const origin = event.currentTarget
  const hero = origin instanceof HTMLElement && document.activeElement === origin ? origin.closest('.home-hero') : null
  reloadHero()
  if (hero) void nextTick(() => {
    // The retry button leaves with its error state; preserve only the focus
    // it owned, and never pull the user back from a newly focused control.
    if (hero.isConnected && document.activeElement === document.body) {
      hero.querySelector<HTMLButtonElement>('.hero-muses button[aria-pressed="true"]')?.focus({ preventScroll: true })
    }
  })
}

// ── 热门角色：样张立绘横条（立绘来自展示库发布 assets/characters/popular-<id>.png） ──
const popularCharacters = computed(() => sceneStore.directoryCharacters)
function loadPopularCharacters() {
  void sceneStore.loadCharacterDirectory().catch(error => console.warn('角色加载失败：', error))
}
watch(() => sceneStore.version, () => { if (artworkReady.characters) loadPopularCharacters() })
function portraitSrc(id: string): string {
  // 横条卡片仅 ~180px 宽，加载 1.2MB 原图曾把首页资源预算打爆 5 倍（16MB）。
  // 改用 build-character-thumbs.py 预生成的 360px WebP 缩略图（~19KB/张）；
  // 源 PNG 重发后需重跑该脚本（mtime 过期自动重建）。
  return resolveRuntimeUrl(popularPortraitSrc(id, sceneStore.version || 3))
}


function charName(id: string | undefined) {
  return id === 'nene' ? '宁宁' : id === 'natsume' ? '夏目' : id || '·'
}
function fmtDate(ts: string | number | undefined) {
  const value = typeof ts === 'number' || typeof ts === 'string' ? ts : 0
  return new Date(value).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

function readDraft(value: string | null): { updatedAt: number; sceneId?: string; sceneTitle?: string; story?: string } | null {
  try {
    const parsed: unknown = JSON.parse(value || 'null')
    if (!parsed || typeof parsed !== 'object') return null
    const draft = parsed as Record<string, unknown>
    if (!Number(draft.updatedAt)) return null
    return {
      updatedAt: Number(draft.updatedAt),
      sceneId: typeof draft.sceneId === 'string' ? draft.sceneId : undefined,
      sceneTitle: typeof draft.sceneTitle === 'string' ? draft.sceneTitle : undefined,
      story: typeof draft.story === 'string' ? draft.story : undefined,
    }
  } catch { return null }
}

function initContinueDraft() {
  const draft = readDraft(localStorage.getItem(DRAFT_KEY))
  if (!draft || (!draft.sceneId && !draft.story)) return false
  const title = draft.sceneTitle || draft.story || '未完成创作'
  const characters = Array.from(title)
  continueLink.value = { to: '/prompt-builder?resume=1', label: '继续上次创作' }
  continueIconName.value = 'refresh'
  continueHint.value = `上次停在「${characters.slice(0, 24).join('')}${characters.length > 24 ? '…' : ''}」`
  return true
}

watch(recentWorks, works => {
  if (initContinueDraft()) return
  continueIconName.value = 'spark'
  const h = works[0]
  continueLink.value = h ? artworkContinueTarget(h) : { to: '/scene-explorer', label: '选场景，开始创作' }
  continueHint.value = h ? `最近保存「${h.sceneTitle || h.scene || '未命名'}」` : ''
}, { flush: 'sync' })

onMounted(async () => {
  initContinueDraft()
  try {
    await loadRecentWorks()
  } catch (e) { console.warn('作品库暂时不可用', e) }
})

</script>

<style scoped src="@/assets/css/home.css"></style>

<template>
  <article class="home-page">
    <section class="container home-opening tw:pt-s-6" aria-label="画室序章">
      <div class="home-hero" :data-muse="homeMuse" :data-immediate="heroImmediate" @keydown.capture="heroImmediate = true" @pointerdown.capture="heroImmediate = false">
        <div class="hero-copy" data-route-arrive>
          <span class="hero-register">绘遇 HUIYU · AI 角色创作画室</span>
          <h1 class="hero-title">把喜欢的角色，<br /><span class="hero-title-accent">画进你的故事。</span></h1>
          <div class="ctas tw:flex tw:flex-wrap tw:gap-s-3">
            <StudioActionLink id="continueCta" :to="continueLink.to" class="btn-primary" :icon="continueIconName" :label="continueLink.label" />
            <StudioActionLink to="/prompt-builder" class="btn-ghost" icon="image" label="直接去绘制台" />
          </div>
          <p class="continue-hint" v-if="continueHint">{{ continueHint }}</p>
          <div class="hero-muses studio-segments" data-fluid-glass role="group" aria-label="首页角色视觉">
            <AnimatedSelection />
            <button type="button" :aria-pressed="homeMuse === 'nene'" @click="selectMuse('nene', $event)"><span class="muse-marker muse-marker-nene" aria-hidden="true"></span> 绫地宁宁</button>
            <button type="button" :aria-pressed="homeMuse === 'natsume'" @click="selectMuse('natsume', $event)"><span class="muse-marker muse-marker-natsume" aria-hidden="true"></span> 四季夏目</button>
          </div>
          <div class="hero-links">
          <RouterLink class="hero-particle-link" :to="`/character?character=${homeMuse}`"
            :aria-label="`欣赏${homeMuse === 'nene' ? '绫地宁宁' : '四季夏目'}的粒子形象`">
            <ArchiveIcon name="spark" /><span>欣赏粒子形象</span><ArchiveIcon name="chevron-down" class="particle-link-arrow" />
          </RouterLink>
          <RouterLink to="/showcase" class="hero-particle-link hero-reference-link"><ArchiveIcon name="image" />先看参考样张</RouterLink>
          </div>
        </div>
        <aside class="hero-orbit" :class="{ 'has-fallback': heroFailed[homeMuse] && !displayedMuse }" :aria-label="`${portraitName}的角色视觉`" :aria-busy="!heroFailed[homeMuse] && !heroLoaded[homeMuse]">
          <img v-if="neneHero.src && !heroFailed.nene" v-bind="neneHero" class="hero-preload" alt="" aria-hidden="true" loading="eager" decoding="async" fetchpriority="high" />
          <img v-if="natsumeHero.src && !heroFailed.natsume" v-bind="natsumeHero" class="hero-preload" alt="" aria-hidden="true" loading="eager" decoding="async" />
          <img :src="paintedHeroes.nene?.src" :crossorigin="paintedHeroes.nene?.crossorigin" class="hero-character nene" :class="{ 'is-current': displayedMuse === 'nene' }" :alt="displayedMuse === 'nene' ? '绫地宁宁' : ''" :aria-hidden="displayedMuse !== 'nene'" width="1024" height="1497" decoding="sync" />
          <img :src="paintedHeroes.natsume?.src" :crossorigin="paintedHeroes.natsume?.crossorigin" class="hero-character natsume" :class="{ 'is-current': displayedMuse === 'natsume' }" :alt="displayedMuse === 'natsume' ? '四季夏目' : ''" :aria-hidden="displayedMuse !== 'natsume'" width="1024" height="1497" decoding="sync" />
          <div v-if="heroFailed[homeMuse]" class="hero-fallback is-current" :class="[homeMuse, { 'over-art': displayedMuse }]">
            <ArchiveIcon name="image" />
            <div role="status" class="hero-fallback-copy"><strong class="hero-fallback-text">主视觉暂未加载</strong><p>{{ heroName }}的画页暂时无法读取。</p></div>
            <button type="button" class="btn btn-ghost btn-sm" @click="retryHero"><ArchiveIcon name="refresh" />重试画页</button>
          </div>
          <p v-else-if="!heroLoaded[homeMuse]" class="hero-loading" :class="{ 'over-art': displayedMuse }" role="status">正在载入{{ heroName }}的画页…</p>
          <div class="orbit-label" aria-live="polite"><span>{{ (displayedMuse || homeMuse) === 'nene' ? 'AYACHI NENE' : 'SHIKI NATSUME' }}</span><strong>{{ (displayedMuse || homeMuse) === 'nene' ? '把温柔，留在这一帧。' : '平凡的今天，也值得珍藏。' }}</strong></div>
        </aside>
        <span class="hero-jp" aria-hidden="true">ときめきの一瞬を、一枚に。</span>
      </div>
    </section>

    <!-- 最近创作 -->
    <section class="container home-section home-resume" v-if="recentWorks.length">
      <div class="home-section-head">
        <h2>最近创作</h2>
        <RouterLink to="/gallery" class="link">打开我的作品 →</RouterLink>
      </div>
      <div class="recent-grid stagger-container">
        <ArchiveStatePanel v-if="recentWorksLoading || recentWorksError" class="recent-empty-state" compact :kind="recentWorksLoading ? 'loading' : 'error'" :title="recentWorksLoading ? '正在更新最近创作…' : '最近创作暂未更新'" :message="recentWorksError">
          <button v-if="recentWorksError" type="button" class="btn btn-ghost" @click="retryRecentWorks"><ArchiveIcon name="refresh" />重新读取</button>
        </ArchiveStatePanel>
        <button
          v-for="h in recentWorks"
          :key="h.id"
          class="recent-card"
          type="button" :aria-label="'查看完整作品：' + (h.sceneTitle || h.scene || '未命名')" @click="openRecentPreview(h, $event)"
        >
          <div class="recent-cover" :data-image-id="h.image_id">
            <RuntimeImage :src="coverUrl(h)" v-slot="{ image, loaded, failed }">
              <img v-if="image.src && !failed" v-bind="image" alt="" class="recent-cover-img" :class="{ ready: loaded }" loading="lazy" decoding="async" />
              <ArchiveIcon v-if="!loaded" name="image" class="placeholder" />
            </RuntimeImage>
          </div>
          <div class="recent-body">
            <div class="recent-title">{{ h.sceneTitle || h.scene || '未命名' }}</div>
            <div class="recent-meta">{{ charName(h.character) }} · {{ fmtDate(h.timestamp) }}</div>
          </div>
        </button>
      </div>
      <SavedArtworkPreview v-if="recentPreview" :item="recentPreview" :source="recentPreviewSource" :thumbnail="coverUrl(recentPreview)" :request="recentPreviewRequest"
        @close="recentPreview = null" @resume="resumeRecent" />
    </section>
    <!-- 最近用过的场景 -->
    <section class="container home-section" v-if="recentScenes.length" data-reveal>
      <div class="home-section-head">
        <h2>最近用过的场景</h2>
        <RouterLink to="/scene-explorer" class="link">继续找灵感 →</RouterLink>
      </div>
      <div class="recent-scenes-row">
        <!-- 同上：进场景，不自动开跑 -->
        <RouterLink
          v-for="s in recentScenes"
          :key="s.id"
          class="sc-link"
          :to="`/prompt-builder?scene=${encodeURIComponent(s.id)}&step=4`"
        >
          <SceneCard :scene="s" mode="strip" :clickable="false" />
        </RouterLink>
      </div>
    </section>

    <HomeCreationGuide />
    <HomeArtJournal :scenes="featuredScenes" :loading="journalLoading" :error="journalError" :can-refresh="canRefreshJournal" @refresh="refreshJournal" />

    <section ref="inspirationSection" class="container home-inspiration" aria-label="场景与角色灵感">
        <!-- 热门角色：样张立绘横条，点击进入该角色的场景库 -->
        <div v-if="popularCharacters.length" class="pop-strip" aria-labelledby="popStripLabel">
          <div class="strip-label" id="popStripLabel">
            <span class="dot"></span> 在这里，遇见你的本命 · <span>{{ popularCharacters.length }} 位角色</span><RouterLink to="/popular-scenes" class="link">查看全部角色 →</RouterLink>
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

    <!-- 创作入口 -->
    <section ref="atelierSection" class="container home-section home-atelier" aria-labelledby="home-atelier-title" data-reveal>
      <div class="home-section-head">
        <div>
          <h2 id="home-atelier-title">创作入口</h2>
        </div>
      </div>
      <div class="atelier-entries">
        <StudioIllustratedCard v-for="entry in creationEntries" :key="entry.id" :to="entry.to" :title="entry.title" :label="entry.label" :action="entry.action" :description="entry.id === 'make' ? '选好角色与场景，把喜欢的故事绘成一张画。' : undefined" :lead="entry.id === 'make'">
          <template #art><img v-if="artworkReady.entries" :srcset="entrySrcset(entry.art)" sizes="(max-width: 1000px) 46vw, min(33vw, 520px)" :src="entry.art" width="1536" height="1024" alt="" loading="lazy" decoding="async" draggable="false" /></template>
        </StudioIllustratedCard>
      </div>
    </section>

    <!-- 资料区 -->
    <section ref="toolsSection" class="container home-section home-section-quiet" aria-labelledby="home-library-title" data-reveal>
      <div class="home-section-head">
        <div>
          <h2 id="home-library-title">资料与作品</h2>
        </div>
      </div>
      <div class="tools-grid">
        <StudioIllustratedCard to="/character" title="角色档案" icon="character" description="查看设定与参考" compact><template #art><img v-if="artworkReady.tools" :src="characterSpot" width="512" height="512" alt="" loading="lazy" decoding="async" draggable="false" /></template></StudioIllustratedCard>
        <StudioIllustratedCard to="/style" title="画风" icon="palette" description="找到喜欢的笔触" compact><template #art><img v-if="artworkReady.tools" :src="paletteSpot" width="512" height="512" alt="" loading="lazy" decoding="async" draggable="false" /></template></StudioIllustratedCard>
        <StudioIllustratedCard to="/lora" title="模型" icon="model" description="查阅模型资料" compact><template #art><img v-if="artworkReady.tools" :src="modelSpot" width="512" height="512" alt="" loading="lazy" decoding="async" draggable="false" /></template></StudioIllustratedCard>
        <StudioIllustratedCard to="/gallery" title="我的作品" icon="gallery" description="查看与整理作品" compact><template #art><img v-if="artworkReady.tools" :src="collectionSpot" width="512" height="512" alt="" loading="lazy" decoding="async" draggable="false" /></template></StudioIllustratedCard>
      </div>
      <div v-if="!recentWorks.length" class="home-first-work">
        <ArchiveStatePanel
          v-if="recentWorksLoading || recentWorksError"
          class="recent-empty-state"
          compact
          :kind="recentWorksLoading ? 'loading' : 'error'"
          :title="recentWorksLoading ? '正在读取最近创作…' : '最近创作暂未读取'"
          :message="recentWorksError"
        >
          <button v-if="recentWorksError" type="button" class="btn btn-ghost" @click="retryRecentWorks"><ArchiveIcon name="refresh" />重新读取</button>
        </ArchiveStatePanel>
        <div v-else class="recent-empty-state home-start-card">
          <span class="recent-empty-art"><img v-if="artworkReady.tools" :src="createSpot" width="512" height="512" alt="" loading="lazy" decoding="async" draggable="false" /></span>
          <div class="home-start-copy"><h3>把灵感变成第一幅作品</h3><p>选场景、定角色，下一幅作品从这里开始。</p></div>
          <RouterLink to="/prompt-builder" class="btn btn-primary"><ArchiveIcon name="spark" />开始绘制</RouterLink>
        </div>
      </div>
    </section>
  </article>
</template>

<script setup lang="ts">
import { resolveRuntimeUrl } from '@/platform/runtimeUrl'
import { useRuntimeImage } from '@/composables/useRuntimeImage'
import { useHomeHeroes } from '@/composables/useHomeHeroes'
import { useHomeRecentWorks } from '@/composables/useHomeRecentWorks'
import { useHomeSceneHighlights } from '@/composables/useHomeSceneHighlights'
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
const router = useRouter()
function openRecentPreview(item: ArtworkRecord, event: MouseEvent) {
  recentPreviewSource.value = (event.currentTarget as HTMLElement).querySelector('img')
  recentPreview.value = item
  recentPreviewRequest.value++
}
function resumeRecent(item: ArtworkRecord) { void router.push(artworkContinueTarget(item).to) }
onDeactivated(() => { recentPreview.value = null })
const SceneCard = defineAsyncComponent(() => import('@/components/SceneCard.vue'))
import { franchiseLabel } from '@/utils/franchiseLabel'
import HomeArtJournal from '@/components/home/HomeArtJournal.vue'
import HomeCreationGuide from '@/components/home/HomeCreationGuide.vue'
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
import createOriginal from '@/assets/illustrations/atelier-create-spot.webp'
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
const createSpot = useThemeIllustration(createOriginal, 'draw')

const DRAFT_KEY = 'aics_pb_last_draft'

const continueIconName = ref<ArchiveIconName>('spark')
const continueLink = ref({ to: '/scene-explorer', label: '选场景，开始创作' })
const continueHint = ref('')

const { recentWorks, loading: recentWorksLoading, error: recentWorksError, coverUrl, load: loadRecentWorks } = useHomeRecentWorks()
async function retryRecentWorks(event: MouseEvent) {
  const origin = event.currentTarget
  const page = origin instanceof HTMLElement && document.activeElement === origin ? origin.closest('.home-page') : null
  await loadRecentWorks()
  await nextTick()
  if (page?.isConnected && document.activeElement === document.body) {
    page.querySelector<HTMLElement>('.home-resume .recent-card, .recent-empty-state .btn')?.focus({ preventScroll: true })
  }
}
const { recentScenes, featuredScenes, loading: journalLoading, error: journalError, canRefresh: canRefreshJournal, refresh: refreshJournal } = useHomeSceneHighlights()
const sceneStore = useSceneStore()
const homeMuse = ref<'nene' | 'natsume'>('nene')
const entryPreviews = new Map([[studioOriginal, studioPreview], [sceneOriginal, scenePreview],
  [motionOriginal, motionPreview], [roomOriginal, roomPreview], [archiveOriginal, archivePreview]])
function entrySrcset(source: string) {
  const preview = entryPreviews.get(source)
  return preview ? `${preview} 768w, ${source} 1536w` : undefined
}
const creationEntries = computed(() => [
  { id: 'make', label: '01 / MAKE', title: '开始绘制', action: '走进绘制台', to: '/prompt-builder', art: studioArt.value },
  { id: 'scene', label: '02 / SCENE', title: '灵感场景', action: '寻找灵感', to: '/scene-explorer', art: sceneArt.value },
  { id: 'motion', label: '03 / MOTION', title: '故事短片', action: '开始创作', to: '/video-studio', art: motionArt.value },
  { id: 'room', label: '04 / ROOM', title: '角色房间', action: '进入房间', to: `/chat?character=${homeMuse.value}`, art: roomArt.value },
  { id: 'archive', label: '05 / ARCHIVE', title: '参考画册', action: '翻开画册', to: '/showcase', art: archiveArt.value },
])
const heroImmediate = ref(false)
const heroName = computed(() => homeMuse.value === 'nene' ? '绫地宁宁' : '四季夏目')
const { heroes, ready: heroesReady } = useHomeHeroes()
const { image: neneHero, loaded: neneLoaded, failed: neneFailed, retry: retryNene } = useRuntimeImage(() => heroesReady.value ? heroes.value.nene.image : undefined)
const { image: natsumeHero, loaded: natsumeLoaded, failed: natsumeFailed, retry: retryNatsume } = useRuntimeImage(() => heroesReady.value ? heroes.value.natsume.image : undefined)
const heroFailed = computed(() => ({ nene: neneFailed.value, natsume: natsumeFailed.value }))
const heroLoaded = computed(() => ({ nene: neneLoaded.value, natsume: natsumeLoaded.value }))
const displayedMuse = ref<'nene' | 'natsume' | null>(null)
const paintedHeroes = reactive<Partial<Record<'nene' | 'natsume', { src: string; crossorigin?: '' | 'anonymous' | 'use-credentials' }>>>({})
const portraitName = computed(() => (displayedMuse.value || homeMuse.value) === 'nene' ? '绫地宁宁' : '四季夏目')
// The visible nodes keep their last decoded URL while a replacement loads on
// the native staging nodes. Only two painted sources survive, until unmount.
watch(neneLoaded, loaded => {
  if (loaded) paintedHeroes.nene = { src: neneHero.value.src, crossorigin: neneHero.value.crossorigin }
}, { immediate: true, flush: 'sync' })
watch(natsumeLoaded, loaded => {
  if (loaded) paintedHeroes.natsume = { src: natsumeHero.value.src, crossorigin: natsumeHero.value.crossorigin }
}, { immediate: true, flush: 'sync' })
watch([homeMuse, () => paintedHeroes[homeMuse.value]], ([muse, painted]) => {
  if (painted) displayedMuse.value = muse
}, { immediate: true, flush: 'sync' })
watch(heroesReady, ready => { if (!ready) { delete paintedHeroes.nene; delete paintedHeroes.natsume; displayedMuse.value = null } }, { flush: 'sync' })
function selectMuse(muse: 'nene' | 'natsume', event: MouseEvent) {
  heroImmediate.value = event.detail === 0
  homeMuse.value = muse
}
function retryHero(event: MouseEvent) {
  const origin = event.currentTarget
  const hero = origin instanceof HTMLElement && document.activeElement === origin ? origin.closest('.home-hero') : null
  if (homeMuse.value === 'nene' && neneFailed.value) retryNene()
  else if (homeMuse.value === 'natsume' && natsumeFailed.value) retryNatsume()
  if (hero) void nextTick(() => {
    // The retry button leaves with its error state; preserve only the focus
    // it owned, and never pull the user back from a newly focused control.
    if (hero.isConnected && document.activeElement === document.body) {
      hero.querySelector<HTMLButtonElement>('.hero-muses button[aria-pressed="true"]')?.focus({ preventScroll: true })
    }
  })
}
watch(homeMuse, muse => { if (muse === 'nene' && neneFailed.value) retryNene(); else if (muse === 'natsume' && natsumeFailed.value) retryNatsume() })

// ── 热门角色：样张立绘横条（立绘来自展示库发布 assets/characters/popular-<id>.png） ──
const popularCharacters = computed(() => sceneStore.popularCharacters)
function loadPopularCharacters() {
  // The home strip needs the complete ordered character count, but its large
  // profile catalog should only compete for bandwidth when the strip is near.
  void sceneStore.loadBlueprintCatalog().catch(error => console.warn('角色加载失败：', error))
}
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
  continueLink.value = { to: '/prompt-builder?resume=1', label: '继续上次创作' }
  continueIconName.value = 'refresh'
  continueHint.value = `上次停在「${title.slice(0, 24)}」`
  return true
}

watch(recentWorks, works => {
    if (!initContinueDraft() && works[0]) {
      const h = works[0]
      continueLink.value = artworkContinueTarget(h)
      continueHint.value = `最近保存「${h.sceneTitle || h.scene || '未命名'}」`
    }
})

onMounted(async () => {
  initContinueDraft()
  try {
    await loadRecentWorks()
  } catch (e) { console.warn('作品库暂时不可用', e) }
})

</script>

<style scoped src="@/assets/css/home.css"></style>

<template>
  <article class="home-page">
    <section class="container home-opening" aria-label="创作画室">
      <div class="home-hero" :data-muse="homeMuse" :data-immediate="heroImmediate" @keydown.capture="heroImmediate = true" @pointerdown.capture="heroImmediate = false">
        <div class="hero-copy">
          <span class="hero-register"><span aria-hidden="true"></span> YOUR CREATIVE ROOM</span>
          <h1 class="hero-title">把喜欢的角色，<br /><span class="hero-title-accent">画进你的故事。</span></h1>
          <div class="hero-muses" role="group" aria-label="首页角色视觉">
            <AnimatedSelection />
            <button type="button" :aria-pressed="homeMuse === 'nene'" @click="selectMuse('nene', $event)"><span class="muse-marker muse-marker-nene" aria-hidden="true"></span>绫地宁宁</button>
            <button type="button" :aria-pressed="homeMuse === 'natsume'" @click="selectMuse('natsume', $event)"><span class="muse-marker muse-marker-natsume" aria-hidden="true"></span>四季夏目</button>
          </div>
          <div class="hero-create">
            <span class="eyebrow">CREATION / 继续这一页</span>
            <RouterLink :to="continueLink.to" class="btn btn-lg btn-primary" id="continueCta"><ArchiveIcon :name="continueIconName" /><span>{{ continueLink.label }}</span><span aria-hidden="true">↗</span></RouterLink>
            <p class="continue-hint" v-if="continueHint">{{ continueHint }}</p>
            <RouterLink to="/prompt-builder" class="hero-direct"><ArchiveIcon name="image" />打开绘制台<ArchiveIcon name="chevron-down" /></RouterLink>
          </div>
          <nav class="hero-shortcuts" aria-label="创作快捷入口">
            <RouterLink to="/scene-explorer"><ArchiveIcon name="scene" /><span>找灵感</span><span aria-hidden="true">↗</span></RouterLink>
            <RouterLink to="/gallery"><ArchiveIcon name="gallery" /><span>我的作品</span><span aria-hidden="true">↗</span></RouterLink>
            <RouterLink to="/video-studio"><ArchiveIcon name="play" /><span>故事短片</span><span aria-hidden="true">↗</span></RouterLink>
            <RouterLink :to="`/chat?character=${homeMuse}`"><ArchiveIcon name="chat" /><span>角色房间</span><span aria-hidden="true">↗</span></RouterLink>
          </nav>
          <RouterLink class="hero-particle-link" :to="`/character?character=${homeMuse}`" :aria-label="`欣赏${heroName}的粒子形象`"><ArchiveIcon name="spark" /><span>欣赏粒子形象</span></RouterLink>
        </div>
        <aside class="hero-orbit" :class="{ 'has-fallback': heroFailed[homeMuse] }" :aria-label="`${heroName}的角色视觉`" :aria-busy="!heroFailed[homeMuse] && !heroLoaded[homeMuse]">
          <div class="hero-art-frame">
            <img v-if="neneHero.src && !heroFailed.nene" v-bind="neneHero" class="hero-character nene" :class="{ 'is-current': homeMuse === 'nene' }" :alt="homeMuse === 'nene' ? '绫地宁宁' : ''" :aria-hidden="homeMuse !== 'nene'" width="1024" height="1497" sizes="45vw" loading="eager" decoding="async" fetchpriority="high" />
            <img v-if="natsumeHero.src && !heroFailed.natsume" v-bind="natsumeHero" class="hero-character natsume" :class="{ 'is-current': homeMuse === 'natsume' }" :alt="homeMuse === 'natsume' ? '四季夏目' : ''" :aria-hidden="homeMuse !== 'natsume'" width="1024" height="1497" sizes="45vw" loading="eager" decoding="async" />
            <div v-if="heroFailed[homeMuse]" class="hero-fallback is-current" :class="homeMuse">
              <ArchiveIcon name="image" />
              <div role="status" class="hero-fallback-copy"><strong class="hero-fallback-text">主视觉暂未加载</strong><p>{{ heroName }}的画页暂时无法读取。</p></div>
              <button type="button" class="btn btn-ghost btn-sm" @click="retryHero"><ArchiveIcon name="refresh" />重试画页</button>
            </div>
            <p v-else-if="!heroLoaded[homeMuse]" class="hero-loading" role="status">正在载入{{ heroName }}的画页…</p>
          </div>
          <div class="orbit-label" aria-live="polite"><div><span>{{ homeMuse === 'nene' ? 'AYACHI NENE' : 'SHIKI NATSUME' }}</span><strong>{{ homeMuse === 'nene' ? '把温柔，留在这一帧。' : '平凡的今天，也值得珍藏。' }}</strong></div><span class="hero-page-number" aria-hidden="true">{{ homeMuse === 'nene' ? '01' : '02' }}</span></div>
        </aside>
        <div class="hero-study">
          <div class="hero-study-head"><span class="eyebrow">INSPIRATION / 今日画页</span><ArchiveIcon name="image" /></div>
          <RuntimeImage v-if="featuredScenes[0]" :src="'/scene-showcase/images/' + featuredScenes[0].id + '.jpg'" v-slot="{ image, failed }">
            <RouterLink class="hero-study-link" :to="(failed ? '/scene-explorer?scene=' : '/showcase?scene=') + encodeURIComponent(featuredScenes[0].id)">
              <div class="hero-study-art"><img v-if="image.src && !failed" v-bind="image" :alt="featuredScenes[0].title || '今日精选场景'" loading="lazy" decoding="async" /><span v-else class="hero-study-missing"><ArchiveIcon name="scene" />先看看这一幕的设定</span></div>
              <span class="hero-study-category">{{ featuredScenes[0].category || '角色片刻' }}</span>
              <h2>{{ featuredScenes[0].title }}</h2>
              <span class="hero-study-open">{{ failed ? '查看场景' : '翻开这一幕' }}<span aria-hidden="true">↗</span></span>
            </RouterLink>
          </RuntimeImage>
          <RouterLink v-else to="/scene-explorer" class="hero-study-empty"><ArchiveIcon name="scene" /><span>挑一幕喜欢的场景</span><span aria-hidden="true">↗</span></RouterLink>
          <RouterLink to="/showcase" class="hero-study-all">翻阅参考画册<ArchiveIcon name="chevron-down" /></RouterLink>
        </div>
      </div>
    </section>

    <section class="container home-section home-resume" aria-labelledby="recent-title">
      <div class="home-section-head"><div><span class="eyebrow">YOUR WORKS</span><h2 id="recent-title">继续你的创作</h2></div><RouterLink to="/gallery" class="link">打开我的作品 <span aria-hidden="true">↗</span></RouterLink></div>
      <div v-if="recentWorks.length" class="recent-grid">
        <RouterLink v-for="h in recentWorks" :key="h.id" class="recent-card" :to="`/prompt-builder?regen=${encodeURIComponent(h.id)}`" :style="{ '--work-ratio': workRatio(h) }">
          <div class="recent-cover" :data-image-id="h.image_id"><img :crossorigin="runtimeResourceCors()" v-if="coverUrl(h)" :src="resolveRuntimeUrl(coverUrl(h))" :alt="h.sceneTitle || h.scene || '最近作品'" class="recent-cover-img" loading="lazy" decoding="async" @load="measureWork(h, $event)" /><ArchiveIcon v-else name="image" class="placeholder" /></div>
          <div class="recent-body"><div class="recent-title">{{ h.sceneTitle || h.scene || '未命名' }}</div><div class="recent-meta">{{ charName(h.character) }} · {{ fmtDate(h.timestamp) }}</div><span aria-hidden="true">↗</span></div>
        </RouterLink>
      </div>
      <RouterLink v-else to="/prompt-builder" class="recent-empty"><span class="recent-empty-icon"><ArchiveIcon name="image" /></span><span><strong>给你的画册，添上第一张作品。</strong><span>画好之后，会收进这里。</span></span><span class="recent-empty-action">开始绘制 <span aria-hidden="true">↗</span></span></RouterLink>
    </section>

    <HomeArtJournal :scenes="featuredScenes.slice(1, 3)" />

    <section v-if="popularCharacters.length" class="container home-section home-inspiration" aria-labelledby="popStripLabel">
      <div class="pop-strip">
        <div class="home-section-head"><div><span class="eyebrow">CHARACTER COLLECTION</span><h2 id="popStripLabel">下一页，和谁一起？</h2></div><RouterLink to="/popular-scenes" class="link">{{ popularCharacters.length }} 位角色 <span aria-hidden="true">↗</span></RouterLink></div>
        <div class="pop-scroll">
          <RouterLink v-for="c in popularCharacters.slice(0, 12)" :key="c.id" class="pop-card-mini" :to="`/popular-scenes?character=${encodeURIComponent(c.id)}`">
            <RuntimeImage :src="portraitSrc(c.id)" :alt="c.displayName" loading="lazy" decoding="async"><template #fallback><span class="pop-portrait-fallback" aria-hidden="true"><ArchiveIcon name="image" /></span></template></RuntimeImage>
            <span class="pop-cap"><span class="pop-cap-name">{{ c.displayName }}</span><span class="pop-cap-franchise">{{ franchiseLabel(c.franchise) }}</span></span>
          </RouterLink>
        </div>
      </div>
    </section>

    <section class="container home-section home-recent-scenes" v-if="recentScenes.length" aria-labelledby="recent-scenes-title" data-reveal>
      <div class="home-section-head"><div><span class="eyebrow">RECENT INSPIRATION</span><h2 id="recent-scenes-title">再回到这一幕</h2></div><RouterLink to="/scene-explorer" class="link">继续找灵感 <span aria-hidden="true">↗</span></RouterLink></div>
      <div class="recent-scenes-row"><RouterLink v-for="s in recentScenes" :key="s.id" class="sc-link" :to="`/prompt-builder?scene=${encodeURIComponent(s.id)}&step=4`"><SceneCard :scene="s" mode="strip" :clickable="false" /></RouterLink></div>
    </section>

    <HomeCreationGuide />
  </article>
</template>
<script setup lang="ts">
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'
import { useRuntimeImage } from '@/composables/useRuntimeImage'
import { useHomeHeroes } from '@/composables/useHomeHeroes'
import { useHomeRecentWorks } from '@/composables/useHomeRecentWorks'
import type { ArtworkRecord } from '@/types/artwork'
import RuntimeImage from '@/components/visual/RuntimeImage.vue'

import { profileLocalStorage as localStorage } from '../platform/web/profileStorage.ts'
import { popularPortraitSrc } from '@/utils/popularPortraitSource'
import { ref, computed, nextTick, onMounted, watch } from 'vue'
import SceneCard from '@/components/SceneCard.vue'
import { franchiseLabel } from '@/utils/franchiseLabel'
import HomeArtJournal from '@/components/home/HomeArtJournal.vue'
import HomeCreationGuide from '@/components/home/HomeCreationGuide.vue'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import ArchiveIcon, { type ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'
import { readRecent } from '@/utils/sceneUX'
import { useScrollReveal } from '@/composables/useScrollReveal'
import { useSceneStore } from '@/stores/sceneStore'
import type { Scene } from '@/stores/sceneStore'

useScrollReveal()

const DRAFT_KEY = 'aics_pb_last_draft'

const continueIconName = ref<ArchiveIconName>('spark')
const continueLink = ref({ to: '/scene-explorer', label: '选场景，开始创作' })
const continueHint = ref('先选喜欢的画面；确认参数后再生成。')
type HomeScene = Scene & { title?: string; mature?: boolean }

const { recentWorks, coverUrl, load: loadRecentWorks } = useHomeRecentWorks()
const recentScenes = ref<HomeScene[]>([])
const featuredScenes = ref<HomeScene[]>([])
const sceneStore = useSceneStore()
const homeMuse = ref<'nene' | 'natsume'>('nene')
const heroImmediate = ref(false)
const heroName = computed(() => homeMuse.value === 'nene' ? '绫地宁宁' : '四季夏目')
const { heroes } = useHomeHeroes()
const { image: neneHero, loaded: neneLoaded, failed: neneFailed, retry: retryNene } = useRuntimeImage(() => heroes.value.nene.image)
const { image: natsumeHero, loaded: natsumeLoaded, failed: natsumeFailed, retry: retryNatsume } = useRuntimeImage(() => heroes.value.natsume.image)
const heroFailed = computed(() => ({ nene: neneFailed.value, natsume: natsumeFailed.value }))
const heroLoaded = computed(() => ({ nene: neneLoaded.value, natsume: natsumeLoaded.value }))
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
function portraitSrc(id: string): string {
  // 横条卡片仅 ~180px 宽，加载 1.2MB 原图曾把首页资源预算打爆 5 倍（16MB）。
  // 改用 build-character-thumbs.py 预生成的 360px WebP 缩略图（~19KB/张）；
  // 源 PNG 重发后需重跑该脚本（mtime 过期自动重建）。
  return resolveRuntimeUrl(popularPortraitSrc(id, sceneStore.version || 3))
}


const measuredWorkRatios = ref<Record<string, number>>({})
function workRatio(work: ArtworkRecord): number {
  const measured = measuredWorkRatios.value[work.id]
  if (measured) return measured
  const width = Number(work.width || work.image_width || work.actual?.width)
  const height = Number(work.height || work.image_height || work.actual?.height)
  return Number.isFinite(width / height) && width > 0 && height > 0 ? width / height : .75
}
function measureWork(work: ArtworkRecord, event: Event) {
  const image = event.target as HTMLImageElement
  if (image.naturalWidth && image.naturalHeight) measuredWorkRatios.value[work.id] = image.naturalWidth / image.naturalHeight
}
function charName(id: string | undefined) {
  return id === 'nene' ? '宁宁' : id === 'natsume' ? '夏目' : id || '·'
}
function fmtDate(ts: string | number | undefined) {
  const value = typeof ts === 'number' || typeof ts === 'string' ? ts : 0
  return new Date(value).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isHomeScene(scene: Scene): scene is HomeScene {
  return typeof scene.id === 'string'
    && (scene.mature === undefined || typeof scene.mature === 'boolean')
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

/**
 * 首页横条以日期为种子做确定性轮换：每天从「招牌 + 精选」池里换一窗展示，
 * 与横条文案「今天可以从这里开始」一致，且不改变 curation 的层级语义。
 */
function pickFeatured(ids: string[], scenes: HomeScene[], count: number): HomeScene[] {
  const pool = ids
    .map(id => scenes.find(scene => scene.id === id))
    .filter((scene): scene is HomeScene => Boolean(scene && !scene.mature && scene.rating !== 'R18'))
  if (!pool.length) return []
  const dayKey = new Date().toISOString().slice(0, 10)
  let seed = 0
  for (let i = 0; i < dayKey.length; i += 1) seed = (seed * 31 + dayKey.charCodeAt(i)) >>> 0
  const start = seed % pool.length
  const out: HomeScene[] = []
  for (let i = 0; i < count && out.length < count; i += 1) out.push(pool[(start + i) % pool.length])
  return out
}

async function loadSceneHighlights() {
  try {
    // 审计 2026-09-05 P2-02：首页只需要精选/最近场景与计数，轻载不再拉 3.4MB 蓝图
    await sceneStore.loadHome()
    const scenes = sceneStore.scenes.filter(isHomeScene)
    const curation = sceneStore.curation
    const signatures: string[] = Array.isArray(curation.signatureSceneIds) ? curation.signatureSceneIds : []
    const curated: string[] = Array.isArray(curation.curatedSceneIds) ? curation.curatedSceneIds : []
    const ids = [...signatures, ...curated.filter((id: string) => !signatures.includes(id))]

    featuredScenes.value = pickFeatured(ids, scenes, 6)

    // 最近用过的场景
    const recent = readRecent(localStorage)
    const recentPicks = recent
      .map(item => scenes.find(scene => scene.id === item.id))
      .filter((scene): scene is HomeScene => Boolean(scene))
      .slice(0, 6)
    recentScenes.value = recentPicks
  } catch (err) {
    console.warn('场景加载失败：', errorMessage(err))
  }
}

watch(recentWorks, works => {
    if (!initContinueDraft() && works[0]) {
      const h = works[0]
      continueLink.value = { to: `/prompt-builder?regen=${encodeURIComponent(h.id)}`, label: '继续最近作品' }
      continueHint.value = `最近保存「${h.sceneTitle || h.scene || '未命名'}」`
    }
})

onMounted(async () => {
  initContinueDraft()
  void loadSceneHighlights()
  try {
    await loadRecentWorks()
  } catch (e) { console.warn('作品库暂时不可用', e) }
})

</script>

<style scoped src="@/assets/css/home.css"></style>

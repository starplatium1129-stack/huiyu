<template>
  <article class="home-page">
    <section class="container home-opening" aria-label="画室序章">
      <div class="home-hero" :data-muse="homeMuse">
        <div class="hero-copy">
          <span class="hero-register">绘遇 HUIYU · AI 角色创作画室</span>
          <h1 class="hero-title">把喜欢的角色，<br /><span class="hero-title-accent">画进你的故事。</span></h1>
          <p class="hero-sub">选角色、挑场景，用 AI 生成二次元 CG。<br />从现成灵感开始，也能自己编排画面与光影。</p>
          <div class="ctas">
            <RouterLink :to="continueLink.to" class="btn btn-lg btn-primary" id="continueCta"><ArchiveIcon :name="continueIconName" /> {{ continueLink.label }}</RouterLink>
            <RouterLink to="/showcase" class="btn btn-lg btn-ghost">先看参考样张 <ArchiveIcon name="image" /></RouterLink>
          </div>
          <p class="continue-hint" v-if="continueHint">{{ continueHint }}</p>
          <div class="hero-muses" role="group" aria-label="首页角色视觉">
            <AnimatedSelection />
            <button type="button" :aria-pressed="homeMuse === 'nene'" @click="homeMuse = 'nene'"><span class="muse-marker muse-marker-nene" aria-hidden="true"></span> 绫地宁宁</button>
            <button type="button" :aria-pressed="homeMuse === 'natsume'" @click="homeMuse = 'natsume'"><span class="muse-marker muse-marker-natsume" aria-hidden="true"></span> 四季夏目</button>
          </div>
        </div>
        <aside class="hero-orbit" :class="{ 'has-fallback': heroFailed[homeMuse] }" aria-label="宁宁与夏目的角色视觉">
          <img v-if="!heroFailed.nene" class="hero-character nene" :class="{ 'is-current': homeMuse === 'nene' }" :src="heroAssets.nene" :alt="homeMuse === 'nene' ? '绫地宁宁' : ''" :aria-hidden="homeMuse !== 'nene'" width="1024" height="1344" sizes="(max-width: 768px) 100vw, 60vw" loading="eager" decoding="async" fetchpriority="high" @error="heroFailed.nene = true" />
          <div v-else class="hero-fallback nene" :class="{ 'is-current': homeMuse === 'nene' }" aria-hidden="true">
            <ArchiveIcon name="image" />
            <span class="hero-fallback-text">主视觉暂未加载</span>
          </div>
          <img v-if="!heroFailed.natsume" class="hero-character natsume" :class="{ 'is-current': homeMuse === 'natsume' }" :src="heroAssets.natsume" :alt="homeMuse === 'natsume' ? '四季夏目' : ''" :aria-hidden="homeMuse !== 'natsume'" width="1024" height="1344" sizes="(max-width: 768px) 100vw, 60vw" loading="eager" decoding="async" @error="heroFailed.natsume = true" />
          <div v-else class="hero-fallback natsume" :class="{ 'is-current': homeMuse === 'natsume' }" aria-hidden="true">
            <ArchiveIcon name="image" />
            <span class="hero-fallback-text">主视觉暂未加载</span>
          </div>
          <div class="orbit-label" aria-live="polite"><span>{{ homeMuse === 'nene' ? 'AYACHI NENE' : 'SHIKI NATSUME' }}</span><strong>{{ homeMuse === 'nene' ? '把温柔，留在这一帧。' : '平凡的今天，也值得珍藏。' }}</strong></div>
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
        <RouterLink
          v-for="h in recentWorks"
          :key="h.id"
          class="recent-card"
          :to="`/prompt-builder?regen=${encodeURIComponent(h.id)}`"
        >
          <div class="recent-cover" :data-image-id="h.image_id">
            <img v-if="coverUrl(h)" :src="coverUrl(h)" alt="" class="recent-cover-img" loading="lazy" decoding="async" />
            <ArchiveIcon v-else name="image" class="placeholder" />
          </div>
          <div class="recent-body">
            <div class="recent-title">{{ h.sceneTitle || h.scene || '未命名' }}</div>
            <div class="recent-meta">{{ charName(h.character) }} · {{ fmtDate(h.timestamp) }}</div>
          </div>
        </RouterLink>
      </div>
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
    <HomeArtJournal :scenes="featuredScenes" />

    <section class="container home-inspiration" aria-label="场景与角色灵感">
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
              <img
                v-if="!isPortraitFailed(c.id)"
                :key="portraitSrc(c.id)"
                :src="portraitSrc(c.id)"
                :alt="c.displayName"
                loading="lazy"
                decoding="async"
                @error="markPortraitFailure"
              />
              <span v-else class="pop-portrait-fallback" aria-hidden="true"><ArchiveIcon name="image" /></span>
              <span class="pop-cap">
                <span class="pop-cap-name">{{ c.displayName }}</span>
                <span class="pop-cap-franchise">{{ franchiseLabel(c.franchise) }}</span>
              </span>
            </RouterLink>
          </div>
        </div>
    </section>

    <!-- 创作入口 -->
    <section class="container home-section" data-reveal>
      <div class="home-section-head">
        <div>
          <span class="eyebrow">创作，从一个念头开始</span>
          <h2>今天，想创作些什么？</h2>
          <p class="hint">从画一张图，到讲一个故事。让灵感有个去处。</p>
        </div>
      </div>
      <div class="tools-grid">
        <RouterLink to="/prompt-builder" class="tool-card card-create card-level-2">
          <span class="tool-index" aria-hidden="true">01 / MAKE</span>
          <span class="ic"><ArchiveIcon name="spark" /></span><span class="t">开始绘制</span>
          <span class="d">选好角色与场景，把脑海中的画面画出来。</span>
          <span class="go">→ 打开</span>
        </RouterLink>
        <RouterLink to="/scene-explorer" class="tool-card card-create card-level-2">
          <span class="tool-index" aria-hidden="true">02 / SCENE</span>
          <span class="ic"><ArchiveIcon name="scene" /></span><span class="t">灵感场景</span>
          <span class="d">{{ sceneLibraryCopy }}</span>
          <span class="go">→ 打开</span>
        </RouterLink>
        <RouterLink to="/video-studio" class="tool-card card-create card-level-2">
          <span class="tool-index" aria-hidden="true">03 / MOTION</span>
          <span class="ic"><ArchiveIcon name="play" /></span><span class="t">故事短片</span>
          <span class="d">让静止的画面，成为一段会呼吸的故事。</span>
          <span class="go">→ 开始创作</span>
        </RouterLink>
        <RouterLink :to="`/chat?character=${homeMuse}`" class="tool-card card-create card-level-2">
          <span class="tool-index" aria-hidden="true">04 / ROOM</span>
          <span class="ic"><ArchiveIcon name="chat" /></span><span class="t">角色房间</span>
          <span class="d">与宁宁或夏目静享片刻独白，聊聊今天的心情。</span>
          <span class="go">→ 进入房间</span>
        </RouterLink>
        <!-- 宽屏下第 5 张卡拉通为横幅入口，避免 4+1 网格出现孤行 -->
        <RouterLink to="/showcase" class="tool-card card-create card-level-2 tool-card-banner">
          <span class="tool-index" aria-hidden="true">05 / ARCHIVE</span>
          <span class="ic"><ArchiveIcon name="image" /></span>
          <span class="banner-copy"><span class="t">参考画册</span><span class="d">翻阅角色与场景的定稿样张，找到下一张画的灵感。</span></span>
          <span class="go">→ 浏览完整画册</span>
        </RouterLink>
      </div>
    </section>

    <!-- 资料区 -->
    <section class="container home-section home-section-quiet" data-reveal>
      <div class="home-section-head">
        <div>
          <span class="eyebrow">资料与回顾</span>
          <h2>画室里的小抽屉</h2>
          <p class="hint">角色、画风、模型和旧作，都收在这里。</p>
        </div>
      </div>
      <div class="tools-grid">
        <RouterLink to="/character" class="tool-card card-create">
          <span class="tool-index" aria-hidden="true">05 / PROFILE</span>
          <span class="ic"><ArchiveIcon name="character" /></span><span class="t">角色档案</span>
          <span class="d">认识角色的模样、性格与故事。</span>
          <span class="go">→ 打开</span>
        </RouterLink>
        <RouterLink to="/style" class="tool-card card-create">
          <span class="tool-index" aria-hidden="true">06 / PALETTE</span>
          <span class="ic"><ArchiveIcon name="palette" /></span><span class="t">画风</span>
          <span class="d">探寻画面色阶、情绪氛围与色彩剧本。</span>
          <span class="go">→ 打开</span>
        </RouterLink>
        <RouterLink to="/lora" class="tool-card card-create">
          <span class="tool-index" aria-hidden="true">07 / MODEL</span>
          <span class="ic"><ArchiveIcon name="model" /></span><span class="t">模型</span>
          <span class="d">找到适合这次创作的模型与推荐设置。</span>
          <span class="go">→ 打开</span>
        </RouterLink>
        <RouterLink to="/gallery" class="tool-card card-create">
          <span class="tool-index" aria-hidden="true">08 / WORKS</span>
          <span class="ic"><ArchiveIcon name="gallery" /></span><span class="t">我的作品</span>
          <span class="d">以纯净原始画幅，安静收存属于你的每一张心动创作。</span>
          <span class="go">→ 打开</span>
        </RouterLink>
      </div>
    </section>

    <section class="container home-section" v-if="!recentWorks.length" data-reveal>
      <div class="home-section-head"><h2>最近创作</h2><RouterLink to="/gallery" class="link">打开我的作品 →</RouterLink></div>
      <div class="recent-grid">
        <ArchiveStatePanel
          class="recent-empty-state"
          compact
          kind="empty"
          title="还没有最近作品"
          message="画好之后，它会收进你的本地作品档案。"
        >
          <RouterLink to="/prompt-builder" class="btn btn-primary"><ArchiveIcon name="spark" /> 开始绘制</RouterLink>
        </ArchiveStatePanel>
      </div>
    </section>
  </article>
</template>

<script setup lang="ts">
import { popularPortraitSrc } from '@/utils/popularPortraitSource'
import { ref, computed, onMounted, onUnmounted, reactive, watch } from 'vue'
import SceneCard from '@/components/SceneCard.vue'
import { franchiseLabel } from '@/utils/franchiseLabel'
import HomeArtJournal from '@/components/home/HomeArtJournal.vue'
import HomeCreationGuide from '@/components/home/HomeCreationGuide.vue'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import ArchiveStatePanel from '@/components/visual/ArchiveStatePanel.vue'
import ArchiveIcon, { type ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'
import { artworkRepository } from '@/storage/artworkRepository'
import { readRecent } from '@/utils/sceneUX'
import { useScrollReveal } from '@/composables/useScrollReveal'
import { useSceneStore } from '@/stores/sceneStore'
import type { Scene } from '@/stores/sceneStore'
import { artworkTimestamp, type ArtworkRecord } from '@/types/artwork'

useScrollReveal()

const DRAFT_KEY = 'aics_pb_last_draft'

const sceneLibraryCopy = ref('招牌灵感瞬间，已悉数备好镜头与光影基调。')
const continueIconName = ref<ArchiveIconName>('spark')
const continueLink = ref({ to: '/scene-explorer', label: '选场景，开始创作' })
const continueHint = ref('先选喜欢的画面；确认参数后再生成。')
type HomeScene = Scene & { title?: string; mature?: boolean }

const recentWorks = ref<ArtworkRecord[]>([])
const recentScenes = ref<HomeScene[]>([])
const featuredScenes = ref<HomeScene[]>([])
const sceneStore = useSceneStore()
const coverUrls = reactive<Record<string, string>>({})
const homeMuse = ref<'nene' | 'natsume'>('nene')
// Bundled approved covers are authoritative; copied showcase editions may contain older home art.
const heroAssets = Object.freeze({
  nene: '/assets/characters/nene-home-cg-1024.webp',
  natsume: '/assets/characters/natsume-home-cg-1024.webp',
})

// ── 图片失败回退：每张图独立跟踪，失败只换占位不循环重试 ──
// 英雄图：按角色各记一个失败态；src 是内置常量，重试入口是用户切换 muse（watch 重置后重挂 img）。
const heroFailed = reactive({ nene: false, natsume: false })
watch(homeMuse, (muse) => { heroFailed[muse] = false })

// 热门横条：以完整 src（含 ?v= 版本）为键；版本变化产生新键自动重试，img :key 重挂避免
// 旧请求的 error 误标新 src。同一失败 src 在本页生命周期内不重复请求。
const portraitFailed = reactive<Record<string, boolean>>({})
function isPortraitFailed(id: string): boolean {
  return portraitFailed[portraitSrc(id)] === true
}
function markPortraitFailure(event: Event) {
  const el = event.currentTarget
  if (!(el instanceof HTMLImageElement)) return
  const src = el.getAttribute('src')
  if (src) portraitFailed[src] = true
}

/** 卸载标记：异步媒体读取回来时组件可能已经没了 */
let unmounted = false

// ── 热门角色：样张立绘横条（立绘来自展示库发布 assets/characters/popular-<id>.png） ──
const popularCharacters = computed(() => sceneStore.popularCharacters)
function portraitSrc(id: string): string {
  // 横条卡片仅 ~180px 宽，加载 1.2MB 原图曾把首页资源预算打爆 5 倍（16MB）。
  // 改用 build-character-thumbs.py 预生成的 360px WebP 缩略图（~19KB/张）；
  // 源 PNG 重发后需重跑该脚本（mtime 过期自动重建）。
  return popularPortraitSrc(id, sceneStore.version || 3)
}


function charName(id: string | undefined) {
  return id === 'nene' ? '宁宁' : id === 'natsume' ? '夏目' : id || '·'
}
function fmtDate(ts: string | number | undefined) {
  const value = typeof ts === 'number' || typeof ts === 'string' ? ts : 0
  return new Date(value).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}
function coverUrl(item: ArtworkRecord): string {
  return item.image_id ? coverUrls[item.image_id] || '' : ''
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
    sceneLibraryCopy.value = `${ids.length} 个招牌与精选，完整库共 ${scenes.length} 个。`

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

async function loadRecentWorks() {
  try {
    const history = await artworkRepository.readRecentHistory()
    // 历史按生成顺序 append，直接 slice 拿到的是最旧的三幅
    recentWorks.value = history.slice().sort((a, b) => artworkTimestamp(b) - artworkTimestamp(a)).slice(0, 3)

    if (!initContinueDraft() && recentWorks.value[0]) {
      const h = recentWorks.value[0]
      continueLink.value = { to: `/prompt-builder?regen=${encodeURIComponent(h.id)}`, label: '继续最近作品' }
      continueHint.value = `最近保存「${h.sceneTitle || h.scene || '未命名'}」`
    }

    await Promise.all(recentWorks.value.map(async h => {
      if (!h.image_id) return
      try {
        const blob = await artworkRepository.getImage(h.image_id)
        if (!blob) return
        // 组件可能在 await 期间就卸载了，这时候不该再建 URL
        if (unmounted) return
        if (coverUrls[h.image_id]) URL.revokeObjectURL(coverUrls[h.image_id])
        coverUrls[h.image_id] = URL.createObjectURL(blob)
      } catch {}
    }))
  } catch (e) { console.warn('读取历史失败', e) }
}

onMounted(async () => {
  initContinueDraft()
  void loadSceneHighlights()
  try {
    await loadRecentWorks()
  } catch (e) { console.warn('作品库暂时不可用', e) }
})

onUnmounted(() => {
  unmounted = true
  // 首页封面是 IndexedDB blob，不释放就会一直挂在内存里
  Object.keys(coverUrls).forEach((key) => {
    if (coverUrls[key]) URL.revokeObjectURL(coverUrls[key])
    delete coverUrls[key]
  })
})

</script>

<style scoped src="@/assets/css/home.css"></style>

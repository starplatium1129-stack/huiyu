<template>
  <article class="page character-page library-page character-editorial" style="--page-max:1600px">
    <header class="library-header"><div><div class="page-kicker">HUIYU / CHARACTER ARCHIVE</div><h1>角色档案</h1><p>认识她的故事，从一个心动的瞬间开始创作。</p></div><RouterLink to="/popular-scenes" class="btn btn-ghost"><ArchiveIcon name="image" />浏览角色场景</RouterLink></header>

    <ArchiveStatePanel
      v-if="loading"
      kind="loading"
      title="正在读取角色档案"
      message="身份资料、绑定模型与视觉特征正在从本机载入。"
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
      <div class="library-layout">
        <BrowsingCharacterDirectory :items="directoryItems" :selected-id="current?.id || ''" @select="selectCharacter" />
        <div class="library-detail">
      <section v-if="current" ref="profileAnchor" :style="{ '--portrait-ratio': portraitRatio }" class="character-hero card-direct card-level-3" data-reveal data-reveal-delay="1">
        <CharacterParticleStage :character-id="current.id" :name="current.name">
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
            <span class="portrait-badge"><ArchiveIcon name="image" /> {{ isPopularPortraitPending(current.id) ? '立绘待补' : isPopular ? '角色场景样张' : '角色立绘' }}</span>
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

      <details v-if="current" :key="current.id" class="character-production">
        <summary><span><ArchiveIcon name="image" />素材与模型</span><span class="production-hint">参考图可用状态 · LoRA 与触发词</span></summary>
        <div class="production-content">
          <CharacterAssetSummary :character-id="current.id" />
          <section v-if="current.lora" class="detail-section">
            <h3 class="lab">绑定 LoRA</h3>
            <div v-if="current.lora.name" class="char-lora">档案登记：<code>{{ current.lora.name }}</code></div>
            <div v-if="current.lora.trigger_words?.length" class="char-lora">触发词：<code>{{ current.lora.trigger_words.join(', ') }}</code></div>
            <div v-else class="char-lora">当前模型与触发词请在绘图工作台查看。</div>
          </section>
        </div>
      </details>

      <section v-if="characterReferences" class="char-reference-section card-direct card-level-2" data-reveal data-reveal-delay="1.5">
        <div class="recommend-head">
          <div>
            <div class="page-kicker">VISUAL REFERENCES</div>
            <h2 class="recommend-title">服装与四视角参考</h2>
            <p>选择服装，查看不同视角下的形象细节，再带入分镜创作。</p>
          </div>
          <RouterLink class="btn btn-primary btn-sm" :to="`/video-studio?mode=shots&character=${encodeURIComponent(current?.id || '')}&outfit=${encodeURIComponent(activeOutfit?.outfitId || '')}`">
            去分镜短片创作 ↗
          </RouterLink>
        </div>

        <!-- 多服装 / 形态切换器 -->
        <div v-if="characterReferences.outfits.length > 1" class="char-outfit-tabs" aria-label="角色服装与形态切换">
          <button
            v-for="outfit in characterReferences.outfits"
            :key="outfit.outfitId"
            type="button"
            class="char-outfit-tab"
            :class="{ active: activeOutfit?.outfitId === outfit.outfitId, 'tab-nsfw': outfit.isNsfw }"
            :aria-pressed="activeOutfit?.outfitId === outfit.outfitId"
            @click="selectedOutfitId = outfit.outfitId"
          >
            <ArchiveIcon :name="outfit.isNsfw ? 'lock' : 'wardrobe'" class="outfit-tab-icon" />
            <span class="outfit-tab-name">{{ outfit.outfitName }}</span>
          </button>
        </div>

        <div v-if="activeOutfit" class="char-reference-grid">
          <div
            v-for="(refItem, idx) in activeOutfit.references"
            :key="refItem.id"
            class="char-ref-card"
            role="button"
            :tabindex="refItem.url && !unavailableReferences.has(refItem.url) ? 0 : -1"
            :aria-disabled="!refItem.url || unavailableReferences.has(refItem.url)"
            :aria-label="refItem.url && !unavailableReferences.has(refItem.url) ? `查看 ${refItem.name} 高清大图` : `${refItem.name} · 本机暂无参考图`"
            @click="openRefViewer(idx)"
            @keydown.enter="openRefViewer(idx)"
            @keydown.space.prevent="openRefViewer(idx)"
          >
            <div class="char-ref-image-wrap">
              <img
                v-if="refItem.url && !unavailableReferences.has(refItem.url)"
                :src="resolveRuntimeUrl(`${refItem.url}?t=${refVersion}`)"
                :alt="refItem.name"
                @error="unavailableReferences.add(refItem.url)"
                class="char-ref-image"
                loading="lazy"
              />
              <!-- 2026-08-31 设计图基线占位：pending 无 url，显示待生成卡片不请求 404 -->
              <div v-else class="char-ref-image char-ref-pending">
                <ArchiveIcon name="spark" />
                <span>{{ refItem.url ? '本机暂无参考图' : '待生成' }}</span>
              </div>
              <span class="char-ref-badge">{{ refItem.shotType }}</span>
              <div v-if="refItem.url && !unavailableReferences.has(refItem.url)" class="char-ref-hover-hint"><ArchiveIcon name="spark" /> 点击查看细节</div>
            </div>
            <div class="char-ref-info">
              <h3 class="char-ref-title">{{ refItem.name }}</h3>
              <p class="char-ref-lens"><code>{{ refItem.lens }}</code></p>
              <p class="char-ref-desc">{{ current?.name }} · {{ activeOutfit.outfitName }}</p>
              <div class="char-ref-usages">
                <span v-for="usage in refItem.targetUsage" :key="usage" class="char-ref-tag">{{ usage }}</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- 4 视角参考基准高清放大审查灯箱 -->
      <Teleport to="body">
        <dialog
          ref="refDialogEl"
          class="char-ref-modal"
          aria-label="4 视角标准参考基准审查"
          @click.self="closeRefViewer"
          @cancel.prevent="closeRefViewer"
          @keydown="onRefKeydown"
        >
          <div v-if="activeRefModal" class="ref-modal-layout">
            <div class="ref-modal-art">
              <ZoomableImageViewer
                :src="resolveRuntimeUrl(`${activeRefModal.url}?t=${refVersion}`)"
                :alt="activeRefModal.name"
              >
                <template #fallback>
                  <div class="ref-fallback">参考图暂时无法读取</div>
                </template>
              </ZoomableImageViewer>
            </div>
            <div class="ref-modal-copy">
              <button class="ref-modal-close" type="button" aria-label="关闭审查" @click="closeRefViewer">
                <ArchiveIcon name="close" />
              </button>
              <div class="ref-modal-kicker">Cinematic 4-View Bible</div>
              <h2>{{ current?.name }} · {{ activeRefModal.name }}</h2>
              <div class="ref-modal-meta">
                <span class="ref-badge-tag">{{ activeRefModal.shotType }}</span>
                <span><code>{{ activeRefModal.lens }}</code></span>
                <span v-if="activeOutfit">{{ activeOutfit.outfitName }}</span>
              </div>
              <p class="ref-modal-desc">
                锁死五官轮廓、发丝高光、服饰缝线与身材比例。支持滚轮 100%~400% 缩放与抓手平移，严密审查跨镜一致性。
              </p>
              <div class="ref-modal-usages">
                <span class="usages-title">标准适用阶段：</span>
                <div class="usages-chips">
                  <span v-for="u in activeRefModal.targetUsage" :key="u" class="usage-chip">{{ u }}</span>
                </div>
              </div>
              <div class="ref-modal-actions">
                <StudioTooltip anchor content="上一视角 (键盘 ←)">
                  <button class="btn btn-ghost btn-sm" type="button" :disabled="nextRefIndex(-1) < 0" aria-label="上一视角" @click="moveRef(-1)">
                    ← <kbd>←</kbd>
                  </button>
                </StudioTooltip>
                <StudioTooltip anchor content="下一视角 (键盘 →)">
                  <button
                    class="btn btn-ghost btn-sm"
                    type="button"
                    :disabled="nextRefIndex(1) < 0"
                    aria-label="下一视角"
                    @click="moveRef(1)"
                  >
                    <kbd>→</kbd> →
                  </button>
                </StudioTooltip>
                <RouterLink
                  class="btn btn-primary btn-sm"
                  :to="`/video-studio?mode=shots&character=${encodeURIComponent(current?.id || '')}&outfit=${encodeURIComponent(activeOutfit?.outfitId || '')}`"
                >
                  去分镜短片创作 ↗
                </RouterLink>
              </div>
            </div>
          </div>
        </dialog>
      </Teleport>

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
          <RouterLink v-for="s in recommendations" :key="s.id" class="card-direct"
            :to="isPopular && current
              ? `/prompt-builder?popular=${encodeURIComponent(current.id)}&blueprint=${encodeURIComponent(s.id)}`
              : '/prompt-builder?scene='+encodeURIComponent(s.id)">
            <div class="cg-title">{{ s.title }}</div>
            <div v-if="recommendationReason(s.id)" class="cg-reason">{{ recommendationReason(s.id) }}</div>
            <div class="cg-story">{{ s.story }}</div>
          </RouterLink>
        </div>
      </section>
        </div>
      </div>
    </template>
  </article>
</template>

<script setup lang="ts">
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'

import { useFluidDialog } from '@/composables/useFluidDialog'
import CharacterAssetSummary from '@/components/library/CharacterAssetSummary.vue'
import CharacterParticleStage from '@/components/library/CharacterParticleStage.vue'
import { ref, computed, onMounted, nextTick, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSceneStore } from '@/stores/sceneStore'
import BrowsingCharacterDirectory from '@/components/library/BrowsingCharacterDirectory.vue'
import ArchiveStatePanel from '@/components/visual/ArchiveStatePanel.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import ZoomableImageViewer from '@/components/visual/ZoomableImageViewer.vue'
import { usePortraitFallback } from '@/composables/usePortraitFallback'
import { useScrollReveal } from '@/composables/useScrollReveal'
import { franchiseLabel, franchiseKey } from '@/utils/franchiseLabel'
import { ensureCharacterReferencesLoaded, getCharacterReferences } from '@/utils/characterReferenceData'
import {
  parseCharacterProfiles, popularPortraitSrc, isPopularPortraitPending,
  parseCharacterScenes,
  type CharacterProfile,
  type CharacterScene,
} from '@/utils/characterProfiles'

const sceneStore = useSceneStore()
const route = useRoute()
const router = useRouter()
const characters = ref<CharacterProfile[]>([])
const scenes = ref<CharacterScene[]>([])
const loading = ref(true)
const current = ref<CharacterProfile | null>(null)
const bgExpanded = ref(false)
useScrollReveal()

const directoryItems = computed(() => characters.value.map(character => ({
  id: character.id, name: character.name, source: character.source, aliases: character.alias,
  image: character.type === 'popular' ? popularPortraitSrc(character.id) : character.portrait?.image,
})))

const portraitSources = computed(() => {
  const profile = current.value
  const main = profile?.portrait?.image || ''
  return { id: profile?.id || '', main,
    thumb: profile?.type === 'popular' ? popularPortraitSrc(profile.id) : '' }
})
const { view: portraitView, ratio: portraitRatio, fail: failPortrait,
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

const profileAnchor = ref<HTMLElement | null>(null)
function selectCharacter(id: string) {
  const found = characters.value.find(c => String(c.id) === id)
  if (!found) return
  current.value = found
  if (route.query.character !== id) void router.replace({ query: { ...route.query, character: id } })
  selectedOutfitId.value = ''
  bgExpanded.value = false
  // 点击卡片联动档案大卡：档案区不在视口内才平滑滚过去（已在视野内不打扰浏览）
  void nextTick(() => {
    const anchor = profileAnchor.value
    if (!anchor) return
    const rect = anchor.getBoundingClientRect()
    const inView = rect.top >= 70 && rect.top < window.innerHeight * 0.9
    if (inView) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    anchor.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' })
  })
}
function tagClass(index: unknown) { return 'm' + (Number(index) % 6) }

const characterReferences = computed(() => {
  if (!current.value) return undefined
  return getCharacterReferences(current.value.id)
})
const selectedOutfitId = ref<string>('')
const activeOutfit = computed(() => {
  if (!characterReferences.value?.outfits?.length) return undefined
  if (selectedOutfitId.value) {
    const found = characterReferences.value.outfits.find(o => o.outfitId === selectedOutfitId.value)
    if (found) return found
  }
  return characterReferences.value.outfits.find(o => o.isDefault) || characterReferences.value.outfits[0]
})
const unavailableReferences = ref(new Set<string>())
const refVersion = ref(Date.now())

const refDialogEl = ref<HTMLDialogElement | null>(null)
const refMotion = useFluidDialog(refDialogEl)
const activeRefIndex = ref(-1)
const activeRefModal = computed(() => {
  if (activeRefIndex.value < 0 || !activeOutfit.value?.references) return null
  return activeOutfit.value.references[activeRefIndex.value] ?? null
})

function openRefViewer(index: number) {
  const refItem = activeOutfit.value?.references?.[index]
  // 2026-08-31 设计图基线占位：pending 无 url，不打开查看器（避免加载坏图）。
  if (!refItem || !refItem.url || unavailableReferences.value.has(refItem.url)) return
  activeRefIndex.value = index
  nextTick(() => {
    refMotion.open()
  })
}

function closeRefViewer() {
  refMotion.close(() => { activeRefIndex.value = -1 })
}

function nextRefIndex(delta: number): number {
  if (!activeOutfit.value?.references.length) return -1
  const len = activeOutfit.value.references.length
  for (let next = activeRefIndex.value + delta; next >= 0 && next < len; next += delta) {
    const item = activeOutfit.value.references[next]
    if (item?.url && !unavailableReferences.value.has(item.url)) {
      return next
    }
  }
  return -1
}
function moveRef(delta: number) {
  const next = nextRefIndex(delta)
  if (next >= 0) activeRefIndex.value = next
}
function onRefKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
  if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]')) return
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  event.preventDefault()
  moveRef(event.key === 'ArrowLeft' ? -1 : 1)
}

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

const loadError = ref('')

async function loadProfiles() {
  loading.value = true
  loadError.value = ''
  try {
    // 角色档案首屏只需要目录壳；场景/蓝图画布随后后台补齐，不能阻塞粒子展台挂载。
    await sceneStore.loadCharacterShell()
    characters.value = parseCharacterProfiles(sceneStore.characters)
    const requested = typeof route.query.character === 'string' ? route.query.character : ''
    current.value = characters.value.find(c => c.id === requested) || characters.value[0] || null
    void sceneStore.load().then(() => {
      scenes.value = parseCharacterScenes(sceneStore.scenes)
    }).catch((e) => {
      console.warn('character scene data load failed', e)
    })
  } catch (e) {
    console.warn('character data load failed', e)
    loadError.value = String(e instanceof Error ? e.message : e)
  }
  loading.value = false
}

watch(() => current.value?.id, id => {
  if (id) void ensureCharacterReferencesLoaded(id).catch(() => undefined)
})
onMounted(() => {
  void loadProfiles()
})
</script>

<style scoped src="@/assets/css/character-view.css"></style>
<style scoped src="@/assets/css/character-editorial.css"></style>

<template>
  <article class="page scenario-page creative-library-page" :style="scenarioCharacterTheme">
    <CreativeLibraryHeader chapter="scenario" />
    <div class="scenario-workspace">
      <section class="scenario-shelf" aria-label="选择故事" data-route-arrive>
        <header class="scenario-library-heading">
          <div class="scenario-library-title-group">
            <h2 data-screentone-furniture>故事手帖封皮架</h2>
            <p>{{ SCENARIOS.length }} 部连贯分幕画集 · 当前卡司：{{ activeCastDisplayName }}{{ casting.outfit.value ? `（${casting.outfit.value.name}）` : '' }}</p>
          </div>
          <div class="scenario-cast-bar" role="group" aria-label="卡司与衣装">
            <div v-if="!casting.castId.value" class="char-toggle studio-segments" data-fluid-glass role="group" aria-label="故事主角">
              <AnimatedSelection />
              <button
                v-for="c in CHARACTER_OPTIONS"
                :key="c"
                class="char-btn"
                :class="{ active: currentChar === c }"
                :aria-pressed="currentChar === c"
                type="button"
                @click="currentChar = c"
              >
                <span class="cast-mini-avatar" aria-hidden="true">
                  <RuntimeImage :src="protagonistAvatar(c)" alt="">
                    <template #fallback><ArchiveIcon :name="c" /></template>
                  </RuntimeImage>
                </span>
                <span class="studio-control-label">{{ c === 'nene' ? '宁宁' : '夏目' }}</span>
              </button>
            </div>
            <div class="scenario-cast-capsules">
              <StudioSelect
                v-model="casting.castId.value"
                :options="casting.options.value"
                size="sm"
                inline
                searchable
                search-placeholder="搜索目录角色…"
                label="故事角色"
                placeholder="卡司角色"
                class="scenario-cast-select"
              >
                <template #value>
                  <span class="cast-capsule-value">
                    <span class="cast-mini-avatar" aria-hidden="true">
                      <RuntimeImage :src="activeCastAvatarUrl" alt="">
                        <template #fallback><ArchiveIcon name="character" /></template>
                      </RuntimeImage>
                    </span>
                    <span class="cast-capsule-text">{{ casting.character.value ? casting.character.value.displayName : '目录卡司' }}</span>
                  </span>
                </template>
                <template #option="{ option }">
                  <span class="cast-option-row">
                    <span class="cast-mini-avatar" aria-hidden="true">
                      <RuntimeImage :src="optionAvatarUrl(String(option.value))" alt="">
                        <template #fallback><ArchiveIcon name="character" /></template>
                      </RuntimeImage>
                    </span>
                    <span>{{ option.label }}</span>
                  </span>
                </template>
              </StudioSelect>
              <StudioSelect
                v-if="casting.castId.value"
                v-model="casting.outfitId.value"
                :options="casting.outfitOptions.value"
                size="sm"
                inline
                label="故事衣装"
                class="scenario-outfit-select"
              >
                <template #value="{ label }">
                  <span class="cast-capsule-value">
                    <ArchiveIcon name="wardrobe" />
                    <span class="cast-capsule-text">{{ label || '选择衣装' }}</span>
                  </span>
                </template>
              </StudioSelect>
            </div>
          </div>
        </header>
        <p v-if="casting.error.value || !casting.ready.value" class="scenario-cast-feedback" role="status">
          <span>{{ casting.error.value || '所选角色或衣装尚未读取，请重新选择或读取目录' }}</span>
          <button type="button" class="btn btn-ghost btn-sm" :disabled="casting.loading.value" @click="casting.reload">重新读取</button>
        </p>
        <p v-if="referenceError || referenceRetryStarted" class="library-reference-feedback">
          <span role="status">{{ loadingReferences ? '正在重新读取样张清单…' : referenceError || '样张清单已更新' }}</span>
          <button type="button" class="btn btn-ghost btn-sm scenario-reference-retry" :aria-disabled="loadingReferences" @click="retryReferences">
            <ArchiveIcon name="refresh" />{{ loadingReferences ? '正在读取…' : '重新读取封面' }}
          </button>
        </p>
        <div class="scenario-list" v-content-motion:fade="`${currentChar}:${casting.castId.value}`" role="group" aria-label="故事手帖封皮架">
          <RuntimeImage v-for="(s, sIndex) in SCENARIOS" :key="s.id" :src="resolveScenarioCover(s.id, sIndex).src" v-slot="{ image, loaded, failed }">
            <article class="scenario-book" :class="{ 'cover-failed': failed }">
              <button
                type="button"
                class="scenario-card"
                :class="{ active: activeScenario?.id === s.id }"
                :aria-pressed="activeScenario?.id === s.id"
                @click="openScenario(s)"
              >
                <span
                  class="scenario-cover"
                  :data-character="casting.castId.value || currentChar"
                  :data-cover-kind="resolveScenarioCover(s.id, sIndex).kind"
                  :data-scenario="s.id"
                >
                  <img
                    v-if="image.src && !failed"
                    v-bind="image"
                    :class="{ ready: loaded }"
                    :alt="`${activeCastDisplayName} · ${s.name}氛围封面`"
                    width="560"
                    height="818"
                    loading="lazy"
                    decoding="async"
                  />
                  <span class="scenario-cover-badge" aria-hidden="true">VOL.0{{ sIndex + 1 }} · {{ s.acts.length }} ACTS</span>
                  <span v-if="!loaded" class="scenario-cover-missing" role="status">
                    <ArchiveIcon :name="s.iconName" />
                    <span>{{ failed ? '封面加载失败' : image.src ? '正在载入封面…' : loadingReferences ? '正在翻开画册…' : '氛围参考暂未连接' }}</span>
                  </span>
                </span>
                <span class="scenario-book-copy">
                  <span class="scenario-book-title">
                    <strong class="scenario-name">{{ s.name }}</strong>
                    <LibraryChoiceMark :selected="activeScenario?.id === s.id" />
                  </span>
                  <span class="scenario-desc">{{ s.desc }}</span>
                  <span class="scenario-count">
                    <span>{{ s.acts.length }} 幕故事 · {{ activeCastDisplayName }}</span>
                    <span lang="en">{{ s.en }}</span>
                  </span>
                </span>
                <CardEdgeLight />
              </button>
              <button
                v-if="failed"
                type="button"
                class="btn btn-ghost btn-sm scenario-cover-retry"
                :aria-label="`重新读取${activeCastDisplayName}的《${s.name}》封面`"
                @click="retryCover(s.id, sIndex, $event)"
              >
                <ArchiveIcon name="refresh" />重新读取封面
              </button>
            </article>
          </RuntimeImage>
        </div>
      </section>
      <section v-if="activeScenario" ref="reader" class="viewer" aria-label="分幕手帖" tabindex="-1" data-route-arrive>
        <header class="viewer-header-row">
          <div>
            <span class="scenario-kicker">分幕手帖 · {{ activeScenario.acts.length }} 幕 · {{ activeCastDisplayName }}</span>
            <h2 class="viewer-h2" data-screentone-furniture><ArchiveIcon :name="activeScenario.iconName" />{{ activeScenario.name }}</h2>
            <p class="viewer-desc">{{ activeScenario.desc }}</p>
          </div>
          <button class="btn btn-primary scenario-to-video" type="button" @click="sendToVideoStudio"><ArchiveIcon name="clap" />制作分镜短片</button>
        </header>
        <div class="acts" :data-act-count="activeScenario.acts.length" v-content-motion:up="`${activeScenario.id}:${currentChar}:${casting.castId.value}`">
          <article
            v-for="{ act: a, warnings, modules } in renderedActs"
            :key="activeScenario.id + a.n"
            class="act"
            :data-act="a.n"
            :data-mood="actMoodTone(a.emotion)"
          >
            <div class="act-heading">
              <span class="act-num">{{ a.n }}</span>
              <div class="act-heading-copy">
                <h3 class="act-title">{{ a.title }}</h3>
                <span class="act-en" lang="en">{{ a.en }}</span>
              </div>
              <span class="act-emotion"><i aria-hidden="true" />{{ a.emotion }}</span>
            </div>
            <div class="act-intent">
              <span class="act-framing" :style="{ '--act-ratio': resInfo(a.res).dim.replace('×', ' / ') }" aria-hidden="true">
                <span class="act-framing-corners" />
                <ArchiveIcon :name="frameIcon(a.res)" />
                <small class="act-framing-label">{{ a.res }}</small>
              </span>
              <div class="act-intent-copy">
                <p class="act-desc">{{ a.desc }}</p>
              </div>
            </div>
            <div class="act-format">
              <span>{{ activeCastDisplayName }}{{ casting.outfit.value ? ` · ${casting.outfit.value.name}` : '' }} · {{ a.res }}</span>
              <span>{{ resInfo(a.res).dim }}</span>
            </div>
            <div class="act-actions">
              <RouterLink v-if="casting.ready.value" :to="{ path: '/prompt-builder', query: { scenario: activeScenario.id, act: a.n, ...casting.query.value } }" class="btn btn-ghost">绘制这一幕</RouterLink>
              <button type="button" class="btn btn-quiet" @click="sendToVideoStudio(a.n)">加入分镜</button>
              <StudioCopyButton class="btn btn-quiet" label="复制 Prompt" :content-key="`${activeScenario.id}:${a.n}:${currentChar}:${casting.castId.value}:${casting.outfitId.value}`" :action="() => copyPrompt(a)" />
            </div>
            <details class="act-details" :open="expandedActs.includes(a.n)" :data-scenario="activeScenario.id" :data-act="a.n" @toggle="syncAct">
              <StudioDisclosureSummary><span>五层提示词与参数</span></StudioDisclosureSummary>
              <div class="act-details-body" data-disclosure-content>
                <p class="act-settings">{{ LOCK_PARAMS }}</p>
                <p class="res-rec">{{ resInfo(a.res).reason }} · {{ resInfo(a.res).vram }}</p>
                <div v-if="warnings.length" class="art-warn show"><ArchiveIcon name="warning" />本幕有 {{ warnings.length }} 个违反美术规范的标签: {{ warnings.join(', ') }}</div>
                <div class="prompt-label">正向草稿 · 五层语义着色（工作台按所选模型编译）</div>
                <div class="prompt-code">
                  <span v-for="(module, index) in modules" :key="index" class="mod" :class="module.style">
                    <em class="mod-layer-tag">{{ module.label }}</em>
                    <span class="mod-tokens">
                      <template v-for="(tag, tagIndex) in module.tags" :key="tagIndex">
                        {{ tagIndex ? ', ' : '' }}<span v-if="tag.warn" class="violate">{{ tag.text }}</span><template v-else>{{ tag.text }}</template>
                      </template>
                    </span>
                  </span>
                </div>
                <div class="neg-section">
                  <div class="prompt-label prompt-label-neg">本幕排除项</div>
                  <p class="act-settings">基础负向由工作台所选模型管理</p>
                  <div class="neg-output">{{ a.neg }}</div>
                </div>
              </div>
            </details>
          </article>
        </div>
        <footer v-if="casting.ready.value" class="scenario-handoff">
          <RouterLink :to="{ path: '/prompt-builder', query: { scenario: activeScenario.id, ...casting.query.value } }" class="btn btn-ghost">
            <ArchiveIcon name="scene" />前往工作台绘制
          </RouterLink>
        </footer>
      </section>
    </div>
  </article>
</template>

<script setup lang="ts">
import RuntimeImage from '@/components/visual/RuntimeImage.vue'
import { copyWithFeedback } from '@/composables/useCopyFeedback'
import CreativeLibraryHeader from '@/components/library/CreativeLibraryHeader.vue'
import LibraryChoiceMark from '@/components/library/LibraryChoiceMark.vue'
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useVideoStore, type StagedScenarioAct } from '@/stores/videoStore'
import { useSceneStore } from '@/stores/sceneStore'
import { useToast } from '@/composables/useToast'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import CardEdgeLight from '@/components/visual/CardEdgeLight.vue'
import StudioCopyButton from '@/components/ui/StudioCopyButton.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import { useScenarioCasting } from '@/composables/scene/useScenarioCasting'
import { scenarioCastPrompt } from '@/utils/scenarioCasting'
import { useMoodReferences } from '@/composables/useMoodReferences'
import { useCharacterAtmosphere } from '@/composables/useCharacterAtmosphere'
import { popularPortraitSrc } from '@/utils/popularPortraitSource'
import { characterArtEntry } from '@/platform/characterArtState'
import { CHARACTERS } from '@/config/characters'
import { companionChatAvatars } from '@/config/companionChatAvatars'
import { focusReadingPanel } from '@/utils/focusReadingPanel'
import { BANNED_TAGS } from '@/utils/promptDiagnostics'
import {
  SCENARIOS,
  SCENARIO_RES_MAP,
  SCENARIO_CHARACTERS,
  type Scenario,
  type ScenarioAct,
  type ScenarioCharacter,
  type ScenarioResolution,
} from '@/config/scenarios'

const videoStore = useVideoStore()
const sceneStore = useSceneStore()
const router = useRouter()
const route = useRoute()

const LOCK_PARAMS = '底模参数由工作台按引擎自动锁定'
const RES_MAP = SCENARIO_RES_MAP
const CHARACTER_OPTIONS = [...SCENARIO_CHARACTERS] as const

function routeSelection() {
  const id = route.query.scenario
  const scenario = (typeof id === 'string' && SCENARIOS.find(scenario => scenario.id === id)) || SCENARIOS[0] || null
  const requestedActs = new Set(typeof route.query.acts === 'string' ? route.query.acts.split(',') : [])
  return {
    scenario,
    character: SCENARIO_CHARACTERS.find(character => character === route.query.char) ?? 'nene',
    acts: (scenario?.acts ?? []).map(act => act.n).filter(act => requestedActs.has(act)),
  }
}
const initialSelection = routeSelection()
const activeScenario = ref<Scenario | null>(initialSelection.scenario)
const reader = ref<HTMLElement | null>(null)
let readerRequest = 0
const currentChar = ref<ScenarioCharacter>(initialSelection.character)
const casting = useScenarioCasting(currentChar)
const expandedActs = ref(initialSelection.acts)

const activeThemeCharacterId = computed(() => casting.castId.value || currentChar.value)
const scenarioCharacterTheme = useCharacterAtmosphere(
  () => activeThemeCharacterId.value,
  () => sceneStore.characters,
)

const activeCastDisplayName = computed(() =>
  casting.character.value?.displayName || (currentChar.value === 'nene' ? '宁宁' : '夏目'),
)

function protagonistAvatar(char: ScenarioCharacter): string {
  return companionChatAvatars[char] || characterArtEntry(char)?.thumbnailUrl || CHARACTERS[char]?.image || ''
}

function optionAvatarUrl(id: string): string {
  if (!id) return protagonistAvatar(currentChar.value)
  if (id === 'nene' || id === 'natsume') return protagonistAvatar(id)
  return popularPortraitSrc(id)
}

const activeCastAvatarUrl = computed(() => optionAvatarUrl(casting.castId.value))

let restoringSelection = false
watch([() => route.path, () => route.query.scenario, () => route.query.char, () => route.query.acts], () => {
  if (route.path !== '/scenario') { readerRequest++; return }
  const selection = routeSelection()
  if (activeScenario.value?.id !== selection.scenario?.id || currentChar.value !== selection.character) readerRequest++
  restoringSelection = true
  activeScenario.value = selection.scenario
  currentChar.value = selection.character
  expandedActs.value = selection.acts
  restoringSelection = false
}, { flush: 'sync' })
watch([() => activeScenario.value?.id, currentChar, () => expandedActs.value.join(',')], ([scenario, character], [previousScenario]) => {
  if (restoringSelection || route.path !== '/scenario' || !scenario) return
  if (scenario !== previousScenario) {
    restoringSelection = true
    expandedActs.value = []
    restoringSelection = false
  }
  const acts = expandedActs.value.join(',')
  const selection = routeSelection()
  if (scenario === selection.scenario?.id && character === selection.character && acts === selection.acts.join(',')) return
  const query = { ...route.query }
  query.scenario = scenario
  query.char = character
  if (acts) query.acts = acts
  else delete query.acts
  void router.replace({ path: route.path, query, hash: route.hash }).catch(() => {})
}, { flush: 'sync' })
function syncAct(event: Event) {
  const details = event.target
  const scenario = activeScenario.value
  if (!(details instanceof HTMLDetailsElement)) return
  const act = details.dataset.act
  if (!act || !details.isConnected || details.closest('[inert]') || route.path !== '/scenario'
    || details.dataset.scenario !== scenario?.id || !scenario?.acts.some(item => item.n === act)) return
  if (expandedActs.value.includes(act) === details.open) return
  const open = new Set(expandedActs.value)
  if (details.open) open.add(act)
  else open.delete(act)
  expandedActs.value = scenario.acts.map(act => act.n).filter(act => open.has(act))
}

// Covers are atmosphere references, never generated frames for an act.
const COVER_IDS: Record<string, Record<ScenarioCharacter, string>> = {
  promise: { nene: 'sc001', natsume: 'sc011' },
  rainy: { nene: 'sc007', natsume: 'sc069' },
  sakura: { nene: 'sc002', natsume: 'sc013' },
}
const { loading: loadingReferences, error: referenceError, reload: reloadReferences, referenceUrl, retryReference,
  entries: showcaseEntries, thumbUrl: showcaseThumbUrl } = useMoodReferences()
const referenceRetryStarted = ref(false)
const portraitRetryVersion = ref<number | undefined>(undefined)

const castSafeShowcaseEntries = computed(() => {
  const id = casting.castId.value
  if (!id) return []
  return showcaseEntries.value.filter(entry => entry.char === id && entry.rating === 'All')
})

function resolveScenarioCover(scenarioId: string, scenarioIndex: number): { src: string; kind: 'scene' | 'portrait'; assetId: string } {
  const castId = casting.castId.value
  if (!castId) {
    const id = COVER_IDS[scenarioId]?.[currentChar.value] || ''
    return { src: referenceUrl(id), kind: 'scene', assetId: id }
  }
  const safeList = castSafeShowcaseEntries.value
  const matched = safeList[scenarioIndex]
  if (matched) {
    return { src: showcaseThumbUrl(matched.id), kind: 'scene', assetId: matched.id }
  }
  return {
    src: popularPortraitSrc(castId, portraitRetryVersion.value),
    kind: 'portrait',
    assetId: castId,
  }
}

function retryCover(scenarioId: string, scenarioIndex: number, event: MouseEvent) {
  const origin = event.currentTarget
  if (origin instanceof HTMLElement && document.activeElement === origin)
    origin.closest('.scenario-book')?.querySelector<HTMLElement>('.scenario-card')?.focus({ preventScroll: true })
  const cover = resolveScenarioCover(scenarioId, scenarioIndex)
  if (cover.kind === 'scene') retryReference(cover.assetId)
  else portraitRetryVersion.value = Date.now()
}

function retryReferences() {
  if (loadingReferences.value) return
  referenceRetryStarted.value = true
  void reloadReferences().catch(() => {})
}

function frameIcon(res: ScenarioResolution) {
  return res === 'Close-up' ? 'closeup' : res === 'Wide CG' || res === 'Full CG' ? 'wideshot' : 'midshot'
}

type ActMoodTone = 'joy' | 'love' | 'calm' | 'sad' | 'tension' | 'warmth'
const EMOTION_TONE_MAP: Record<string, ActMoodTone> = {
  '期待': 'joy',
  '开心': 'joy',
  '羞涩': 'love',
  '亲密': 'love',
  '温柔': 'warmth',
  '幸福': 'warmth',
  '失落': 'sad',
  '紧张': 'tension',
}
function actMoodTone(emotion: string): ActMoodTone {
  return EMOTION_TONE_MAP[emotion] || 'warmth'
}

function norm(t: string) { return t.split(/[,\r\n\u2028\u2029]+/).map(s => s.trim().replace(/[\s-]+/g,'_')).filter(Boolean).join(', ') }
function resInfo(res: ScenarioResolution) { return RES_MAP[res] }
function violations(a: ScenarioAct) {
  const lower = a.prompt.toLowerCase()
  return BANNED_TAGS.filter(b => lower.includes(b.toLowerCase()))
}
function substitutePrompt(tpl: string, char: ScenarioCharacter) {
  return scenarioCastPrompt(tpl, char, casting.character.value, casting.outfit.value)
}
function buildFullPrompt(a: ScenarioAct, char: ScenarioCharacter) {
  return norm(substitutePrompt(a.prompt, char))
}

const MODULE_CLASSES = ['m-q','m-c','m-cl','m-s','m-e','m-sh','m-co','m-l','m-d','m-lora'] as const
const MODULE_LABELS = ['质量', '角色', '衣装', '场景', '情绪', '景别', '构图', '光影', '细节', '引擎'] as const
const bannedTerms = BANNED_TAGS.map(tag => tag.toLowerCase())
function renderModules(a: ScenarioAct) {
  const char = currentChar.value
  const modPrompt = substitutePrompt(a.prompt, char)
  const lines = [...modPrompt.split('\n'), 'LoRA 与采样参数由工作台引擎自动管理']
  return lines.map((line, index) => ({
    style: MODULE_CLASSES[index] || 'm-q',
    label: MODULE_LABELS[index] || '标签',
    tags: line.split(',').map(tag => {
      const text = tag.trim()
      const lower = text.toLowerCase()
      return { text, warn: bannedTerms.some(term => lower.includes(term)) }
    }),
  }))
}

const renderedActs = computed(() => (activeScenario.value?.acts ?? []).map(act => ({
  act, warnings: violations(act), modules: renderModules(act),
})))

async function copyPrompt(a: ScenarioAct) {
  if (!casting.ready.value) { showToast('请先读取所选角色与衣装'); return false }
  const text = buildFullPrompt(a, currentChar.value)
  return copyWithFeedback(text, '已复制本幕提示词')
}

async function openScenario(s: Scenario) {
  const request = ++readerRequest
  activeScenario.value = s
  await nextTick()
  if (request === readerRequest) focusReadingPanel(reader.value)
}

function scenarioShotSize(res: ScenarioResolution): StagedScenarioAct['shotSize'] {
  if (res === 'Close-up') return 'closeup'
  if (res === 'Half-body' || res === 'Portrait') return 'medium'
  return 'wide'
}

function sendToVideoStudio(actId?: string | Event) {
  const scenario = activeScenario.value
  if (!scenario) return
  if (!casting.ready.value) { showToast('请先读取或重新选择故事角色与衣装'); return }
  const characterId = casting.character.value?.id || currentChar.value
  const outfitId = casting.outfit.value?.id
  const acts: StagedScenarioAct[] = scenario.acts.filter(act => typeof actId !== 'string' || act.n === actId).map(act => ({
    prompt: `${act.desc}。${act.emotion}的氛围。`,
    dialogue: '',
    shotSize: scenarioShotSize(act.res),
    camera: 'still',
    motion: 'natural',
    duration: 3,
    characterId,
    storyOrigin: { scenarioId: scenario.id, actId: act.n, title: `${scenario.name} · ${act.title}`, characterId, outfitId, outfitProse: outfitId ? undefined : scenario.outfitProse },
  }))
  if (!videoStore.stageScenarioActs(acts)) {
    showToast('跨页上下文写入失败')
    return
  }
  void router.push('/video-studio?mode=shots')
}

const { show: showToast } = useToast()
</script>

<style scoped src="@/assets/css/scenario-artbook.css"></style>

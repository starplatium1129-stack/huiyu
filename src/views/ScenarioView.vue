<template>
  <article class="page scenario-page creative-library-page">
    <CreativeLibraryHeader title="剧本模式" description="从相遇到心动，把故事一幕幕留下。" />
    <header class="scenario-library-heading">
      <div><h2>选一本故事手帖</h2><p>{{ SCENARIOS.length }} 本故事 · 封面为氛围参考</p></div>
      <div class="char-toggle studio-segments" data-fluid-glass role="group" aria-label="剧本角色">
        <AnimatedSelection />
        <button v-for="c in CHARACTER_OPTIONS" :key="c" class="char-btn" :class="{ active: currentChar === c }" :aria-pressed="currentChar === c" type="button" @click="currentChar = c"><ArchiveIcon :name="c" /><span class="studio-control-label">{{ c === 'nene' ? '宁宁' : '夏目' }}</span></button>
      </div>
    </header>
    <p v-if="referenceError || referenceRetryStarted" class="library-reference-feedback"><span role="status">{{ loadingReferences ? '正在重新读取样张清单…' : referenceError || '样张清单已更新' }}</span><button type="button" class="btn btn-ghost btn-sm scenario-reference-retry" :aria-disabled="loadingReferences" @click="retryReferences"><ArchiveIcon name="refresh" />{{ loadingReferences ? '正在读取…' : '重新读取封面' }}</button></p>
    <div class="scenario-workspace" data-route-arrive>
      <div class="scenario-list" v-content-motion:fade="currentChar" role="group" aria-label="故事手帖">
        <RuntimeImage v-for="s in SCENARIOS" :key="s.id" :src="referenceUrl(coverId(s.id))" v-slot="{ image, loaded, failed }">
          <article class="scenario-book" :class="{ 'cover-failed': failed }">
            <button type="button" class="scenario-card" :class="{ active: activeScenario?.id === s.id }" :aria-pressed="activeScenario?.id === s.id" @click="openScenario(s)">
              <span class="scenario-cover" :data-character="currentChar">
                <img v-if="image.src && !failed" v-bind="image" :class="{ ready: loaded }" :alt="(currentChar === 'nene' ? '宁宁' : '夏目') + ' · ' + s.name + '氛围参考'" width="560" height="818" loading="lazy" decoding="async" />
                <span v-if="!loaded" class="scenario-cover-missing" role="status"><ArchiveIcon :name="s.iconName" /><span>{{ failed ? '封面加载失败' : image.src ? '正在载入封面…' : loadingReferences ? '正在翻开画册…' : '氛围参考暂未连接' }}</span></span>
              </span>
              <span class="scenario-book-copy tw:grid tw:gap-s-2 tw:p-s-4"><span class="scenario-book-title tw:flex tw:items-center tw:justify-between tw:gap-s-2"><strong class="scenario-name">{{ s.name }}</strong><ArchiveIcon v-if="activeScenario?.id === s.id" name="success" /></span><span class="scenario-desc">{{ s.desc }}</span><span class="scenario-count">{{ s.acts.length }} 幕故事<span>{{ s.en }}</span></span></span>
              <CardEdgeLight />
            </button>
            <button v-if="failed" type="button" class="btn btn-ghost btn-sm scenario-cover-retry" :aria-label="'重新读取' + (currentChar === 'nene' ? '宁宁' : '夏目') + '的《' + s.name + '》封面'" @click="retryCover(coverId(s.id), $event)"><ArchiveIcon name="refresh" />重新读取封面</button>
          </article>
        </RuntimeImage>
      </div>
      <section v-if="activeScenario" ref="reader" class="viewer" aria-label="分幕手帖" tabindex="-1">
        <header class="viewer-header-row"><div><span class="scenario-kicker">分幕手帖 / {{ activeScenario.acts.length }} 幕</span><h2 class="viewer-h2"><ArchiveIcon :name="activeScenario.iconName" />{{ activeScenario.name }}</h2><p class="viewer-desc">{{ activeScenario.desc }}</p></div><button class="btn btn-primary scenario-to-video" type="button" @click="sendToVideoStudio"><ArchiveIcon name="clap" />制作分镜短片</button></header>
        <div class="acts" :data-act-count="activeScenario.acts.length" data-route-arrive v-content-motion:up="`${activeScenario.id}:${currentChar}`">
          <article v-for="a in activeScenario.acts" :key="activeScenario.id + a.n" class="act" :data-act="a.n">
            <div class="act-heading tw:flex tw:items-center tw:gap-s-3"><span class="act-num">{{ a.n }}</span><div><h3 class="act-title">{{ a.title }}</h3><span class="act-en">{{ a.en }}</span></div></div>
            <div class="act-intent"><span class="act-framing" :style="{ '--act-ratio': resInfo(a.res).dim.replace('×', ' / ') }" aria-hidden="true"><ArchiveIcon :name="frameIcon(a.res)" /></span><div><span class="act-emotion">{{ a.emotion }}</span><p class="act-desc">{{ a.desc }}</p></div></div>
            <div class="act-format"><span>{{ currentChar === 'nene' ? '宁宁' : '夏目' }} · {{ a.res }}</span><span>{{ resInfo(a.res).dim }}</span></div>
            <div class="act-actions"><StudioCopyButton class="btn btn-ghost" label="复制本幕 Prompt" :content-key="`${activeScenario.id}:${a.n}:${currentChar}`" :action="() => copyPrompt(a)" /></div>
            <details class="act-details" :open="expandedActs.includes(a.n)" :data-scenario="activeScenario.id" :data-act="a.n" @toggle="syncAct">
              <StudioDisclosureSummary><span>提示词与参数</span></StudioDisclosureSummary>
              <div class="act-details-body" data-disclosure-content>
                <p class="act-settings">LoRA {{ a.lora }} · {{ LOCK_PARAMS }}</p>
                <p class="res-rec">{{ resInfo(a.res).reason }} · {{ resInfo(a.res).vram }}</p>
                <div v-if="violations(a).length" class="art-warn show"><ArchiveIcon name="warning" />本幕有 {{ violations(a).length }} 个违反美术规范的标签: {{ violations(a).join(', ') }}</div>
                <div class="prompt-label">Positive (10 模块)</div><div class="prompt-code" v-html="renderModules(a)"></div>
                <div class="neg-section"><div class="prompt-label prompt-label-neg">Negative</div><div class="neg-layer"><div class="neg-layer-label">基础层（始终生效）</div><div class="neg-output">{{ BASE_NEG }}</div></div><div class="neg-layer"><div class="neg-layer-label">场景特定层</div><div class="neg-output">{{ a.neg }}</div></div></div>
              </div>
            </details>
          </article>
        </div>
        <footer class="scenario-handoff"><RouterLink :to="{ path: '/prompt-builder', query: { scenario: activeScenario.id, char: currentChar } }" class="btn btn-ghost"><ArchiveIcon name="scene" />前往工作台绘制</RouterLink></footer>
      </section>
    </div>
  </article>
</template>

<script setup lang="ts">
import RuntimeImage from '@/components/visual/RuntimeImage.vue'

import { copyWithFeedback } from '@/composables/useCopyFeedback'
import CreativeLibraryHeader from '@/components/library/CreativeLibraryHeader.vue'
import { nextTick, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useVideoStore, type StagedScenarioAct } from '@/stores/videoStore'
import { useToast } from '@/composables/useToast'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import CardEdgeLight from '@/components/visual/CardEdgeLight.vue'
import StudioCopyButton from '@/components/ui/StudioCopyButton.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import { useMoodReferences } from '@/composables/useMoodReferences'
import { scrollBehavior } from '@/utils/motionPreference'
import { BANNED_TAGS } from '@/utils/promptPolicy'
import {
  SCENARIOS,
  SCENARIO_RES_MAP,
  SCENARIO_CHARACTERS,
  substituteScenarioPrompt,
  type Scenario,
  type ScenarioAct,
  type ScenarioCharacter,
  type ScenarioResolution,
} from '@/config/scenarios'


const videoStore = useVideoStore()
const router = useRouter()
const route = useRoute()

// 引擎参数由导演台按所选引擎自动锁定（Anima: res_multistep · CFG 4.5 · 30 步；放大二阶段 res_multistep · sgm_uniform）。
// 2026-08-23 剧本模式激活：清掉 SD 时代的硬编码采样参数与内联 <lora:> 展示
//（出图深链本就不携带 LoRA——LoRA 由网关受控路线管理，v18 内联标签是误导）。
const LOCK_PARAMS = '底模参数由工作台按引擎自动锁定'
const BASE_NEG = 'lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry, artist name'
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
const expandedActs = ref(initialSelection.acts)
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
const { loading: loadingReferences, error: referenceError, reload: reloadReferences, referenceUrl, retryReference } = useMoodReferences()
const referenceRetryStarted = ref(false)
function retryCover(id: string, event: MouseEvent) {
  const origin = event.currentTarget
  if (origin instanceof HTMLElement && document.activeElement === origin)
    origin.closest('.scenario-book')?.querySelector<HTMLElement>('.scenario-card')?.focus({ preventScroll: true })
  retryReference(id)
}
function retryReferences() {
  if (loadingReferences.value) return
  // Keep the recovery control mounted and focusable through the request and its result.
  referenceRetryStarted.value = true
  void reloadReferences().catch(() => {})
}
function coverId(id: string) { return COVER_IDS[id]?.[currentChar.value] || '' }
function frameIcon(res: ScenarioResolution) { return res === 'Close-up' ? 'closeup' : res === 'Wide CG' || res === 'Full CG' ? 'wideshot' : 'midshot' }


function esc(s: string) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }
function norm(t: string) { return t.split(/[,\r\n\u2028\u2029]+/).map(s => s.trim().replace(/[\s-]+/g,'_')).filter(Boolean).join(', ') }
function resInfo(res: ScenarioResolution) { return RES_MAP[res] }
function violations(a: ScenarioAct) {
  const lower = a.prompt.toLowerCase()
  return BANNED_TAGS.filter(b => lower.includes(b.toLowerCase()))
}
function substitutePrompt(tpl: string, char: ScenarioCharacter) {
  return substituteScenarioPrompt(tpl, char)
}
function buildFullPrompt(a: ScenarioAct, char: ScenarioCharacter) {
  return norm(substitutePrompt(a.prompt, char))
}

const MODULE_CLASSES = ['m-q','m-c','m-cl','m-s','m-e','m-sh','m-co','m-l','m-d','m-lora']
function renderModules(a: ScenarioAct) {
  const char = currentChar.value
  const modPrompt = substitutePrompt(a.prompt, char)
  const modules = modPrompt.split('\n')
  modules.push('LoRA 与采样参数由工作台引擎自动管理')
  return modules.map((line, i) => {
    const cls = MODULE_CLASSES[i] || 'm-q'
    const parts = line.split(',').map(tk => {
      const t = tk.trim(); if (!t) return ''
      const low = t.toLowerCase()
      const bad = BANNED_TAGS.some(b => low === b.toLowerCase() || low.includes(b.toLowerCase()))
      return bad ? `<span class="violate">${esc(t)}</span>` : esc(t)
    }).join(', ')
    return `<span class="mod ${cls}">${parts}</span>`
  }).join('\n')
}

function copyPrompt(a: ScenarioAct) {
  const text = buildFullPrompt(a, currentChar.value)
  return copyWithFeedback(text, '已复制本幕提示词')
}

async function openScenario(s: Scenario) {
  const request = ++readerRequest
  activeScenario.value = s
  await nextTick()
  const target = reader.value
  if (request !== readerRequest || !target?.isConnected || target.closest('[inert]')) return
  target.focus({ preventScroll: true })
  target.scrollIntoView({ block: 'start', behavior: scrollBehavior() })
}

// ── 剧本模式激活（2026-08-23）：整本分幕 → 视频工坊分镜镜头 ────────────────
// 每幕一镜：描述+情绪氛围喂 H3 三段式组装；景别按分幕构图映射；首帧到达分镜后
// 走「一键首帧」/手动上传，角色身份建议挂 Ref2VA 参考卡（工作室角色不自动装配）。
function scenarioShotSize(res: ScenarioResolution): StagedScenarioAct['shotSize'] {
  if (res === 'Close-up') return 'closeup'
  if (res === 'Half-body' || res === 'Portrait') return 'medium'
  return 'wide'
}

function sendToVideoStudio() {
  const scenario = activeScenario.value
  if (!scenario) return
  const acts: StagedScenarioAct[] = scenario.acts.map(act => ({
    prompt: `${act.desc}。${act.emotion}的氛围。`,
    dialogue: '',
    shotSize: scenarioShotSize(act.res),
    camera: 'still',
    motion: 'natural',
    duration: 3,
    characterId: currentChar.value,
  }))
  if (!videoStore.stageScenarioActs(acts)) {
    showToast('跨页上下文写入失败')
    return
  }
  void router.push('/video-studio?mode=shots')
}

// 走全局 AppToast。原先手搓 DOM + 内联 cssText，硬编码了 z-index:9999
// （会盖住 --z-skip 的跳转链接）、border-radius、font-size 与 rgba 阴影。
const { show: showToast } = useToast()

</script>

<style scoped src="@/assets/css/scenario-artbook.css"></style>
<style scoped>
.scenario-reference-retry[aria-disabled='true'] { color:var(--text-disabled); cursor:wait; pointer-events:auto; }
.scenario-reference-retry:focus-visible { outline:2px solid var(--focus-color); outline-offset:2px; }
</style>

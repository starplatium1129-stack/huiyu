<template>
  <article class="page scenario-page" style="--page-max:1450px">
    <ArchivePageHero chapter="08" section="Narrative sequence" shape="book" label="故事手帖" caption="SCENARIO 08 / 08" compact>
      <div class="page-kicker">Story notebook</div>
      <h1 class="title">剧本模式</h1>
      <p class="subtitle">从一幕心动，翻到故事的结尾。</p>
    </ArchivePageHero>
    <CreativeLibraryNav />
    <header class="scenario-library-heading">
      <div><h2>选一本故事手帖</h2><p>{{ SCENARIOS.length }} 本故事 · 封面为氛围参考</p></div>
      <div class="char-toggle" role="group" aria-label="剧本角色">
        <button v-for="c in CHARACTER_OPTIONS" :key="c" class="char-btn" :class="{ active: currentChar === c }" :aria-pressed="currentChar === c" type="button" @click="currentChar = c"><ArchiveIcon :name="c" />{{ c === 'nene' ? '宁宁' : '夏目' }}</button>
      </div>
    </header>
    <div class="scenario-workspace">
      <div class="scenario-list" role="group" aria-label="故事手帖">
        <button v-for="s in SCENARIOS" :key="s.id" type="button" class="scenario-card" :class="{ active: activeScenario?.id === s.id }" :aria-pressed="activeScenario?.id === s.id" @click="openScenario(s)">
          <span class="scenario-cover" :class="{ 'is-unconnected': !loadingReferences && !available.has(coverId(s.id)) }" :data-character="currentChar">
            <img v-if="available.has(coverId(s.id)) && !failedCovers.has(coverId(s.id))" :key="coverId(s.id)" :src="'/scene-showcase/thumbs/' + coverId(s.id) + '.jpg'" :alt="(currentChar === 'nene' ? '宁宁' : '夏目') + ' · ' + s.name + '氛围参考'" width="560" height="818" loading="lazy" decoding="async" @error="failedCovers.add(coverId(s.id))" />
            <span v-else class="scenario-cover-missing"><ArchiveIcon :name="s.iconName" /><span>{{ loadingReferences ? '正在翻开画册…' : failedCovers.has(coverId(s.id)) ? '封面加载失败' : '氛围参考暂未连接' }}</span></span>
          </span>
          <span class="scenario-book-copy"><span class="scenario-book-title"><strong class="scenario-name">{{ s.name }}</strong><ArchiveIcon v-if="activeScenario?.id === s.id" name="success" /></span><span class="scenario-desc">{{ s.desc }}</span><span class="scenario-count">{{ s.acts.length }} 幕故事<span>{{ s.en }}</span></span></span>
        </button>
      </div>
      <section v-if="activeScenario" class="viewer show" aria-label="分幕手帖">
        <header class="viewer-header-row"><div><span class="scenario-kicker">分幕手帖 / {{ activeScenario.acts.length }} 幕</span><h2 class="viewer-h2"><ArchiveIcon :name="activeScenario.iconName" />{{ activeScenario.name }}</h2><p class="viewer-desc">{{ activeScenario.desc }}</p></div><button class="btn btn-primary scenario-to-video" type="button" @click="sendToVideoStudio"><ArchiveIcon name="clap" />送入分镜短片（{{ activeScenario.acts.length }} 幕 → {{ activeScenario.acts.length }} 镜）</button></header>
        <div class="acts" :style="{ '--act-count': activeScenario.acts.length }">
          <article v-for="a in activeScenario.acts" :key="activeScenario.id + a.n" class="act" :data-act="a.n">
            <div class="act-heading"><span class="act-num">{{ a.n }}</span><div><h3 class="act-title">{{ a.title }}</h3><span class="act-en">{{ a.en }}</span></div></div>
            <div class="act-intent"><span class="act-framing" :style="{ '--act-ratio': resInfo(a.res).dim.replace('×', ' / ') }" aria-hidden="true"><ArchiveIcon :name="frameIcon(a.res)" /></span><div><span class="act-emotion">{{ a.emotion }}</span><p class="act-desc">{{ a.desc }}</p></div></div>
            <div class="act-format"><span>{{ currentChar === 'nene' ? '宁宁' : '夏目' }} · {{ a.res }}</span><span>{{ resInfo(a.res).dim }}</span></div>
            <details class="act-details">
              <summary>提示词与参数</summary>
              <div class="act-details-body">
                <p class="act-settings">LoRA {{ a.lora }} · {{ LOCK_PARAMS }}</p>
                <p class="res-rec">{{ resInfo(a.res).reason }} · {{ resInfo(a.res).vram }}</p>
                <div v-if="violations(a).length" class="art-warn show"><ArchiveIcon name="warning" />本幕有 {{ violations(a).length }} 个违反美术规范的标签: {{ violations(a).join(', ') }}</div>
                <div class="prompt-label">Positive (10 模块)</div><div class="prompt-code" v-html="renderModules(a)"></div>
                <div class="neg-section"><div class="prompt-label prompt-label-neg">Negative</div><div class="neg-layer"><div class="neg-layer-label">基础层（始终生效）</div><div class="neg-output">{{ BASE_NEG }}</div></div><div class="neg-layer"><div class="neg-layer-label">场景特定层</div><div class="neg-output">{{ a.neg }}</div></div></div>
              </div>
            </details>
            <div class="act-actions"><button class="btn btn-ghost" type="button" @click="copyPrompt(a)"><ArchiveIcon name="copy" />复制本幕 Prompt</button></div>
          </article>
        </div>
        <footer class="scenario-handoff"><p>把这些片刻连成故事，或从第一幕开始绘制。</p><RouterLink :to="{ path: '/prompt-builder', query: { scenario: activeScenario.id, char: currentChar } }" class="btn btn-ghost"><ArchiveIcon name="scene" />前往工作台绘制</RouterLink></footer>
      </section>
    </div>
  </article>
</template>

<script setup lang="ts">
import { copyWithFeedback } from '@/composables/useCopyFeedback'
import CreativeLibraryNav from '@/components/library/CreativeLibraryNav.vue'
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useVideoStore, type StagedScenarioAct } from '@/stores/videoStore'
import { useToast } from '@/composables/useToast'
import ArchivePageHero from '@/components/visual/ArchivePageHero.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { useScrollReveal } from '@/composables/useScrollReveal'
import { useMoodReferences } from '@/composables/useMoodReferences'
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
useScrollReveal()

// 引擎参数由导演台按所选引擎自动锁定（Anima: res_multistep · CFG 4.5 · 30 步；放大二阶段 res_multistep · sgm_uniform）。
// 2026-08-23 剧本模式激活：清掉 SD 时代的硬编码采样参数与内联 <lora:> 展示
//（出图深链本就不携带 LoRA——LoRA 由网关受控路线管理，v18 内联标签是误导）。
const LOCK_PARAMS = '底模参数由工作台按引擎自动锁定'
const BASE_NEG = 'lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry, artist name'
const RES_MAP = SCENARIO_RES_MAP
const CHARACTER_OPTIONS = [...SCENARIO_CHARACTERS] as const

const activeScenario = ref<Scenario | null>(SCENARIOS[0] || null)
const currentChar = ref<ScenarioCharacter>('nene')
// Covers are atmosphere references, never generated frames for an act.
const COVER_IDS: Record<string, Record<ScenarioCharacter, string>> = {
  promise: { nene: 'sc001', natsume: 'sc011' },
  rainy: { nene: 'sc007', natsume: 'sc069' },
  sakura: { nene: 'sc002', natsume: 'sc013' },
}
const { available, loading: loadingReferences } = useMoodReferences(Object.values(COVER_IDS).flatMap(pair => Object.values(pair)))
const failedCovers = ref(new Set<string>())
function coverId(id: string) { return COVER_IDS[id]?.[currentChar.value] || '' }
function frameIcon(res: ScenarioResolution) { return res === 'Close-up' ? 'closeup' : res === 'Wide CG' || res === 'Full CG' ? 'wideshot' : 'midshot' }


function esc(s: string) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }
function norm(t: string) { return t.split(',').map(s => s.trim().replace(/[\s-]+/g,'_')).join(', ') }
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
  void copyWithFeedback(text, '已复制本幕提示词')
}

function openScenario(s: Scenario) { activeScenario.value = s }

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

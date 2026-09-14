<template>
  <article class="page scenario-page" style="--page-max:1450px">
    <ArchivePageHero
      chapter="08"
      section="Narrative sequence"
      shape="book"
      label="多幕剧本的书页粒子标记"
      caption="SCENARIO 08 / 08"
      compact
    >
      <div class="page-kicker">Scenario mode</div>
      <h1 class="title">剧本模式</h1>
      <p class="subtitle">将一段动人的相遇拆解为多幕 CG 叙事；每一幕均凝炼完整的场景结构、色彩基调与意象表达。</p>
    </ArchivePageHero>
    <CreativeLibraryNav />

    <div class="info-callout" data-reveal>
      <strong>◎ 叙事美学</strong> | 每一幕皆为独立而连贯的动态叙事画面。切换右上角角色后，全分幕的镜头与构图意象将在宁宁与夏目之间灵动流转。
      当前灵感场景共有 <strong>{{ sceneCount }}</strong> 个。
    </div>

    <div class="scenario-workspace">
    <!-- 剧本列表 -->
    <div class="scenario-list" data-reveal data-reveal-delay="1">
      <!-- 必须是 button:这是进入剧本查看器的唯一入口,
           原先是 <div @click>,没有 role/tabindex/keydown → 键盘完全进不去 -->
      <button
        v-for="s in SCENARIOS" :key="s.id"
        type="button"
        class="scenario-card" :class="{ active: activeScenario?.id === s.id }" :aria-pressed="activeScenario?.id === s.id"
        @click="openScenario(s)"
      >
        <span class="scenario-icon" aria-hidden="true"><ArchiveIcon :name="s.iconName" /></span>
        <span class="scenario-name">{{ s.name }}</span>
        <span class="scenario-en">{{ s.en }}</span>
        <span class="scenario-desc">{{ s.desc }}</span>
        <span class="scenario-count">{{ s.acts.length }} 幕 · 点击查看</span>
      </button>
    </div>

    <!-- 分幕查看器 -->
    <div v-if="activeScenario" class="viewer show">
      <div class="viewer-header-row">
        <div>
          <h2 class="viewer-h2"><ArchiveIcon :name="activeScenario.iconName" /> {{ activeScenario.name }}</h2>
          <div class="viewer-en">{{ activeScenario.en }}</div>
        </div>
        <div class="char-toggle">
          <button
            v-for="c in CHARACTER_OPTIONS" :key="c"
            class="char-btn" :class="{ active: currentChar === c }"
            type="button" @click="currentChar = c"
          >{{ c === 'nene' ? '◉ 宁宁' : '◎ 夏目' }}</button>
        </div>
      </div>
      <p class="viewer-desc">{{ activeScenario.desc }}</p>

      <div class="act-actions scenario-to-video">
        <button
          class="btn btn-primary"
          type="button"
          title="整本分幕一键送入视频工坊分镜模式：每幕变一个镜头（描述+情绪氛围），到达后可「一键首帧」补首帧、挂角色参考卡后批量出片"
          @click="sendToVideoStudio"
        >送入分镜短片（{{ activeScenario.acts.length }} 幕 → {{ activeScenario.acts.length }} 镜）</button>
      </div>

      <div class="acts">
        <div v-for="a in activeScenario.acts" :key="a.n" class="act">
          <div class="act-head">
            <span class="act-num">{{ a.n }}</span>
            <h3 class="act-title">{{ a.title }}</h3>
          </div>
          <div class="act-en">{{ a.en }}</div>
          <div class="act-desc">{{ a.desc }}</div>

          <div class="scene-grid">
            <div class="scene-meta"><div class="label">情绪</div><div class="value">{{ a.emotion }}</div></div>
            <div class="scene-meta"><div class="label">角色</div><div class="value">{{ currentChar }}</div></div>
            <div class="scene-meta"><div class="label">Resolution</div><div class="value" :title="resInfo(a.res).dim">{{ a.res }}</div></div>
            <div class="scene-meta"><div class="label">LoRA</div><div class="value">{{ a.lora }}</div></div>
            <div class="scene-meta"><div class="label">锁定参数 <span class="lock-badge">▣</span></div><div class="value value-dense">{{ LOCK_PARAMS }}</div></div>
          </div>

          <div class="res-rec">
            <span class="res-icon">◳</span>
            <strong>推荐 {{ a.res }} ({{ resInfo(a.res).dim }} · {{ resInfo(a.res).vram }})</strong>
            → {{ resInfo(a.res).reason }}
          </div>

          <div v-if="violations(a).length" class="art-warn show">
            <ArchiveIcon name="warning" /> 本幕有 {{ violations(a).length }} 个违反美术规范的标签: {{ violations(a).join(', ') }}
          </div>

          <div class="prompt-label">Positive (10 模块)</div>
          <div class="prompt-code" v-html="renderModules(a)"></div>

          <div class="neg-section">
            <div class="prompt-label prompt-label-neg">Negative</div>
            <div class="neg-layer"><div class="neg-layer-label">基础层（永远带）</div><div class="neg-output">{{ BASE_NEG }}</div></div>
            <div class="neg-layer"><div class="neg-layer-label">场景特定层</div><div class="neg-output">{{ a.neg }}</div></div>
          </div>

          <div class="act-actions">
            <button class="btn btn-primary" type="button" @click="copyPrompt(a)">⧉ 复制本幕 Prompt</button>
            <RouterLink :to="'/prompt-builder?scenario=' + activeScenario.id" class="btn btn-ghost">→ 去开始绘制</RouterLink>
          </div>
        </div>
      </div>
    </div>
    </div>
  </article>
</template>

<script setup lang="ts">
import { copyWithFeedback } from '@/composables/useCopyFeedback'
import CreativeLibraryNav from '@/components/library/CreativeLibraryNav.vue'
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useSceneStore } from '@/stores/sceneStore'
import { useVideoStore, type StagedScenarioAct } from '@/stores/videoStore'
import { useToast } from '@/composables/useToast'
import ArchivePageHero from '@/components/visual/ArchivePageHero.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { useScrollReveal } from '@/composables/useScrollReveal'
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

const sceneStore = useSceneStore()
const videoStore = useVideoStore()
const router = useRouter()
useScrollReveal()

// 引擎参数由导演台按所选引擎自动锁定（Anima: res_multistep · CFG 4.5 · 30 步；放大二阶段 res_multistep · sgm_uniform）。
// 2026-08-23 剧本模式激活：清掉 SD 时代的硬编码采样参数与内联 <lora:> 展示
//（出图深链本就不携带 LoRA——LoRA 由网关受控路线管理，v18 内联标签是误导）。
const LOCK_PARAMS = '底模参数由导演台按引擎自动锁定'
const BASE_NEG = 'lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry, artist name'
const RES_MAP = SCENARIO_RES_MAP
const CHARACTER_OPTIONS = [...SCENARIO_CHARACTERS] as const

const activeScenario = ref<Scenario | null>(SCENARIOS[0] || null)
const currentChar = ref<ScenarioCharacter>('nene')
const sceneCount = ref('--')

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
  modules.push('LoRA 与采样参数由导演台引擎自动管理')
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

onMounted(async () => {
  try {
    await sceneStore.load()
    sceneCount.value = String(sceneStore.count || '--')
  } catch (e) { console.warn('scene count load failed', e) }
})
</script>

<style scoped>
.scenario-workspace { display: grid; grid-template-columns: 250px minmax(0, 1fr); gap: var(--s-6); align-items: start; }
.scenario-page .scenario-list { position: sticky; top: 82px; display: grid; grid-template-columns: 1fr; gap: var(--s-3); }
.scenario-page .scenario-card { min-height: 0; padding: var(--s-4); border: 1px solid var(--border-soft); border-radius: var(--r-lg); background: var(--bg-surface); color: var(--text-primary); text-align: left; }
.scenario-page .scenario-card.active { border-color: var(--accent); background: var(--accent-soft); }
.scenario-page .scenario-en { display: none; }
.scenario-page .viewer-header-row { position: sticky; top: 72px; z-index: var(--z-sticky); background: var(--bg-surface); padding: var(--s-4); border: 1px solid var(--border-soft); border-radius: var(--r-lg); }
@media(max-width:900px) { .scenario-workspace { grid-template-columns: 1fr; } .scenario-page .scenario-list { position: static; grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media(max-width:600px) { .scenario-page .scenario-list { grid-template-columns: 1fr; } .scenario-page .viewer-header-row { position: static; } }

.info-callout { margin-bottom:var(--s-5); padding:var(--s-3) var(--s-4); border:1px solid var(--accent); border-radius:var(--r-md); background:var(--accent-soft); font-size:var(--fs-body-sm); }
.info-callout strong { color:var(--accent); }
.scenario-list { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:var(--s-4); }
/* 卡片现在是 <button>：重置浏览器默认样式，并保持原本的块级排版 */
.scenario-card { padding:var(--s-5); cursor:pointer; display:block; width:100%; text-align:left; font:inherit; color:inherit; }
.scenario-icon { display:block; font-size:var(--fs-glyph); margin-bottom:var(--s-2); }
.scenario-name { display:block; font-size:var(--fs-title-xs); font-weight:800; margin-bottom:2px; }
.scenario-en { display:block; color:var(--text-muted); font-size:var(--fs-mono-sm); margin-bottom:var(--s-2); }
.scenario-desc { display:block; color:var(--text-secondary); font-size:var(--fs-body-sm); line-height:var(--lh-loose); margin-bottom:var(--s-2); }
.scenario-count { display:block; color:var(--accent); font-size:var(--fs-label-sm); font-weight:700; }

.viewer { margin-top:var(--s-4); }
.viewer-header-row { display:flex; align-items:flex-start; justify-content:space-between; gap:var(--s-4); margin-bottom:var(--s-3); }
.viewer-h2 { font-size:var(--fs-title-sm); font-weight:800; }
.viewer-en { color:var(--text-muted); font-size:var(--fs-label-sm); }
.viewer-desc { color:var(--text-secondary); font-size:var(--fs-body-sm); margin-bottom:var(--s-5); }
.char-toggle { display:flex; gap:var(--s-2); flex-shrink:0; }
.char-btn { padding:var(--s-2) var(--s-4); border:1px solid var(--border-soft); border-radius:var(--r-pill); background:var(--bg-surface); color:var(--text-secondary); cursor:pointer; font:600 var(--fs-body-sm) var(--font-sans); transition:border-color var(--motion-hover),color var(--motion-hover),background var(--motion-hover),transform var(--motion-hover) var(--ease-out); }
.char-btn.active { background:var(--accent); color:var(--text-inverse); border-color:var(--accent); }

.acts { display:grid; gap:var(--s-5); margin-bottom:var(--s-5); }
.act { padding:var(--s-5); border:1px solid var(--border-soft); border-radius:var(--r-xl); background:var(--bg-surface); }
.act-head { display:flex; align-items:center; gap:var(--s-3); margin-bottom:4px; }
.act-num { padding:2px var(--s-2); border:1px solid var(--accent); border-radius:var(--r-pill); color:var(--accent); font:700 var(--fs-mono-sm) var(--font-mono); }
.act-title { font-size:var(--fs-title-xs); font-weight:800; }
.act-en { color:var(--text-muted); font-size:var(--fs-mono-sm); margin-bottom:var(--s-2); }
.act-desc { color:var(--text-secondary); font-size:var(--fs-body-sm); font-style:italic; margin-bottom:var(--s-3); }
.scene-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(110px,1fr)); gap:var(--s-2); margin-bottom:var(--s-3); }
.scene-meta { padding:var(--s-2) var(--s-3); border-radius:var(--r-md); background:var(--bg-elevated); text-align:center; }
.scene-meta .label { color:var(--text-muted); font-size:var(--fs-mono-sm); letter-spacing:.05em; text-transform:uppercase; }
.scene-meta .value { margin-top:2px; color:var(--accent); font-size:var(--fs-body-sm); font-weight:600; }
.scene-meta .value-dense { font-size:var(--fs-label-xs); }
.lock-badge { display:inline-flex; align-items:center; gap:var(--s-1); padding:2px var(--s-2); border-radius:var(--r-pill); background:color-mix(in srgb,var(--success) 10%,transparent); color:var(--success-text); font-size:var(--fs-mono-sm); font-weight:600; }
.res-rec { display:flex; align-items:flex-start; gap:var(--s-2); flex-wrap:wrap; margin-bottom:var(--s-3); padding:var(--s-2) var(--s-3); border:1px solid var(--accent); border-radius:var(--r-md); background:var(--accent-soft); color:var(--text-primary); font-size:var(--fs-body-sm); }
.res-rec strong { color:var(--accent); }
.art-warn { display:none; align-items:center; gap:var(--s-2); margin-bottom:var(--s-3); padding:var(--s-2) var(--s-3); border:1px solid var(--warning); border-radius:var(--r-md); background:color-mix(in srgb,var(--warning) 12%,transparent); color:var(--warning-text); font-size:var(--fs-label); }
.art-warn.show { display:flex; }
.prompt-label { margin-bottom:var(--s-1); color:var(--accent); font-size:var(--fs-label-sm); font-weight:600; letter-spacing:.06em; text-transform:uppercase; }
.prompt-label-neg { color:var(--danger-text); }
.prompt-code { padding:var(--s-3); background:var(--bg-elevated); border-radius:var(--r-md); font:400 var(--fs-mono-sm)/1.8 var(--font-mono); white-space:pre-wrap; word-break:break-word; margin-bottom:var(--s-3); }
:deep(.mod) { display:block; border-left:3px solid var(--border-soft); padding-left:var(--s-2); margin-bottom:2px; }
:deep(.m-q) { border-color:var(--text-muted); } :deep(.m-c) { border-color:var(--accent); } :deep(.m-cl) { border-color:var(--nene-violet); }
:deep(.m-s) { border-color:var(--mood-calm); } :deep(.m-e) { border-color:var(--mood-love); } :deep(.m-sh) { border-color:var(--natsume-amber); }
:deep(.m-co) { border-color:var(--info); } :deep(.m-l) { border-color:var(--mood-joy); } :deep(.m-d) { border-color:var(--text-secondary); } :deep(.m-lora) { border-color:var(--success); }
:deep(.violate) { color:var(--danger-text); text-decoration:underline wavy; }
.neg-section { margin-top:var(--s-3); padding-top:var(--s-3); border-top:1px solid var(--border-soft); }
.neg-layer { margin-bottom:var(--s-2); }
.neg-layer-label { margin-bottom:2px; color:var(--text-muted); font-size:var(--fs-label-xs); font-weight:600; }
.neg-output { padding:var(--s-3); border:1px solid color-mix(in srgb,var(--danger) 20%,transparent); border-radius:var(--r-md); background:color-mix(in srgb,var(--danger) 4%,transparent); color:var(--danger-text); font:400 var(--fs-label-sm)/1.8 var(--font-mono); white-space:pre-wrap; word-break:break-word; }
.act-actions { display:flex; gap:var(--s-2); flex-wrap:wrap; margin-top:var(--s-3); }
@media(max-width:768px) { .viewer-header-row { flex-direction:column; align-items:flex-start; } }
</style>

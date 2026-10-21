<template>
  <article class="page lora-page creative-library-page">
    <CreativeLibraryHeader title="模型资料 (LoRA)" description="为熟悉的角色，找到合适的画笔。" />
    <div ref="catalogRoot" class="model-catalog" role="region" aria-label="模型目录" :aria-busy="loading" tabindex="-1">
    <ArchiveStatePanel
      v-if="loading"
      kind="loading"
      title="正在读取模型目录"
    />
    <ArchiveStatePanel
      v-else-if="loadError && !loras.length"
      kind="error"
      title="模型目录读取失败"
      message="本地模型档案暂时无法读取，请稍后重试。"
    >
      <button class="btn btn-primary" type="button" @click="retryCatalog">重新读取</button>
    </ArchiveStatePanel>
    <ArchiveStatePanel
      v-else-if="!loras.length"
      kind="empty"
      title="模型目录暂未收录"
    >
    </ArchiveStatePanel>
    <template v-else>
    <div v-if="loadError" class="model-catalog-note">
      <span role="status">目录更新失败，仍展示上次读取的资料。</span>
      <button class="btn btn-ghost btn-sm" type="button" @click="retryCatalog">重新读取</button>
    </div>
    <div class="model-search-row">
      <StudioSearch ref="searchInput" v-model="modelQuery" class="model-search-field" label="搜索模型" placeholder="按模型、角色或触发词查找…" />
      <span class="model-result-count" role="status">{{ visibleLoras.length }} / {{ loras.length }} 份资料</span>
    </div>
    <div v-if="engineOptions.length > 1" class="model-engine-filters studio-segments" role="group" aria-label="按绘图引擎筛选模型">
      <AnimatedSelection />
      <button v-for="option in engineOptions" :key="option.value" type="button" :aria-pressed="engine === option.value" @click="engine = option.value">{{ option.label }}<span>{{ option.count }}</span></button>
    </div>
    <ArchiveStatePanel v-if="!visibleLoras.length" compact kind="filtered" title="没有匹配的模型">
      <button class="btn btn-ghost btn-sm" type="button" @click="resetFilters">重置筛选</button>
    </ArchiveStatePanel>
    <div ref="listRoot" v-content-motion:up="true" class="lora-grid" data-route-arrive>
      <article v-for="l in visibleLoras" :key="l.id" class="lora-card" :data-list-key="l.id" :data-character="modelGuide(l).icon">
        <header class="model-identity">
          <figure v-if="modelAvatar(l.id)" class="model-portrait">
            <span class="model-portrait-art">
              <img v-if="!failedAvatars.has(l.id)" :src="modelAvatar(l.id)" :alt="`${modelGuide(l).name}的角色示意`" width="104" height="104" decoding="async" @error="failedAvatars.add(l.id)" />
              <ArchiveIcon v-else :name="modelGuide(l).icon" />
            </span>
            <figcaption>角色示意</figcaption>
          </figure>
          <ArchiveIcon v-else :name="modelGuide(l).icon" />
          <div class="model-identity-copy">
            <h2 class="lora-name">{{ modelGuide(l).name }}</h2>
            <p class="model-purpose">{{ modelGuide(l).purpose }}</p>
            <div class="model-edition"><span class="model-engine">{{ modelGuide(l).engine }}</span><span v-if="l.version">v{{ l.version }}</span><span v-if="l.experimental" class="badge badge-warning">实验预览</span></div>
          </div>
        </header>
        <div class="model-actions">
          <RouterLink v-if="modelCharacter(l.id)" class="btn btn-primary" :to="{ path: '/prompt-builder', query: { char: modelCharacter(l.id) } }"><ArchiveIcon name="spark" />用此角色绘制</RouterLink>
          <StudioCopyButton v-if="l.triggerWords.length" class="btn btn-ghost" label="复制触发词" :content-key="l.triggerWords.join(', ')" :action="() => copyText(l.triggerWords.join(', '))" />
        </div>
        <p v-if="!modelCharacter(l.id)" class="model-availability">旧版模型资料</p>
        <details class="model-details">
          <StudioDisclosureSummary>触发词与模型资料</StudioDisclosureSummary>
          <div class="model-details-body" data-disclosure-content>
            <p v-if="l.description" class="lora-desc">{{ l.description }}</p>
            <dl class="model-facts">
              <div><dt>模型文件</dt><dd><code class="model-file">{{ l.name }}</code></dd></div>
              <div v-if="l.baseModel"><dt>适用底模</dt><dd>{{ l.baseModel }}</dd></div>
              <div v-if="l.recommendedWeight"><dt>推荐权重</dt><dd>{{ formatLoraWeight(l.recommendedWeight) }}</dd></div>
              <div v-if="l.character"><dt>角色标识</dt><dd>{{ l.character }}</dd></div>
            </dl>
            <div v-if="l.triggerWords.length" class="lora-triggers">
              <span class="lora-label">触发词</span>
              <span v-for="word in l.triggerWords" :key="word" class="lora-tag">{{ word }}</span>
            </div>
          </div>
        </details>
        <section v-if="l.evaluation" class="evaluation-panel" aria-label="模型评测结果">
          <details>
            <StudioDisclosureSummary>历史评测</StudioDisclosureSummary>
            <div data-disclosure-content>
            <p class="evaluation-summary">{{ l.evaluation.status === 'passed' ? '已通过' : l.evaluation.status || '已记录' }}<span v-if="l.evaluation.evaluatedAt"> · {{ l.evaluation.evaluatedAt }}</span></p>
            <div class="evaluation-metrics">
              <div v-for="metric in l.evaluation.metrics" :key="metric[0]">
                <span>{{ metric[0] }}</span>
                <strong>{{ metric[1] }}</strong>
              </div>
            </div>
            <p v-if="l.evaluation.knownLimitation" class="evaluation-limit"><strong>已知限制：</strong>{{ l.evaluation.knownLimitation }}</p>
            <dl>
              <div v-if="l.evaluation.matrix"><dt>对照矩阵</dt><dd>{{ l.evaluation.matrix }}</dd></div>
              <div v-if="l.evaluation.method"><dt>方法</dt><dd>{{ l.evaluation.method }}</dd></div>
              <div v-if="l.evaluation.selectionReason"><dt>晋升理由</dt><dd>{{ l.evaluation.selectionReason }}</dd></div>
              <div v-if="l.evaluation.evidence"><dt>报告路径</dt><dd><code>{{ l.evaluation.evidence }}</code></dd></div>
            </dl>
            </div>
          </details>
        </section>
        <CardEdgeLight />
      </article>
    </div>
    </template>
    </div>
  </article>
</template>

<script setup lang="ts">
import CreativeLibraryHeader from '@/components/library/CreativeLibraryHeader.vue'
import StudioSearch from '@/components/ui/StudioSearch.vue'
import StudioCopyButton from '@/components/ui/StudioCopyButton.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import CardEdgeLight from '@/components/visual/CardEdgeLight.vue'
import { useListTransition } from '@/composables/useListTransition'
import { ref, computed, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSceneStore } from '@/stores/sceneStore'
import { copyText } from '@/utils/clipboard'
import ArchiveStatePanel from '@/components/visual/ArchiveStatePanel.vue'
import ArchiveIcon, { type ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'
import neneAvatar from '@/assets/illustrations/nene-avatar.webp'
import natsumeAvatar from '@/assets/illustrations/natsume-avatar.webp'
import {
  formatLoraWeight,
  parseLoraCatalog,
  type LoraCatalogEntry,
} from '@/utils/loraCatalog'

const sceneStore = useSceneStore()
const route = useRoute()
const router = useRouter()
function routeFilter(key: 'q' | 'engine') { const value = route.query[key]; return typeof value === 'string' ? value : '' }
const loras = computed(() => parseLoraCatalog(sceneStore.loras))
const modelQuery = ref(routeFilter('q'))
const engine = ref(routeFilter('engine'))
let restoringFilters = false
watch([() => route.path, () => route.query.q, () => route.query.engine], () => {
  if (route.path !== '/lora') return
  restoringFilters = true
  modelQuery.value = routeFilter('q')
  engine.value = routeFilter('engine')
  restoringFilters = false
}, { flush: 'sync' })
watch([modelQuery, engine], ([q, selectedEngine]) => {
  if (restoringFilters || route.path !== '/lora' || (q === routeFilter('q') && selectedEngine === routeFilter('engine'))) return
  const query = { ...route.query }
  if (q) query.q = q
  else delete query.q
  if (selectedEngine) query.engine = selectedEngine
  else delete query.engine
  void router.replace({ path: route.path, query, hash: route.hash }).catch(() => {})
}, { flush: 'sync' })
const failedAvatars = ref(new Set<string>())
const listRoot = ref<HTMLElement | null>(null)
const searchInput = ref<InstanceType<typeof StudioSearch> | null>(null)
const catalogRoot = ref<HTMLElement | null>(null)
function retryCatalog(event: MouseEvent) {
  if (event.currentTarget === document.activeElement) catalogRoot.value?.focus({ preventScroll: true })
  void loadCatalog()
}
function resetFilters() {
  modelQuery.value = ''
  engine.value = ''
  searchInput.value?.focus()
}
const engineOptions = computed(() => {
  const counts = new Map<string, number>()
  for (const model of loras.value) {
    const value = modelGuide(model).engine
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [{ value:'', label:'全部引擎', count:loras.value.length }, ...[...counts].map(([value, count]) => ({ value, label:value, count }))]
})
const visibleLoras = computed(() => {
  const term = modelQuery.value.trim().toLocaleLowerCase()
  return loras.value.filter(model => (!engine.value || modelGuide(model).engine === engine.value) && (!term || [model.name, model.character, model.baseModel, model.description,
    modelGuide(model).name, modelGuide(model).engine, ...model.triggerWords].join(' ').toLocaleLowerCase().includes(term)))
    .sort((a, b) => Number(Boolean(modelCharacter(b.id))) - Number(Boolean(modelCharacter(a.id))))
})
const loading = ref(!loras.value.length)
const loadError = ref('')
// Presentation labels describe the four catalog records. Only the previously
// curated v21 identities get a character link; none of these labels load a model.
const MODEL_GUIDES: Record<string, { name: string; engine: string; purpose: string; icon: ArchiveIconName; character?: string; avatar?: string }> = {
  L_NENE_V18_WD14: { name: '绫地宁宁', engine: 'SD / Illustrious', purpose: '角色身份 · 脸部还原优先', icon: 'nene' },
  L_NAT_V18_WD14: { name: '四季夏目', engine: 'SD / Illustrious', purpose: '角色身份 · 脸部还原优先', icon: 'natsume' },
  L_NENE_V21_ANIMA: { name: '绫地宁宁', engine: 'Anima', purpose: '角色身份 · 服装与场景塑造', icon: 'nene', character: 'nene', avatar: neneAvatar },
  L_NAT_V21_ANIMA: { name: '四季夏目', engine: 'Anima', purpose: '角色身份 · 服装与场景塑造', icon: 'natsume', character: 'natsume', avatar: natsumeAvatar },
}
function modelCharacter(id: string) { return MODEL_GUIDES[id]?.character }
function modelAvatar(id: string) { return MODEL_GUIDES[id]?.avatar }
function modelGuide(model: LoraCatalogEntry) {
  return MODEL_GUIDES[model.id] ?? { name: model.character || '角色模型', engine: '引擎未标注', purpose: '角色模型资料', icon: 'model' as const }
}
useListTransition(listRoot, () => visibleLoras.value.map(model => model.id))

async function loadCatalog() {
  const version = sceneStore.version
  loading.value = !loras.value.length
  loadError.value = ''
  try {
    await sceneStore.loadLoraCatalog()
  } catch (e) {
    if (version !== sceneStore.version) return
    console.warn('lora load failed', e)
    loadError.value = String(e instanceof Error ? e.message : e)
  }
  if (version === sceneStore.version) loading.value = false
}

watch(() => sceneStore.version, () => { void loadCatalog() })
onMounted(() => { void loadCatalog() })
</script>

<style scoped>@reference "../assets/css/tailwind.css";
.model-catalog:focus-visible { outline:none; border-radius:var(--r-md); box-shadow:var(--focus-shadow); }
.model-catalog-note { display:flex; flex-wrap:wrap; align-items:center; gap:var(--s-3); margin-bottom:var(--s-4); color:var(--text-secondary); font-size:var(--fs-body-sm); }
.model-catalog-note > span { flex:1 1 20rem; min-width:0; overflow-wrap:anywhere; }
.model-availability { @apply tw:text-secondary tw:text-body-sm tw:leading-body; margin:var(--s-3) 0 var(--s-4); }
.model-actions { @apply tw:flex tw:flex-wrap tw:gap-s-2; }
.model-details { @apply tw:text-body-sm tw:text-secondary; border-top:1px solid var(--border-soft); }
.model-details summary, .evaluation-panel summary { @apply tw:flex tw:items-center tw:justify-between tw:gap-s-3 tw:cursor-pointer tw:min-h-[44px] tw:rounded-sm; padding:var(--s-3) var(--s-2); margin-inline:calc(-1 * var(--s-2)); }
.model-details summary:hover, .evaluation-panel summary:hover { background:var(--bg-hover); color:var(--text-primary); }
.model-details-body { @apply tw:pb-s-4; }
.model-facts { @apply tw:grid tw:gap-s-3 tw:m-0 tw:mb-s-3; }
.model-facts dt { @apply tw:mb-s-1 tw:text-muted tw:text-label-xs; }
.model-facts dd { @apply tw:m-0 tw:text-secondary; overflow-wrap:anywhere; }
.model-search-row { display:flex; align-items:center; flex-wrap:wrap; gap:var(--s-3); margin-bottom:var(--s-4); }
.model-search-field { flex:1 1 320px; max-width:560px; min-width:0; }
.model-result-count { color:var(--text-secondary); font-size:var(--fs-label); font-variant-numeric:tabular-nums; white-space:nowrap; }
.model-engine-filters { width:fit-content; max-width:100%; flex-wrap:wrap; margin-bottom:var(--s-5); }
.model-engine-filters button > span { display:grid; place-items:center; min-width:22px; min-height:22px; border:1px solid var(--border-soft); border-radius:var(--r-pill); font:400 var(--fs-mono-xs)/1 var(--font-mono); }
.model-identity { display:flex; align-items:center; gap:var(--s-4); margin-bottom:var(--s-4); }
.model-identity-copy { flex:1; min-width:0; }
.model-portrait { flex:0 0 104px; width:104px; margin:0; text-align:center; }
.model-portrait-art { display:grid; place-items:center; width:104px; height:104px; background:radial-gradient(ellipse,color-mix(in srgb,var(--model-color) 13%,transparent),transparent 72%); }
.model-portrait img { display:block; width:104px; height:104px; object-fit:contain; transition:transform var(--motion-route-cut) var(--spring-soft); }
.model-portrait figcaption { margin-top:var(--s-1); color:var(--text-secondary); font-size:var(--fs-label-xs); line-height:1.4; }
.model-edition { display:flex; flex-wrap:wrap; align-items:center; gap:var(--s-2); color:var(--text-secondary); font-size:var(--fs-label-xs); }
.model-identity .archive-icon { box-sizing:content-box; padding:var(--s-3); width:24px; height:24px; border:1px solid var(--border-soft); border-radius:var(--r-lg); background:color-mix(in srgb,var(--model-color) 12%,var(--bg-surface)); color:var(--model-color); transition:transform var(--motion-route-cut) var(--spring-soft); }
.model-identity > .archive-icon { flex-shrink:0; }
.lora-card:has(:focus-visible) .model-identity :is(.archive-icon,img) { transition:none; transform:none; }
.lora-card:has(:focus-visible) { transition:none; transform:none; }
.model-engine { padding:var(--s-1) var(--s-2); border:1px solid var(--border-soft); border-radius:var(--r-pill); background:var(--bg-surface); @apply tw:text-secondary tw:text-label-xs; }
.model-purpose { margin:var(--s-2) 0; @apply tw:text-secondary tw:text-body-sm tw:leading-body; }
.model-file { font:400 var(--fs-mono-sm)/var(--lh-body) var(--font-mono); overflow-wrap:anywhere; }
.lora-card .model-actions { margin-bottom:var(--s-3); }
.lora-tag { @apply tw:max-w-full; overflow-wrap:anywhere; }
.lora-grid { @apply tw:grid tw:gap-s-4; grid-template-columns:repeat(2,minmax(0,1fr)); align-items:start; }
.lora-card {
  --model-color:var(--accent);
  @apply tw:relative tw:overflow-hidden tw:p-s-5;
  border:1px solid var(--border-soft);
  @apply tw:rounded-lg;
  background:
    linear-gradient(145deg,color-mix(in srgb,var(--model-color) 8%,transparent),transparent 48%),
    var(--bg-surface);
  box-shadow:inset 0 1px 0 var(--glass-highlight),var(--shadow-sm);
  transition:transform var(--motion-surface) var(--ease-out);
}
.lora-card[data-character='nene'] { --model-color:var(--nene-violet); }
.lora-card[data-character='natsume'] { --model-color:var(--natsume-amber); }
.lora-card::before {
  content:"";
  position:absolute; inset:var(--s-5) auto var(--s-5) 0; width:3px; border-radius:var(--r-pill);
  background:var(--model-color);
}
.lora-name { @apply tw:m-0 tw:text-title-sm tw:font-semibold; font-family:var(--font-serif); }
.lora-desc { @apply tw:text-secondary tw:text-body-sm tw:leading-loose tw:mb-s-3; }
.lora-label { @apply tw:text-label-xs tw:text-muted tw:font-bold; letter-spacing:.06em; }
.lora-tag { padding:2px var(--s-2); background:var(--accent-soft); @apply tw:text-accent tw:rounded-pill tw:text-mono-xs; }
.lora-triggers { @apply tw:flex tw:flex-wrap tw:items-center tw:gap-s-1; }
.evaluation-panel {
  @apply tw:pt-s-3;
  border-top:1px solid var(--border-soft);
}
.evaluation-summary { @apply tw:m-0 tw:text-secondary tw:text-body-sm tw:leading-body; }
.evaluation-metrics { @apply tw:grid; grid-template-columns:repeat(2,minmax(0,1fr)); @apply tw:gap-s-2; }
.evaluation-metrics > div { @apply tw:grid tw:gap-[2px] tw:p-s-2; border:1px solid color-mix(in srgb,var(--border-soft) 74%,transparent); @apply tw:rounded-sm; background:var(--bg-elevated); }
.evaluation-metrics span { @apply tw:text-muted tw:text-label-xs; }
.evaluation-metrics strong { @apply tw:text-body-sm; }
.evaluation-limit { margin:var(--s-3) 0 0; @apply tw:text-warning-text tw:text-body-sm tw:leading-body; }
.evaluation-panel details { @apply tw:text-secondary tw:text-body-sm; }
.evaluation-panel dl { @apply tw:grid tw:gap-s-2; margin:var(--s-3) 0 0; }
.evaluation-panel dl > div { @apply tw:grid tw:gap-[2px]; }
.evaluation-panel dt { @apply tw:text-muted tw:text-label-xs; }
.evaluation-panel dd { @apply tw:m-0 tw:leading-body; overflow-wrap:anywhere; }
.evaluation-panel code { @apply tw:whitespace-normal; }

.model-details summary:focus-visible, .evaluation-panel summary:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
@media (max-width:800px) { .lora-grid { grid-template-columns:minmax(0,1fr); } }
@media (hover:hover) and (pointer:fine) { .lora-card:hover:not(:focus-within) { transform:translateY(-2px); } .lora-card:hover:not(:focus-within) .model-identity .archive-icon { transform:rotate(-8deg) translateY(-3px); } }
@media (hover:hover) and (pointer:fine) { .lora-card:hover:not(:focus-within) .model-portrait img { transform:rotate(-4deg) translateY(-3px); } }
@media (prefers-reduced-motion:reduce) { :root:not([data-motion='full']) .lora-page :is(.lora-card,.model-identity .archive-icon,.model-portrait img) { transition:none; transform:none; } }
:root:is([data-motion='reduce'],[data-motion='reduced']) .lora-page :is(.lora-card,.model-identity .archive-icon,.model-portrait img) { transition:none; transform:none; }
@media (forced-colors:active) { .lora-card::before { background:Highlight; } }
</style>

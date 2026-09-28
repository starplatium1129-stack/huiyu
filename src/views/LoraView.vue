<template>
  <article class="page lora-page creative-library-page">
    <CreativeLibraryHeader title="模型资料 (LoRA)" description="按角色与引擎查阅资料，选择角色后在工作台继续创作。" />
    <ArchiveStatePanel
      v-if="loading"
      kind="loading"
      title="正在读取模型目录"
      message="正在读取收录的 LoRA 资料与推荐权重。"
    />
    <ArchiveStatePanel
      v-else-if="loadError"
      kind="error"
      title="模型目录读取失败"
      message="本地模型档案暂时无法读取，请稍后重试。"
    >
      <button class="btn btn-primary" type="button" @click="loadCatalog">重新读取</button>
    </ArchiveStatePanel>
    <ArchiveStatePanel
      v-else-if="!loras.length"
      kind="empty"
      title="模型目录暂未收录"
      message="当前没有收录模型资料。仍可前往工作台选择已有角色，或在控制面板查看资源。"
    >
    </ArchiveStatePanel>
    <template v-else>
    <div class="model-search-row tw:flex tw:flex-wrap tw:items-center tw:gap-s-4"><input v-model="modelQuery" type="search" aria-label="搜索模型" placeholder="按模型、角色或触发词查找…" /><span role="status">{{ visibleLoras.length }} / {{ loras.length }} 份资料</span></div>
    <p class="model-catalog-note">资料收录与历史评测通过，均不代表本机已安装。可用性请在工作台检测。</p>
    <p v-if="!visibleLoras.length">没有匹配的模型。<button class="btn btn-ghost btn-sm" @click="modelQuery = ''">清除搜索</button></p>
    <div class="lora-grid">
      <article v-for="l in visibleLoras" :key="l.id" class="lora-card">
        <header class="model-identity">
          <div><ArchiveIcon :name="modelGuide(l).icon" /><h2 class="lora-name">{{ modelGuide(l).name }}</h2></div>
          <span class="model-engine">{{ modelGuide(l).engine }}</span>
        </header>
        <p class="model-purpose">{{ modelGuide(l).purpose }}</p>
        <p class="model-file"><code>{{ l.name }}</code><span v-if="l.version">v{{ l.version }}</span><span v-if="l.experimental" class="badge badge-warning">实验预览</span></p>
        <div class="model-actions">
          <RouterLink v-if="modelCharacter(l.id)" class="btn btn-primary" :to="{ path: '/prompt-builder', query: { char: modelCharacter(l.id) } }"><ArchiveIcon name="spark" />用此角色绘制</RouterLink>
          <button v-if="l.triggerWords.length" class="btn btn-ghost" type="button" @click="copyWithFeedback(l.triggerWords.join(', '), '已复制触发词')"><ArchiveIcon name="copy" />复制触发词</button>
        </div>
        <p class="model-availability">本机可用性尚未检测。<template v-if="modelCharacter(l.id)">入口只选择角色，不强制加载此历史版本；引擎与模型由工作台现有规则决定。</template><template v-else>仅供资料参考，未配置直接使用入口。</template></p>
        <details class="model-details">
          <summary>触发词与模型资料</summary>
          <div class="model-details-body">
            <p v-if="l.description" class="lora-desc">{{ l.description }}</p>
            <dl class="model-facts">
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
          <p class="evaluation-summary">历史评测 · {{ l.evaluation.status === 'passed' ? '已通过' : l.evaluation.status || '已记录' }}<span v-if="l.evaluation.evaluatedAt"> · {{ l.evaluation.evaluatedAt }}</span></p>
          <details>
            <summary>查看指标、方法与证据</summary>
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
          </details>
        </section>
      </article>
    </div>
    </template>
  </article>
</template>

<script setup lang="ts">
import CreativeLibraryHeader from '@/components/library/CreativeLibraryHeader.vue'
import { ref, computed, onMounted } from 'vue'
import { useSceneStore } from '@/stores/sceneStore'
import { copyWithFeedback } from '@/composables/useCopyFeedback'
import ArchiveStatePanel from '@/components/visual/ArchiveStatePanel.vue'
import ArchiveIcon, { type ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'
import {
  formatLoraWeight,
  parseLoraCatalog,
  type LoraCatalogEntry,
} from '@/utils/loraCatalog'

const sceneStore = useSceneStore()
const loras = ref<LoraCatalogEntry[]>([])
const modelQuery = ref('')
const visibleLoras = computed(() => {
  const term = modelQuery.value.trim().toLocaleLowerCase()
  return loras.value.filter(model => !term || [model.name, model.character, model.baseModel, model.description,
    modelGuide(model).name, modelGuide(model).engine, ...model.triggerWords].join(' ').toLocaleLowerCase().includes(term))
    .sort((a, b) => Number(Boolean(modelCharacter(b.id))) - Number(Boolean(modelCharacter(a.id))))
})
const loading = ref(true)
const loadError = ref('')
// Presentation labels describe the four catalog records. Only the previously
// curated v21 identities get a character link; none of these labels load a model.
const MODEL_GUIDES: Record<string, { name: string; engine: string; purpose: string; icon: ArchiveIconName; character?: string }> = {
  L_NENE_V18_WD14: { name: '绫地宁宁', engine: 'SD / Illustrious', purpose: '角色身份 · 脸部还原优先', icon: 'nene' },
  L_NAT_V18_WD14: { name: '四季夏目', engine: 'SD / Illustrious', purpose: '角色身份 · 脸部还原优先', icon: 'natsume' },
  L_NENE_V21_ANIMA: { name: '绫地宁宁', engine: 'Anima', purpose: '角色身份 · 服装与场景塑造', icon: 'nene', character: 'nene' },
  L_NAT_V21_ANIMA: { name: '四季夏目', engine: 'Anima', purpose: '角色身份 · 服装与场景塑造', icon: 'natsume', character: 'natsume' },
}
function modelCharacter(id: string) { return MODEL_GUIDES[id]?.character }
function modelGuide(model: LoraCatalogEntry) {
  return MODEL_GUIDES[model.id] ?? { name: model.character || '角色模型', engine: '引擎未标注', purpose: '角色模型资料', icon: 'model' as const }
}

async function loadCatalog() {
  loading.value = true
  loadError.value = ''
  try {
    await sceneStore.loadLoraCatalog()
    loras.value = parseLoraCatalog(sceneStore.loras)
  } catch (e) {
    console.warn('lora load failed', e)
    loadError.value = String(e instanceof Error ? e.message : e)
  }
  loading.value = false
}

onMounted(() => { void loadCatalog() })
</script>

<style scoped>@reference "../assets/css/tailwind.css";
.model-availability { @apply tw:text-secondary tw:text-body-sm tw:leading-body; margin:var(--s-3) 0 var(--s-4); }
.model-actions { @apply tw:flex tw:flex-wrap tw:gap-s-2; }
.model-details { @apply tw:text-body-sm tw:text-secondary; border-top:1px solid var(--border-soft); }
.model-details summary, .evaluation-panel summary { @apply tw:cursor-pointer tw:min-h-[44px]; padding-block:var(--s-3); }
.model-details-body { @apply tw:pb-s-4; }
.model-facts { @apply tw:grid tw:gap-s-3 tw:m-0 tw:mb-s-3; }
.model-facts dt { @apply tw:mb-s-1 tw:text-muted tw:text-label-xs; }
.model-facts dd { @apply tw:m-0 tw:text-secondary; overflow-wrap:anywhere; }
.model-search-row input { width: min(440px, 100%); @apply tw:min-h-[42px] tw:p-s-3; border: 1px solid var(--border-soft); @apply tw:rounded-md tw:text-primary; background: var(--bg-surface); font: inherit; }
.model-search-row span { @apply tw:text-muted tw:text-label; }
.model-catalog-note { margin:var(--s-3) 0 var(--s-5); @apply tw:text-secondary tw:text-body-sm tw:leading-body; }
.model-identity { @apply tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-s-2; }
.model-identity > div { @apply tw:flex tw:items-center tw:gap-s-2; }
.model-identity .archive-icon { @apply tw:text-accent tw:w-[24px] tw:h-[24px]; }
.model-engine { @apply tw:text-accent tw:text-body-sm; }
.model-purpose { margin:var(--s-2) 0; @apply tw:text-secondary tw:text-body-sm tw:leading-body; }
.model-file { @apply tw:flex tw:flex-wrap tw:gap-s-2 tw:text-muted tw:text-mono-sm; margin:0 0 var(--s-4); overflow-wrap:anywhere; }
.model-file code { font:inherit; }
.lora-tag { @apply tw:max-w-full; overflow-wrap:anywhere; }
.lora-grid { @apply tw:grid tw:gap-s-4; grid-template-columns:repeat(auto-fit,minmax(min(360px, 100%),1fr)); align-items:start; }
.lora-card {
  @apply tw:relative tw:overflow-hidden tw:p-s-5;
  border:1px solid color-mix(in srgb,var(--archive-blue) 18%,var(--border-soft));
  @apply tw:rounded-lg;
  background:
    linear-gradient(145deg,color-mix(in srgb,var(--archive-blue) 7%,transparent),transparent 32%),
    var(--bg-surface);
  box-shadow:var(--shadow-glass-sm);
}
.lora-card::before {
  content:"";
  @apply tw:absolute tw:top-[-1px] tw:left-s-4 tw:w-[42px] tw:h-[1px];
  background:linear-gradient(90deg,var(--archive-blue),transparent);
}
.lora-name { @apply tw:m-0 tw:text-title-sm tw:font-semibold; }
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

.model-details summary:focus-visible, .evaluation-panel summary:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
</style>

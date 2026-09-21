<template>
  <article class="page" style="--page-max:1100px">
    <WorkspaceArchiveBar
      chapter="10"
      title="模型资料"
      :subtitle="loading ? '正在读取资料' : `${loras.length} 份角色模型资料`"
      :status="loading ? '读取中' : (loadError ? '读取失败' : loras.length ? '资料已收录' : '暂无资料')"
      :state="loading ? 'active' : (loras.length ? 'success' : 'warning')"
      shape="frame"
    />
    <div class="lora-title-row">
      <div>
        <h1 class="title">模型资料 (LoRA)</h1>
        <p class="subtitle">查阅角色特征、推荐权重与历史评测。资料收录不代表本机已安装；进入工作台后可检测当前引擎与模型是否可用。</p>
      </div>
    </div>
    <CreativeLibraryNav />
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
    <div class="model-search-row"><input v-model="modelQuery" type="search" aria-label="搜索模型" placeholder="按模型、角色或触发词查找…" /><span role="status">{{ visibleLoras.length }} / {{ loras.length }} 个模型</span></div>
    <p v-if="!visibleLoras.length">没有匹配的模型。<button class="btn btn-ghost btn-sm" @click="modelQuery = ''">清除搜索</button></p>
    <div class="lora-grid">
      <div v-for="l in visibleLoras" :key="l.id" class="lora-card">
        <div class="lora-header">
          <span class="lora-name">{{ l.name }}</span>
          <span v-if="l.version" class="lora-version">v{{ l.version }}</span>
          <span v-if="l.experimental" class="badge badge-warning">实验预览</span>
        </div>
        <div v-if="l.description" class="lora-desc">{{ l.description }}</div>
        <details v-if="l.description && l.description.length > 100" class="model-details"><summary>展开完整说明</summary><p>{{ l.description }}</p></details>
        <div class="lora-meta">
          <span v-if="l.recommendedWeight" class="lora-pill">推荐权重 {{ formatLoraWeight(l.recommendedWeight) }}</span>
          <span v-if="l.baseModel" class="lora-pill">{{ l.baseModel }}</span>
          <span v-if="l.character" class="lora-pill">{{ l.character }}</span>
        </div>
        <div v-if="l.triggerWords.length" class="lora-triggers">
          <span class="lora-label">触发词</span>
          <span v-for="tw in l.triggerWords" :key="tw" class="lora-tag">{{ tw }}</span>
        </div>
        <section v-if="l.evaluation" class="evaluation-panel" aria-label="模型评测结果">
          <div class="evaluation-head">
            <div>
              <span class="lora-label">历史评测 · 固定种子人工盲审</span>
              <strong>{{ l.evaluation.evaluatedAt || '已完成' }}</strong>
            </div>
            <span class="badge" :class="l.experimental ? 'badge-warning' : 'badge-success'">{{ l.evaluation.status === 'passed' ? '已通过' : l.evaluation.status }}</span>
          </div>
          <div class="evaluation-metrics">
            <div v-for="metric in l.evaluation.metrics" :key="metric[0]">
              <span>{{ metric[0] }}</span>
              <strong>{{ metric[1] }}</strong>
            </div>
          </div>
          <p v-if="l.evaluation.knownLimitation" class="evaluation-limit">
            <strong>已知限制：</strong>{{ l.evaluation.knownLimitation }}
          </p>
          <details>
            <summary>查看评测方法与证据</summary>
            <dl>
              <div v-if="l.evaluation.matrix"><dt>对照矩阵</dt><dd>{{ l.evaluation.matrix }}</dd></div>
              <div v-if="l.evaluation.method"><dt>方法</dt><dd>{{ l.evaluation.method }}</dd></div>
              <div v-if="l.evaluation.selectionReason"><dt>晋升理由</dt><dd>{{ l.evaluation.selectionReason }}</dd></div>
              <div v-if="l.evaluation.evidence"><dt>报告路径</dt><dd><code>{{ l.evaluation.evidence }}</code></dd></div>
            </dl>
          </details>
        </section>
        <div class="model-actions">
          <button v-if="l.triggerWords.length" class="btn btn-ghost" type="button" @click="copyWithFeedback(l.triggerWords.join(', '), '已复制触发词')">复制触发词</button>
          <RouterLink v-if="modelCharacter(l.id)" class="btn btn-ghost" :to="{ path: '/prompt-builder', query: { char: modelCharacter(l.id) } }">用此角色绘制</RouterLink>
          <span v-else>仅供资料参考，未配置直接使用入口</span>
        </div>
        <p v-if="modelCharacter(l.id)" class="model-availability">本机可用性尚未检测。入口只选择角色，不强制加载此历史版本；引擎与模型由工作台现有规则决定。</p>
      </div>
    </div>
    </template>
  </article>
</template>

<script setup lang="ts">
import CreativeLibraryNav from '@/components/library/CreativeLibraryNav.vue'
import { ref, computed, onMounted } from 'vue'
import { useSceneStore } from '@/stores/sceneStore'
import { copyWithFeedback } from '@/composables/useCopyFeedback'
import WorkspaceArchiveBar from '@/components/visual/WorkspaceArchiveBar.vue'
import ArchiveStatePanel from '@/components/visual/ArchiveStatePanel.vue'
import {
  formatLoraWeight,
  parseLoraCatalog,
  type LoraCatalogEntry,
} from '@/utils/loraCatalog'

const sceneStore = useSceneStore()
const loras = ref<LoraCatalogEntry[]>([])
const modelQuery = ref('')
const visibleLoras = computed(() => { const term = modelQuery.value.trim().toLocaleLowerCase(); return loras.value.filter(model => !term || [model.name, model.character, model.baseModel, model.description, ...model.triggerWords].join(' ').toLocaleLowerCase().includes(term)) })
const loading = ref(true)
const loadError = ref('')
// Explicit curated identity mapping; never infer a runnable model from display names.
function modelCharacter(id: string) {
  if (id === 'L_NENE_V21_ANIMA') return 'nene'
  if (id === 'L_NAT_V21_ANIMA') return 'natsume'
  return undefined
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

<style scoped>
.model-actions { display: flex; flex-wrap: wrap; gap: var(--s-2); margin-top: var(--s-4); }
.model-actions > span, .model-availability { color: var(--text-secondary); font-size: var(--fs-body-sm); line-height: var(--lh-body); }
.model-availability { margin-top: var(--s-3); }
.model-details { font-size: var(--fs-label); color: var(--text-secondary); margin-bottom: var(--s-3); }
.model-details summary { cursor: pointer; }
.lora-grid .lora-desc { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.model-search-row { display: flex; align-items: center; gap: var(--s-4); margin-bottom: var(--s-5); flex-wrap: wrap; }
.model-search-row input { width: min(440px, 100%); min-height: 42px; padding: var(--s-3); border: 1px solid var(--border-soft); border-radius: var(--r-md); color: var(--text-primary); background: var(--bg-surface); font: inherit; }
.model-search-row span { color: var(--text-muted); font-size: var(--fs-label); }

.lora-title-row {
  display:flex;
  align-items:flex-end;
  justify-content:space-between;
  gap:var(--s-4);
  margin-bottom:var(--s-5);
}
.lora-title-row .title { margin-bottom:var(--s-2); }
.lora-title-row .subtitle { margin-bottom:0; }
.lora-grid { display:grid; gap:var(--s-4); grid-template-columns:repeat(auto-fill,minmax(min(320px, 100%),1fr)); }
.lora-card {
  position:relative;
  overflow:hidden;
  padding:var(--s-5);
  border:1px solid color-mix(in srgb,var(--archive-blue) 18%,var(--border-soft));
  border-radius:var(--r-lg);
  background:
    linear-gradient(145deg,color-mix(in srgb,var(--archive-blue) 7%,transparent),transparent 32%),
    var(--bg-surface);
  box-shadow:var(--shadow-glass-sm);
  transition: transform var(--motion-surface) var(--ease-out), border-color var(--motion-surface), box-shadow var(--motion-surface);
}
@media (hover: hover) and (pointer: fine) {
  .lora-card:hover {
    transform: translateY(-3px);
    border-color: color-mix(in srgb, var(--archive-blue) 46%, var(--border-soft));
    box-shadow: var(--shadow-md);
  }
}
@media (prefers-reduced-motion: reduce) { .lora-card { transition: none; } }
.lora-card::before {
  content:"";
  position:absolute;
  top:-1px;
  left:var(--s-4);
  width:42px;
  height:1px;
  background:linear-gradient(90deg,var(--archive-blue),transparent);
}
.lora-header { display:flex; align-items:baseline; gap:var(--s-2); margin-bottom:var(--s-2); }
.lora-name { font-size:var(--fs-title-xs); font-weight:800; }
.lora-version { color:var(--text-muted); font-size:var(--fs-mono-sm); }
.lora-desc { color:var(--text-secondary); font-size:var(--fs-body-sm); line-height:var(--lh-loose); margin-bottom:var(--s-3); }
.lora-meta { display:flex; flex-wrap:wrap; gap:var(--s-1); margin-bottom:var(--s-2); }
.lora-pill { padding:2px var(--s-2); border:1px solid var(--border-soft); border-radius:var(--r-pill); color:var(--text-muted); font-size:var(--fs-mono-xs); }
.lora-triggers { display:flex; flex-wrap:wrap; gap:var(--s-1); align-items:center; }
.lora-label { font-size:var(--fs-label-xs); color:var(--text-muted); font-weight:700; letter-spacing:.06em; }
.lora-tag { padding:2px var(--s-2); background:var(--accent-soft); color:var(--accent); border-radius:var(--r-pill); font-size:var(--fs-mono-xs); }
.evaluation-panel {
  margin-top:var(--s-4);
  padding:var(--s-4);
  border:1px solid color-mix(in srgb,var(--border-soft) 86%,transparent);
  border-radius:var(--r-md);
  background:color-mix(in srgb,var(--bg-deep) 42%,transparent);
}
.evaluation-head { display:flex; justify-content:space-between; align-items:center; gap:var(--s-3); margin-bottom:var(--s-3); }
.evaluation-head > div { display:grid; gap:2px; }
.evaluation-head strong { font-size:var(--fs-body-sm); }
.evaluation-metrics { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--s-2); }
.evaluation-metrics > div { display:grid; gap:2px; padding:var(--s-2); border:1px solid color-mix(in srgb,var(--border-soft) 74%,transparent); border-radius:var(--r-sm); background:var(--bg-elevated); }
.evaluation-metrics span { color:var(--text-muted); font-size:var(--fs-label-xs); }
.evaluation-metrics strong { font-size:var(--fs-body-sm); }
.evaluation-limit { margin:var(--s-3) 0 0; color:var(--warning-text); font-size:var(--fs-body-sm); line-height:var(--lh-body); }
.evaluation-panel details { margin-top:var(--s-3); color:var(--text-secondary); font-size:var(--fs-body-sm); }
.evaluation-panel summary { cursor:pointer; color:var(--text-primary); font-weight:700; }
.evaluation-panel dl { display:grid; gap:var(--s-2); margin:var(--s-3) 0 0; }
.evaluation-panel dl > div { display:grid; gap:2px; }
.evaluation-panel dt { color:var(--text-muted); font-size:var(--fs-label-xs); }
.evaluation-panel dd { margin:0; line-height:var(--lh-body); overflow-wrap:anywhere; }
.evaluation-panel code { white-space:normal; }

@media (max-width: 600px) {
  .lora-title-row { align-items:flex-start; flex-direction:column; }
  .evaluation-metrics { grid-template-columns:1fr; }
}
</style>

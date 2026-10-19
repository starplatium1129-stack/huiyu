<template>
  <section ref="panel" class="panel-card interrogate-setup" aria-labelledby="interrogate-setup-title">
    <div class="interrogate-heading">
      <div><h2 id="interrogate-setup-title" ref="title" class="panel-heading" tabindex="-1">图片反推</h2><p>准备 PixAI 模型，将参考图变成创作词条。</p></div>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="checking || submitting" @click="refresh">{{ checking ? '检查中…' : '重新检查' }}</button>
    </div>
    <div class="interrogate-status" :data-ready="ready" role="status" aria-live="polite">
      <ArchiveIcon :name="ready ? 'success' : 'info'" />
      <span>{{ ready ? '反推组件已准备，首次使用时加载模型。' : checking ? '正在检查本机环境与准备计划…' : running ? '正在准备图片反推。' : readiness.status.value.message }}</span>
    </div>
    <template v-if="plan">
      <div class="interrogate-location"><span>AI 工作区</span><code>{{ plan.workspacePath }}</code></div>
      <p v-if="workspacePending" class="interrogate-warning" role="status">AI 工作区已更改，请先在<RouterLink :to="{ query: $route.query, hash: '#control-setup' }">首次配置</RouterLink>中完成目录切换，再重新检查。</p>
      <ul v-if="!plan.supported && plan.reasons.length" class="interrogate-reasons"><li v-for="reason in plan.reasons" :key="reason">{{ reason }}</li></ul>
      <p v-else-if="!plan.supported" class="interrogate-warning">当前环境尚不能准备反推模型，请检查 AI 工作区与设备后重试。</p>
      <template v-if="!ready">
        <dl class="interrogate-budget">
          <div><dt>本次最多下载</dt><dd>{{ formatSetupBytes(plan.downloadBytes) }}</dd></div>
          <div><dt>所需空间</dt><dd>{{ formatSetupBytes(plan.requiredBytes) }}</dd></div>
          <div><dt>可用空间</dt><dd>{{ plan.freeBytes === null ? '尚未确认' : formatSetupBytes(plan.freeBytes) }}</dd></div>
        </dl>
        <p v-if="plan.supported && !enoughSpace" class="interrogate-warning" role="status">请释放足够空间或在首次配置中选择可写目录，再重新检查。</p>
        <p class="interrogate-hint">自动准备独立 Python、CUDA 运行库与 PixAI 模型，无需 ComfyUI。逐项校验文件，完成后无需重启绘遇；反推时需约 4 GiB 空闲显存。</p>
      </template>
      <details class="interrogate-details">
        <StudioDisclosureSummary>下载位置与来源</StudioDisclosureSummary>
        <div class="interrogate-detail-content">
          <p>{{ plan.runtime.label }}：{{ plan.runtime.installed ? '已有安装记录' : formatSetupBytes(plan.runtime.downloadBytes) }}<br />{{ plan.model.label }}：{{ plan.model.installed ? '已找到文件' : formatSetupBytes(plan.model.downloadBytes) }}</p>
          <dl class="interrogate-paths"><template v-for="item in paths" :key="item.label"><dt>{{ item.label }}</dt><dd><code>{{ item.path }}</code></dd></template></dl>
          <ul class="interrogate-sources"><li v-for="source in plan.sources" :key="source.url"><a :href="source.url" target="_blank" rel="noopener noreferrer" :aria-label="`${source.label}来源，在新窗口打开`">{{ source.label }}</a><a v-if="source.licenseUrl" :href="source.licenseUrl" target="_blank" rel="noopener noreferrer" :aria-label="`${source.label}许可，在新窗口打开`">许可</a></li></ul>
          <p class="interrogate-hint">模型版本：<code>{{ plan.model.revision }}</code>。取消后保留已完成的文件，可继续准备。</p>
        </div>
      </details>
    </template>
    <div v-if="running" class="interrogate-progress" role="status" aria-live="polite">
      <div><strong>{{ operation ? operation.stages[operation.stageIndex] || '正在准备图片反推' : '正在准备图片反推' }}</strong><span v-if="progress !== null">{{ progress }}%</span></div>
      <progress v-if="operation && operation.totalBytes > 0" :value="operation.downloadedBytes" :max="operation.totalBytes" aria-label="图片反推下载进度" />
      <p>{{ cancelState === 'accepted' ? '已请求取消，等待后台结束。' : operation?.message }}</p>
      <code v-if="operation?.currentFile" class="interrogate-current-file">{{ operation.currentFile }}</code>
      <small v-if="operation?.totalBytes">{{ formatSetupBytes(operation.downloadedBytes) }} / {{ formatSetupBytes(operation.totalBytes) }}</small>
      <p v-if="operation?.cancelAllowed === false" class="interrogate-hint">{{ operation.phase === 'activating' ? '正在保存并启用反推配置，请等待完成。' : '正在完成系统安装步骤，请在 Windows 安装器中继续或取消。' }}</p>
    </div>
    <p v-if="otherBusy" role="status">控制室另有操作正在进行，结束后即可准备图片反推。</p>
    <p v-if="error" class="interrogate-error" role="alert">{{ error }}</p>
    <p v-if="message && !running" role="status">{{ message }}</p>
    <div ref="actions" class="interrogate-actions" tabindex="-1" role="group" aria-label="图片反推操作">
      <button v-if="operationUncertain" class="btn btn-primary" type="button" :disabled="submitting || checking" @click="reconcile">继续核对进度</button>
      <button v-else-if="!ready && plan" class="btn btn-primary" type="button" :disabled="!canPrepare" @click="prepare"><ArchiveIcon name="download" />{{ busy ? '正在准备…' : operation?.status === 'failed' ? '继续准备' : '一键准备' }}</button>
      <button v-if="running" class="btn btn-quiet" type="button" :disabled="!canCancel" @click="cancel">{{ cancelState === 'pending' || cancelState === 'accepted' ? '正在取消…' : '取消准备' }}</button>
      <small v-if="running">可以离开此页，后台会继续准备。</small>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUpdate, onMounted, onUpdated, ref } from 'vue'
import { useRoute } from 'vue-router'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import { useInterrogateSetup } from '@/composables/useInterrogateSetup'
import { formatSetupBytes } from '@/utils/localSetupPreparation'

const { plan, operation, readiness, checking, submitting, running, busy, ready, enoughSpace, canPrepare, canCancel,
  otherBusy, workspacePending, operationUncertain, progress, cancelState, error, message, initialize, refresh, reconcile, prepare, cancel } = useInterrogateSetup()
const paths = computed(() => plan.value ? [
  { label: '运行库', path: plan.value.paths.runtimeRoot }, { label: '反推模型', path: plan.value.paths.modelRoot },
  { label: '模型依赖', path: plan.value.paths.depsRoot }, { label: '下载缓存', path: plan.value.paths.cacheRoot },
] : [])
const route = useRoute()
const panel = ref<HTMLElement | null>(null), title = ref<HTMLElement | null>(null), actions = ref<HTMLElement | null>(null)
let focusOrigin: HTMLButtonElement | null = null
let focusHost: HTMLElement | null = null
function visible(element: HTMLElement | null) {
  if (!element?.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]') || getComputedStyle(element).visibility === 'hidden') return false
  const bounds = element.getBoundingClientRect()
  return bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.top < innerHeight
}
onBeforeUpdate(() => {
  const active = document.activeElement
  focusOrigin = active instanceof HTMLButtonElement && panel.value?.contains(active) && visible(active) ? active : null
  focusHost = focusOrigin?.closest<HTMLElement>('.interrogate-actions') ?? title.value
})
onUpdated(() => {
  const origin = focusOrigin, host = focusHost
  focusOrigin = null; focusHost = null
  if (!origin || origin.isConnected && !origin.disabled || route.path !== '/control' || !document.hasFocus() || !visible(panel.value)) return
  if (document.activeElement !== document.body && document.activeElement !== origin) return
  if ([...document.querySelectorAll<HTMLElement>('dialog:modal, [aria-modal="true"]')].some(element =>
    element.getClientRects().length && !element.closest('[hidden], [aria-hidden="true"]') && getComputedStyle(element).visibility !== 'hidden')) return
  ;[host, actions.value, title.value].find(visible)?.focus({ preventScroll: true })
})
onMounted(() => { void initialize() })
</script>

<style scoped>
.interrogate-setup { display:grid; gap:var(--s-4); margin-bottom:var(--s-5); color:var(--text-primary); min-width:0; }
.interrogate-heading, .interrogate-actions { display:flex; align-items:center; flex-wrap:wrap; gap:var(--s-3); }
.interrogate-heading { justify-content:space-between; }
.interrogate-heading .panel-heading { margin:0 0 var(--s-2); }
.interrogate-actions { min-height:var(--control-height); }
.interrogate-heading p, .interrogate-setup p { margin:0; color:var(--text-secondary); line-height:var(--lh-loose); overflow-wrap:anywhere; }
.interrogate-status { display:flex; align-items:flex-start; gap:var(--s-2); color:var(--text-secondary); }
.interrogate-status > :first-child { width:18px; height:18px; flex-shrink:0; margin-top:3px; }
.interrogate-status[data-ready="true"] { color:var(--success-text); }
.interrogate-location { display:grid; gap:var(--s-1); }
.interrogate-location > span, .interrogate-budget dt, .interrogate-paths dt, .interrogate-setup small { color:var(--text-secondary); font-size:var(--fs-label-sm); }
.interrogate-setup code { font-family:var(--font-mono); font-size:var(--fs-label-sm); overflow-wrap:anywhere; }
.interrogate-budget { display:flex; flex-wrap:wrap; gap:var(--s-5); margin:0; }
.interrogate-budget dd { margin:var(--s-1) 0 0; color:var(--text-primary); font-variant-numeric:tabular-nums; }
.interrogate-reasons { margin:0; padding-left:var(--s-5); color:var(--text-secondary); line-height:var(--lh-loose); }
.interrogate-setup .interrogate-warning, .interrogate-setup .interrogate-error { color:var(--danger-text); }
.interrogate-setup .interrogate-hint { font-size:var(--fs-label-sm); }
.interrogate-details { border-top:1px solid var(--border-soft); padding-top:var(--s-2); }
.interrogate-detail-content { display:grid; gap:var(--s-3); padding-top:var(--s-3); }
.interrogate-paths { display:grid; grid-template-columns:auto minmax(0,1fr); gap:var(--s-2) var(--s-4); margin:0; }
.interrogate-paths dd { margin:0; }
.interrogate-sources { display:flex; flex-wrap:wrap; gap:var(--s-2) var(--s-4); list-style:none; margin:0; padding:0; }
.interrogate-sources li { display:flex; gap:var(--s-2); }
.interrogate-progress { display:grid; gap:var(--s-2); padding:var(--s-4); background:var(--bg-elevated); border:1px solid var(--border-soft); border-radius:var(--r-md); }
.interrogate-progress > div { display:flex; justify-content:space-between; flex-wrap:wrap; gap:var(--s-2); }
.interrogate-progress progress { width:100%; height:8px; accent-color:var(--accent); }
.interrogate-current-file { color:var(--text-secondary); }
.interrogate-setup :is(button,a,#interrogate-setup-title,.interrogate-actions):focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.interrogate-setup button:disabled { color:var(--text-disabled); opacity:1; }
@media (forced-colors:active) { .interrogate-setup :is(button,a,#interrogate-setup-title,.interrogate-actions):focus-visible { outline:2px solid Highlight; outline-offset:2px; } }
</style>

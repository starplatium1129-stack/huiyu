<script setup lang="ts">
import { computed, useId } from 'vue'
import StudioOrbitSpinner from '@/components/ui/StudioOrbitSpinner.vue'
import { formatSetupBytes } from '@/utils/localSetupPreparation'

// Read-only presentation: the owning setup flow keeps cancellation and recovery.
// These counters include cache checks and verification, so they are not network speed.
const props = withDefaults(defineProps<{
  title: string
  phase?: string
  received?: number
  total?: number
  currentFile?: string
  message?: string
  completedFiles?: number
  totalFiles?: number
  scope?: 'file' | 'manifest'
}>(), { scope: 'manifest' })
const headingId = useId()
const phases: Record<string, string> = {
  checking: '检查已有文件', downloading: '正在下载', verifying: '校验文件',
  'download-progress': '正在下载', 'copy-progress': '正在复制',
  extracting: '正在解压', installing: '正在安装', activating: '正在启用',
  validating: '核验环境与模型', converting: '正在转换模型', preparing: '正在准备',
  prepared: '文件已就绪，继续下一步', environment: '安装运行环境', models: '准备模型文件',
  service: '启动服务', validation: '检查配置',
}
const phaseLabel = computed(() => phases[props.phase ?? ''] || '正在处理')
const bytePhase = computed(() => !props.phase || ['checking', 'downloading', 'verifying', 'download-progress', 'copy-progress'].includes(props.phase))
const totalBytes = computed(() => props.total && Number.isFinite(props.total) && props.total > 0 ? props.total : null)
const receivedBytes = computed(() => Number.isFinite(props.received) ? Math.max(0, props.received ?? 0) : 0)
const fileProgress = computed(() => !bytePhase.value && (props.totalFiles ?? 0) > 0)
const percent = computed(() => fileProgress.value ? Math.min(100, Math.floor((props.completedFiles ?? 0) / props.totalFiles! * 100))
  : bytePhase.value && totalBytes.value !== null ? Math.min(100, Math.floor(receivedBytes.value / totalBytes.value * 100)) : null)
const progressLabel = computed(() => props.scope === 'file' ? '当前文件进度' : '文件处理进度')
</script>

<template>
  <section class="transfer-progress" :aria-labelledby="headingId">
    <div class="transfer-heading">
      <StudioOrbitSpinner />
      <div role="status" aria-live="polite" aria-atomic="true"><strong :id="headingId">{{ title }}</strong><span>{{ phaseLabel }}</span></div>
      <div v-if="percent !== null" class="transfer-percent" aria-hidden="true">{{ percent }}<small>%</small></div>
    </div>
    <div v-if="bytePhase || fileProgress" class="transfer-track" role="progressbar" :aria-label="fileProgress ? '环境文件检查进度' : progressLabel"
      :aria-valuemin="0" :aria-valuemax="100" :aria-valuenow="percent ?? undefined"
      :aria-valuetext="percent === null ? '正在确认文件大小' : `${percent}%`">
      <span v-if="percent !== null" :style="{ transform: `scaleX(${percent / 100})` }" />
    </div>
    <div v-if="fileProgress" class="transfer-volume"><span>环境文件</span><strong>{{ completedFiles ?? 0 }} / {{ totalFiles }}</strong></div>
    <div v-if="bytePhase" class="transfer-volume">
      <span>{{ scope === 'file' ? '当前文件' : '文件处理量' }}</span>
      <strong>{{ formatSetupBytes(receivedBytes) }} <span>/ {{ totalBytes === null ? '总量待确认' : formatSetupBytes(totalBytes) }}</span></strong>
    </div>
    <p v-if="message" class="transfer-message">{{ message }}</p>
    <div v-if="currentFile && bytePhase" class="transfer-file"><span>当前文件</span><code>{{ currentFile }}</code></div>
    <div v-if="$slots.default" class="transfer-actions"><slot /></div>
  </section>
</template>

<style scoped>
.transfer-progress { display:grid; gap:var(--s-3); min-width:0; padding:var(--s-4); border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-elevated); color:var(--text-primary); }
.transfer-heading { display:flex; align-items:center; gap:var(--s-3); }
.transfer-heading > .studio-orbit-spinner { width:32px; height:32px; }
.transfer-heading > div:first-of-type { display:grid; gap:var(--s-1); min-width:0; flex:1; }
.transfer-heading strong { font-size:var(--fs-body); overflow-wrap:anywhere; }
.transfer-heading > div > span { color:var(--text-secondary); font-size:var(--fs-label-sm); }
.transfer-percent { font-size:var(--fs-title); font-variant-numeric:tabular-nums; line-height:1; min-inline-size:4ch; text-align:end; }
.transfer-percent small { margin-left:2px; font-size:var(--fs-label); color:var(--text-secondary); }
.transfer-track { height:8px; overflow:hidden; border-radius:var(--r-pill); background:var(--border-soft); }
.transfer-track > span { display:block; width:100%; height:100%; background:var(--accent); transform-origin:left; }
.transfer-volume { display:flex; flex-wrap:wrap; justify-content:space-between; gap:var(--s-2); font-size:var(--fs-label-sm); color:var(--text-secondary); }
.transfer-volume strong { color:var(--text-primary); font-weight:500; font-variant-numeric:tabular-nums; }
.transfer-volume strong span { color:var(--text-secondary); }
.transfer-progress .transfer-message { margin:0; line-height:var(--lh-loose); color:var(--text-secondary); overflow-wrap:anywhere; }
.transfer-message { font-size:var(--fs-label); }
.transfer-file { display:grid; gap:var(--s-1); font-size:var(--fs-label-sm); color:var(--text-secondary); }
.transfer-file code { font-family:var(--font-mono); overflow-wrap:anywhere; }
.transfer-actions { display:flex; align-items:center; flex-wrap:wrap; gap:var(--s-3); }
@media (forced-colors:active) {
  .transfer-track { border:1px solid CanvasText; }
  .transfer-track > span { background:Highlight; }
}
</style>

<template>
  <details class="preparation">
    <StudioDisclosureSummary>手动管理已有环境与逐项下载<span>{{ models.length - matched }} 项待核对</span></StudioDisclosureSummary>
    <div data-disclosure-content class="preparation-body">
      <p>核对运行方式、模型目录与来源许可后下载。绘遇不代为安装程序或接受许可。</p>
      <label class="route-label" for="setup-comfy-route">ComfyUI 运行方式</label>
      <StudioSelect id="setup-comfy-route" v-model="route" class="route-select" label="ComfyUI 运行方式" :options="[
        { value: 'desktop', label: '官方 Desktop' },
        { value: 'portable', label: 'Windows Portable 便携包' },
        { value: 'manual', label: '已有 Python / Conda 环境' },
      ]" />
      <ol v-content-motion:fade="route" class="preparation-steps">
        <li>
          <h3>准备运行环境</h3>
          <template v-if="route === 'desktop'">
            <p>安装并启动官方 Desktop 实例，在设置中确认实际模型目录。Python 环境由 Desktop 维护，不在此接管。</p>
            <a href="https://docs.comfy.org/installation/desktop/windows" target="_blank" rel="noopener noreferrer">官方 Desktop 文档</a>
          </template>
          <template v-else-if="route === 'portable'">
            <p>解压官方便携包，保留 python_embeded 原名，使用包内启动脚本。受管启动可复用此 Python。</p>
            <a href="https://docs.comfy.org/installation/comfyui_portable_windows" target="_blank" rel="noopener noreferrer">官方 Portable 文档</a>
          </template>
          <template v-else>
            <p>根据官方要求配置 Python、PyTorch 与 requirements.txt。受管启动仅识别 ComfyUI/main.py 与 venv 目录。</p>
            <a href="https://docs.comfy.org/installation/manual_install" target="_blank" rel="noopener noreferrer">官方手动安装说明</a>
          </template>
          <p>硬件兼容性未确认；显存容量不等于可直接运行。下载前将检查磁盘空间。</p>
          <a href="https://docs.comfy.org/installation/system_requirements" target="_blank" rel="noopener noreferrer">系统与硬件要求</a>
        </li>
        <li>
          <h3>核对工作区目录</h3>
          <p>当前检查目录：</p><code>{{ snapshot.comfy.path }}</code>
          <p>手动管理时选择 ComfyUI 根目录。修改工作区后需重启绘遇生效。服务地址：{{ snapshot.comfy.host }}。</p>
          <button v-if="desktop" class="btn btn-ghost btn-sm" type="button" :disabled="blocked || !!activeId || !!downloadId" @click="$emit('workspace')">选择 AI 工作区</button>
        </li>
        <li>
          <h3>工作流依赖节点</h3>
          <p>需安装并启用 KJNodes（提供 ImageSharpenKJ 节点）。</p>
          <a href="https://github.com/kijai/ComfyUI-KJNodes" target="_blank" rel="noopener noreferrer">KJNodes 仓库</a>
          <p v-if="snapshot.nodes.state === 'checked'">{{ snapshot.nodes.missing.length ? '缺少节点：' + snapshot.nodes.missing.join(' · ') : '所需节点已就绪。' }}</p>
          <p v-else>节点状态未知，启动 ComfyUI 后检查。</p>
        </li>
        <li>
          <h3>模型文件核对与下载</h3>
          <p>基础模型共 {{ formatBytes(totalBytes) }}；待下载/校验 {{ formatBytes(pendingBytes) }}。</p>
          <div v-if="models[0]?.preparation" class="preparation-links">
            <a :href="models[0].preparation.modelCardUrl" target="_blank" rel="noopener noreferrer">模型说明</a>
            <a :href="models[0].preparation.licenseUrl" target="_blank" rel="noopener noreferrer">许可协议</a>
          </div>
          <ul class="preparation-models">
            <li v-for="model in models" :key="model.id">
              <div class="model-heading"><strong>{{ model.label }}</strong><span :data-state="state(model)">{{ stateLabel(model) }}</span></div>
              <code>{{ model.path }}</code>
              <a v-if="model.preparation?.upstreamLicenseUrl" :href="model.preparation.upstreamLicenseUrl" target="_blank" rel="noopener noreferrer">组件上游许可</a>
              <p v-if="model.preparation">应为 {{ formatBytes(model.preparation.expectedBytes) }}<span v-if="model.bytes !== null">；发现 {{ formatBytes(model.bytes) }}</span></p>
              <div class="verification-actions">
                <button class="btn btn-ghost btn-sm" type="button" :disabled="blocked || !!activeId || !!downloadId || state(model) !== 'bytes-match'" @click="verify(model)">校验 SHA-256</button>
                <button v-if="activeId === model.id" class="btn btn-ghost btn-sm" type="button" @click="cancel">取消校验</button>
              </div>
              <p v-if="activeId === model.id" role="status">正在校验 {{ formatBytes(bytesRead) }} / {{ formatBytes(expectedBytes) }}（{{ Math.floor(bytesRead / expectedBytes * 100) }}%）</p>
              <p v-if="results[model.id]" :data-verification="results[model.id].state" role="status">{{ results[model.id].message }}</p>
              <p v-if="notices[model.id]" role="status">{{ notices[model.id] }}</p>
            </li>
          </ul>
          <p>校验为只读操作，一次校验一个文件，可随时取消。</p>
          <label class="preparation-ack"><input v-model="reviewed" type="checkbox">我已核对运行方式、模型目录与来源许可</label>
          <p v-if="workspacePending" role="status">工作区修改尚未生效，重启绘遇后继续。</p>
          <p v-else-if="workspaceUnconfirmed" role="status">桌面工作区未确认，请先选择工作区。</p>
          <button class="btn btn-ghost btn-sm" type="button" :disabled="!reviewed || workspaceBlocked" @click="confirmed = true">查看准备清单</button>
          <div v-if="confirmed && reviewed && !workspaceBlocked" class="download-checklist" role="region" aria-label="模型下载与校验清单">
            <p>文件下载至临时目录，校验通过后自动就位。一次处理一个文件。</p>
            <ol>
              <li v-for="model in models" :key="model.id">
                <template v-if="model.preparation">
                  <strong>{{ model.label }}</strong>
                  <div class="verification-actions">
                    <StudioProgressDownload
                      :label="model.label"
                      :size="formatBytes(model.preparation.expectedBytes)"
                      :busy="downloadId === model.id"
                      :phase-label="downloadPhaseLabel"
                      :progress="downloadPercent"
                      :complete="downloadFailed[model.id] === false && !!downloadNotices[model.id]"
                      :disabled="!!activeId || (!!downloadId && downloadId !== model.id)"
                      :retry="!!downloadFailed[model.id]"
                      @download="download(model)"
                      @cancel="cancelDownload"
                    />
                  </div>
                  <p v-if="downloadId === model.id" role="status">{{ downloadPhaseLabel }} {{ formatBytes(downloadBytes) }} / {{ formatBytes(downloadExpected) }}（{{ Math.floor(downloadBytes / downloadExpected * 100) }}%）</p>
                  <p v-if="downloadNotices[model.id]" role="status">{{ downloadNotices[model.id] }}</p>
                  <a :href="model.preparation.url" target="_blank" rel="noopener noreferrer">手动下载（{{ formatBytes(model.preparation.expectedBytes) }}）</a>
                  <p>保存到：</p><code>{{ model.path }}</code>
                  <p>SHA-256：</p><code>{{ model.preparation.sha256 }}</code>
                  <details><StudioDisclosureSummary>PowerShell 校验命令</StudioDisclosureSummary><p>运行以下只读命令比对 SHA-256：</p><code>{{ hashCommand(model.path) }}</code></details>
                </template>
              </li>
            </ol>
            <button class="btn btn-ghost btn-sm" type="button" @click="copyPlan">复制清单</button>
            <span v-if="copyNotice" role="status">{{ copyNotice }}</span>
            <p>下载完成后自动检查；手动放置文件后点击重新检查。</p>
            <button class="btn btn-ghost btn-sm" type="button" @click="$emit('refresh')">重新检查</button>
          </div>
        </li>
      </ol>
    </div>
  </details>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import StudioSelect from './ui/StudioSelect.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import StudioProgressDownload from '@/components/ui/StudioProgressDownload.vue'
import type { LocalSetupModel, LocalSetupResponse, LocalSetupVerificationResult, LocalSetupDownloadResult } from '../../types/local-setup.ts'
import { modelPreparationState as state, formatSetupBytes as formatBytes } from '../utils/localSetupPreparation.ts'
import { useLocalSetupVerification } from '../composables/useLocalSetupVerification.ts'
import { useLocalSetupDownload } from '../composables/useLocalSetupDownload.ts'
import { copyText } from '../utils/clipboard.ts'

const props = defineProps<{ snapshot: LocalSetupResponse; desktop: boolean; blocked: boolean; workspacePending?: boolean; workspaceUnconfirmed?: boolean }>()
const emit = defineEmits<{ busy: [value: boolean]; workspace: []; refresh: []; 'verification-result': [result: LocalSetupVerificationResult]; 'download-result': [result: LocalSetupDownloadResult] }>()
const route = ref(props.snapshot.comfy.layout === 'portable' ? 'portable' : props.snapshot.comfy.layout === 'venv' ? 'manual' : 'desktop')
const reviewed = ref(false), confirmed = ref(false), copyNotice = ref('')
const models = computed(() => props.snapshot.models.filter(model => model.required))
const { activeId, bytesRead, expectedBytes, results, notices, verify, cancel } = useLocalSetupVerification(models)
const workspaceBlocked = computed(() => props.blocked || props.workspacePending || props.workspaceUnconfirmed)
const downloadReady = computed(() => reviewed.value && confirmed.value && !workspaceBlocked.value && !activeId.value)
const { activeId: downloadId, bytesRead: downloadBytes, expectedBytes: downloadExpected, phase: downloadPhase,
  notices: downloadNotices, failed: downloadFailed, download, cancel: cancelDownload } = useLocalSetupDownload(
  computed(() => props.snapshot.workspace.path), downloadReady, result => emit('download-result', result))
const downloadPhaseLabel = computed(() => ({ checking: '正在核对已有文件', downloading: '正在下载', verifying: '正在验证并发布' })[downloadPhase.value] ?? '正在处理')
watch([activeId, downloadId], values => emit('busy', values.some(Boolean)), { immediate: true })
const downloadPercent = computed(() => Math.max(0, Math.min(100, Math.floor(downloadBytes.value / (downloadExpected.value || 1) * 100))))
watch(results, values => { for (const result of Object.values(values)) emit('verification-result', result) })
const matched = computed(() => models.value.filter(model => state(model) === 'bytes-match').length)
const totalBytes = computed(() => models.value.reduce((sum, model) => sum + (model.preparation?.expectedBytes ?? 0), 0))
const pendingBytes = computed(() => models.value.filter(model => state(model) !== 'bytes-match').reduce((sum, model) => sum + (model.preparation?.expectedBytes ?? 0), 0))
function stateLabel(model: LocalSetupModel): string {
  if (results.value[model.id]?.state === 'sha256-match') return 'SHA-256 相符（本次读取）'
  if (results.value[model.id]) return '完整性未通过，请核对'
  return ({ missing: '未发现', unknown: '状态未知', 'size-mismatch': '大小不符，待核对', 'bytes-match': '大小相符，未校验 SHA-256' })[state(model)]
}
function hashCommand(path: string): string { return `Get-FileHash -LiteralPath '${path.replaceAll("'", "''")}' -Algorithm SHA256` }
const planIdentity = computed(() => JSON.stringify([route.value, props.snapshot.workspace.path,
  props.snapshot.comfy.path, props.snapshot.comfy.host, props.snapshot.comfy.layout,
  models.value.map(model => [model.id, model.path, model.preparation?.url, model.preparation?.revision,
    model.preparation?.expectedBytes, model.preparation?.sha256, model.preparation?.modelCardUrl,
    model.preparation?.licenseUrl, model.preparation?.upstreamLicenseUrl])]))
// Completion refreshes file status; consent remains valid for the same paths, sources and licenses.
watch(planIdentity, () => {
  reviewed.value = false; confirmed.value = false; copyNotice.value = ''
})
watch(reviewed, () => { confirmed.value = false; copyNotice.value = '' })
watch(workspaceBlocked, () => { reviewed.value = false; confirmed.value = false })
async function copyPlan() {
  const plan = ['绘遇手动准备清单（不自动安装或接受许可）', `运行方式：${route.value}`, `工作区：${props.snapshot.workspace.path}`, `ComfyUI：${props.snapshot.comfy.path}`, `服务地址：${props.snapshot.comfy.host}`, '确认此实例实际读取同一 models 目录；需要当前 ComfyUI 环境与 KJNodes。', ...models.value.map(model => `${model.label}\n保存到：${model.path}\n字节：${model.preparation?.expectedBytes}\n来源：${model.preparation?.url}\n许可与上游说明：${model.preparation?.licenseUrl}\n${model.preparation?.modelCardUrl}\n组件上游许可：${model.preparation?.upstreamLicenseUrl ?? '见作者许可'}\nSHA-256：${model.preparation?.sha256}\n只读校验：${hashCommand(model.path)}`), '放置并核对 SHA-256 后重启 ComfyUI、重新检查，再真实出图；文件或节点检查不等于出图通过。'].join('\n\n')
  copyNotice.value = await copyText(plan) ? '清单已复制' : '复制失败，请手动选中清单文字'
}
</script>

<style scoped>
.preparation { margin-top:var(--s-4); border:1px solid var(--border-soft); border-radius:var(--r-md); padding:var(--s-3); background:var(--bg-deep); overflow-wrap:anywhere; }
.preparation summary { cursor:pointer; font-size:var(--fs-label); }
.preparation summary > span { color:var(--text-secondary); margin-left:var(--s-3); }
.preparation-body, .preparation p { color:var(--text-secondary); font-size:var(--fs-label); line-height:var(--lh-body); }
.preparation p { margin:var(--s-2) 0; }
.preparation h3 { color:var(--text-primary); font-size:var(--fs-label); margin:0; }
.preparation code { display:block; overflow-wrap:anywhere; color:var(--text-secondary); font-size:var(--fs-label-xs); }
.preparation a { color:var(--accent); text-underline-offset:3px; }
.route-label { display:block; color:var(--text-primary); margin:var(--s-3) 0 var(--s-2); }
.route-select { width:100%; }
.preparation-steps { padding-left:var(--s-5); display:grid; gap:var(--s-4); margin:var(--s-4) 0 0; }
.verification-actions, .preparation-links, .model-heading { display:flex; flex-wrap:wrap; gap:var(--s-2) var(--s-3); }
.preparation-models { display:grid; gap:var(--s-3); list-style:none; padding:0; margin:var(--s-3) 0; }
.model-heading strong { color:var(--text-primary); }
.model-heading span[data-state="size-mismatch"] { color:var(--warning-text); }
.preparation-ack { display:flex; align-items:flex-start; gap:var(--s-2); margin:var(--s-3) 0; color:var(--text-primary); cursor:pointer; }
.preparation-ack input { margin-top:4px; flex-shrink:0; }
.download-checklist { margin-top:var(--s-3); padding-top:var(--s-3); border-top:1px solid var(--border-soft); }
.download-checklist ol { display:grid; gap:var(--s-4); padding-left:var(--s-5); }
.download-checklist li > a { display:block; margin:var(--s-2) 0; }
.download-checklist details { margin:var(--s-2) 0; }
.preparation p[data-verification="sha256-match"] { color:var(--success-text); }
.preparation p[data-verification="hash-mismatch"], .preparation p[data-verification="changed"] { color:var(--warning-text); }
.preparation button:disabled { color:var(--text-disabled); opacity:1; cursor:not-allowed; }
.preparation :is(a, button, summary, select, input):focus-visible { outline:none; box-shadow:var(--focus-shadow); }
</style>

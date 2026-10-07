<template>
  <details class="preparation">
    <StudioDisclosureSummary>手动管理已有环境与逐项下载<span>{{ models.length - matched }} 项文件待核对</span></StudioDisclosureSummary>
    <div data-disclosure-content class="preparation-body">
      <p>先核对运行方式、真实目录与来源，再显式下载固定模型文件。绘遇不会在这里安装程序、执行脚本或代你接受许可。</p>
      <label class="route-label" for="setup-comfy-route">ComfyUI 的运行方式</label>
      <StudioSelect id="setup-comfy-route" v-model="route" class="route-select" label="ComfyUI 的运行方式" :options="[
        { value: 'desktop', label: '已有官方 Desktop（由原入口启动）' },
        { value: 'portable', label: 'Windows Portable（由便携包启动）' },
        { value: 'manual', label: '已有源码 / Python 环境' },
      ]" />
      <ol v-content-motion:fade="route" class="preparation-steps">
        <li>
          <h3>准备对应硬件的运行环境</h3>
          <template v-if="route === 'desktop'">
            <p>从官方 Desktop 安装页取得程序，按安装器建立一个 ComfyUI 实例。先在 Desktop 中启动它，确认可打开 ComfyUI；在该实例设置中查看实际安装目录与模型目录。</p>
            <p>Desktop 的 Python 环境由其自身管理，布局因版本与实例类型而异。请继续由 Desktop 启动和更新；这里不接管它的解释器。</p>
            <a href="https://docs.comfy.org/installation/desktop/windows" target="_blank" rel="noopener noreferrer">打开官方 Desktop 安装页</a>
          </template>
          <template v-else-if="route === 'portable'">
            <p>从官方页面选择适合自己显卡的 Windows 便携包并解压。打开同时包含 ComfyUI、python_embeded 和启动批处理的目录，使用包内适合硬件的启动入口；CPU 入口通常较慢。</p>
            <p>保留 python_embeded 原名。绘遇受管启动可以使用这份独立 Python。</p>
            <a href="https://docs.comfy.org/installation/comfyui_portable_windows" target="_blank" rel="noopener noreferrer">打开官方 Portable 准备页</a>
          </template>
          <template v-else>
            <p>保留已有环境，按 ComfyUI 官方说明核对 Python、对应硬件的 PyTorch、驱动和 requirements.txt。官方手动教程包含 Conda 路线，并非任何手动安装都可交给绘遇启动。</p>
            <p>Windows 受控启动只识别 ComfyUI/main.py 与 ComfyUI/venv/Scripts/python.exe。发现这两个文件仍不代表依赖可用；其他布局沿用原启动入口，不要重命名 .venv 或复制解释器来通过检查。</p>
            <a href="https://docs.comfy.org/installation/manual_install" target="_blank" rel="noopener noreferrer">打开官方手动安装说明</a>
          </template>
          <p>硬件兼容性未确认；GPU / 内存上报不等于此模型可运行。每次下载会检查目标盘可用空间；驱动、Python 环境和真实出图仍需另行准备与验证。</p>
          <a href="https://docs.comfy.org/installation/system_requirements" target="_blank" rel="noopener noreferrer">核对官方系统与硬件要求</a>
        </li>
        <li>
          <h3>让绘遇和 ComfyUI 读取同一批文件</h3>
          <p>当前绘遇检查的目录：</p><code>{{ snapshot.comfy.path }}</code>
          <p>手动管理已有 ComfyUI 时，工作区选择其父目录；绘遇一键准备的环境无需修改目录。Desktop 要对照实际实例，不能只选择安装器所在目录。</p>
          <p>下方精确路径只有在该 ComfyUI 实例实际读取同一 models 目录时才成立。若使用共享模型目录、extra_model_paths.yaml 或其他实例，请先统一对应关系；只修改服务地址不会改变绘遇的文件检查目录。</p>
          <button v-if="desktop" class="btn btn-ghost btn-sm" type="button" @click="$emit('workspace')">选择 AI 工作区</button>
          <p>更换工作区后完全退出并重启绘遇，再查看新目录清单。手动启动 ComfyUI 后，在控制室核对实际本机地址（当前 {{ snapshot.comfy.host }}），不要同时启动第二个实例。</p>
        </li>
        <li>
          <h3>补齐这条基础工作流的依赖</h3>
          <p>先使用所选环境的正常方式安装并启用 KJNodes，保留其 requirements 依赖。它提供本流程的 ImageSharpenKJ；不要把其他 Python 环境里的安装当作当前实例已经就绪。</p>
          <a href="https://github.com/kijai/ComfyUI-KJNodes" target="_blank" rel="noopener noreferrer">查看 KJNodes 作者安装说明</a>
          <p v-if="snapshot.nodes.state === 'checked'">{{ snapshot.nodes.missing.length ? '本次缺少：' + snapshot.nodes.missing.join(' · ') : '本次所需节点已注册；仍未执行工作流。' }}</p>
          <p v-else>当前节点状态未知，启动正确实例后再检查。除 ImageSharpenKJ 外的基础节点缺失时，应检查 ComfyUI 版本和加载错误，不随意安装同名扩展。</p>
          <p>准备完成后重启 ComfyUI，再回到这里重新检查；起步不需要 LoRA、TeaCache、SageAttention、高清修复或局部重绘扩展。</p>
        </li>
        <li>
          <h3>核对模型来源与目标位置</h3>
          <p>固定版本三件套共 {{ formatBytes(totalBytes) }}（{{ totalBytes.toLocaleString('zh-CN') }} 字节）；当前大小不符、缺失或未知的文件合计 {{ formatBytes(pendingBytes) }}。大小相符的文件也尚未校验 SHA-256。</p>
          <p>文件由 CircleStone Labs 的 Anima 仓库提供。作者许可含用途限制，编码器与 VAE 还应核对模型卡中的上游说明；许可链接供你审阅，这个向导不代为接受。</p>
          <div v-if="models[0]?.preparation" class="preparation-links">
            <a :href="models[0].preparation.modelCardUrl" target="_blank" rel="noopener noreferrer">作者模型卡与上游说明</a>
            <a :href="models[0].preparation.licenseUrl" target="_blank" rel="noopener noreferrer">此固定版本的许可</a>
          </div>
          <ul class="preparation-models">
            <li v-for="model in models" :key="model.id">
              <div class="model-heading"><strong>{{ model.label }}</strong><span :data-state="state(model)">{{ stateLabel(model) }}</span></div>
              <code>{{ model.path }}</code>
              <a v-if="model.preparation?.upstreamLicenseUrl" :href="model.preparation.upstreamLicenseUrl" target="_blank" rel="noopener noreferrer">组件上游许可</a>
              <p v-if="model.preparation">应为 {{ formatBytes(model.preparation.expectedBytes) }} · {{ model.preparation.expectedBytes.toLocaleString('zh-CN') }} 字节<span v-if="model.bytes !== null">；本次发现 {{ model.bytes.toLocaleString('zh-CN') }} 字节</span></p>
              <div class="verification-actions">
                <button class="btn btn-ghost btn-sm" type="button" :disabled="!!activeId || !!downloadId || state(model) !== 'bytes-match'" @click="verify(model)">校验 {{ model.label }} 的 SHA-256</button>
                <button v-if="activeId === model.id" class="btn btn-ghost btn-sm" type="button" @click="cancel">取消校验</button>
              </div>
              <p v-if="activeId === model.id" role="status">正在只读校验 {{ formatBytes(bytesRead) }} / {{ formatBytes(expectedBytes) }}（{{ Math.floor(bytesRead / expectedBytes * 100) }}%）</p>
              <p v-if="results[model.id]" :data-verification="results[model.id].state" role="status">{{ results[model.id].message }}</p>
              <p v-if="notices[model.id]" role="status">{{ notices[model.id] }}</p>
            </li>
          </ul>
          <p>SHA-256 只在点击时逐块读取本机文件，不联网、不改写。一次校验一个文件，可随时取消；重新检查或离开本页会停止校验并清除本次结果。成功只证明本次读取与固定摘要一致，不代表出图或未来文件仍未改变。</p>
          <label class="preparation-ack"><input v-model="reviewed" type="checkbox">我已核对运行方式、真实 models 目录、容量与来源许可说明</label>
          <p v-if="workspacePending" role="status">已保存的工作区尚未生效。完全退出并重启绘遇后重新检查、核对目录，再下载。</p>
          <p v-else-if="workspaceUnconfirmed" role="status">当前桌面工作区尚未确认。请重新检查或选择 AI 工作区核对目录，再下载。</p>
          <button class="btn btn-ghost btn-sm" type="button" :disabled="!reviewed || workspaceBlocked" @click="confirmed = true">查看准备清单</button>
          <div v-if="confirmed && reviewed && !workspaceBlocked" class="download-checklist" role="region" aria-label="模型下载与校验清单">
            <p>点击下载后，文件写入当前确认工作区的临时文件，大小与 SHA-256 全部匹配后才发布。同名不同内容会报告冲突；取消或失败保留已有模型。一次仅下载或校验一个文件。</p>
            <ol>
              <li v-for="model in models" :key="model.id">
                <template v-if="model.preparation">
                  <strong>{{ model.label }}</strong>
                  <div class="verification-actions">
                    <button class="btn btn-ghost btn-sm" type="button" :disabled="!!activeId || !!downloadId" @click="download(model)">{{ downloadFailed[model.id] ? '重试下载' : '下载' }} {{ model.label }}（{{ formatBytes(model.preparation.expectedBytes) }}）</button>
                    <button v-if="downloadId === model.id" class="btn btn-ghost btn-sm" type="button" @click="cancelDownload">取消下载</button>
                  </div>
                  <p v-if="downloadId === model.id" role="status">{{ downloadPhaseLabel }} {{ formatBytes(downloadBytes) }} / {{ formatBytes(downloadExpected) }}（{{ Math.floor(downloadBytes / downloadExpected * 100) }}%）</p>
                  <p v-if="downloadNotices[model.id]" role="status">{{ downloadNotices[model.id] }}</p>
                  <a :href="model.preparation.url" target="_blank" rel="noopener noreferrer">取得固定版本文件（{{ formatBytes(model.preparation.expectedBytes) }}）</a>
                  <p>保存到：</p><code>{{ model.path }}</code>
                  <p>SHA-256：</p><code>{{ model.preparation.sha256 }}</code>
                  <details><StudioDisclosureSummary>Windows 只读校验方法</StudioDisclosureSummary><p>文件放置完成后，在 PowerShell 执行下面的只读命令，逐字对比 Hash 与上面的 SHA-256。大文件读取可能需要等待；本页不会把手动核对自动标记为通过。</p><code>{{ hashCommand(model.path) }}</code></details>
                </template>
              </li>
            </ol>
            <button class="btn btn-ghost btn-sm" type="button" @click="copyPlan">复制这份准备清单</button>
            <span v-if="copyNotice" role="status">{{ copyNotice }}</span>
            <p>下载成功后自动重新检查；手动放置时用下方按钮重新检查。确认文件后启动正确的 ComfyUI 实例，再真实生成一张图片。下载成功不等于已能出图。</p>
            <button class="btn btn-ghost btn-sm" type="button" @click="$emit('refresh')">放置后重新检查</button>
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
import type { LocalSetupModel, LocalSetupResponse, LocalSetupVerificationResult, LocalSetupDownloadResult } from '../../types/local-setup.ts'
import { modelPreparationState as state, formatSetupBytes as formatBytes } from '../utils/localSetupPreparation.ts'
import { useLocalSetupVerification } from '../composables/useLocalSetupVerification.ts'
import { useLocalSetupDownload } from '../composables/useLocalSetupDownload.ts'
import { copyText } from '../utils/clipboard.ts'

const props = defineProps<{ snapshot: LocalSetupResponse; desktop: boolean; workspacePending?: boolean; workspaceUnconfirmed?: boolean }>()
const emit = defineEmits<{ workspace: []; refresh: []; 'verification-result': [result: LocalSetupVerificationResult]; 'download-result': [result: LocalSetupDownloadResult] }>()
const route = ref(props.snapshot.comfy.layout === 'portable' ? 'portable' : props.snapshot.comfy.layout === 'venv' ? 'manual' : 'desktop')
const reviewed = ref(false), confirmed = ref(false), copyNotice = ref('')
const models = computed(() => props.snapshot.models.filter(model => model.required))
const { activeId, bytesRead, expectedBytes, results, notices, verify, cancel } = useLocalSetupVerification(models)
const workspaceBlocked = computed(() => props.workspacePending || props.workspaceUnconfirmed)
const downloadReady = computed(() => reviewed.value && confirmed.value && !workspaceBlocked.value && !activeId.value)
const { activeId: downloadId, bytesRead: downloadBytes, expectedBytes: downloadExpected, phase: downloadPhase,
  notices: downloadNotices, failed: downloadFailed, download, cancel: cancelDownload } = useLocalSetupDownload(
  computed(() => props.snapshot.workspace.path), downloadReady, result => emit('download-result', result))
const downloadPhaseLabel = computed(() => ({ checking: '正在核对已有文件', downloading: '正在下载', verifying: '正在验证并发布' })[downloadPhase.value] ?? '正在处理')
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
watch([() => props.snapshot, planIdentity], ([, plan], [, previous]) => {
  if (downloadId.value && plan === previous) return
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
.preparation :is(a, button, summary, select, input):focus-visible { outline:2px solid var(--text-primary); outline-offset:3px; }
</style>

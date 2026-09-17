<template>
  <div class="control-page">
    <RouteAtmosphere />
    <!-- /control 挂在 AppLayout 之外，所以跳转链接与 main 地标要在这里自备 -->
    <a class="skip-link" href="#control-main">跳到主要内容</a>
    <nav class="nav control-mobile-nav">
      <div class="nav-inner nav-local">
        <RouterLink to="/" class="nav-local-brand">
          <BrandLogo class="nav-logo" />
          <span><strong>本机控制室</strong><small>Local control room</small></span>
        </RouterLink>
        <div class="nav-local-actions">
          <AppearanceButton />
          <TaskCenterButton />
          <RouterLink class="nav-local-home" to="/">← 回绘遇</RouterLink>
          <AppThemeToggle /><AppSoundToggle />
        </div>
      </div>
    </nav>

    <div class="control-layout">
      <aside class="control-rail" aria-label="控制室导航">
        <RouterLink to="/" class="control-rail-brand">
          <BrandLogo class="nav-logo" />
          <span><strong>本机控制室</strong><small>Local control room</small></span>
        </RouterLink>
        <TaskCenterButton />
        <span class="control-nav-label">工作台管理</span>
        <AppearancePreferences launcher-only />
        <nav class="control-rail-nav" aria-label="控制区">
          <a v-for="item in sections" :key="item.id" class="control-rail-link" :href="'#' + item.id"
            :aria-current="activeSection === item.id ? 'location' : undefined" @click="openSection(item.id)">
            <ArchiveIcon :name="item.icon" /><span>{{ item.label }}</span>
          </a>
        </nav>
        <div class="control-rail-note"><ArchiveIcon name="coffee" /><p>让工具准备好，<br />把时间留给创作。</p></div>
        <div class="control-rail-foot">
          <RouterLink class="nav-local-home" to="/">← 回绘遇</RouterLink>
          <AppThemeToggle /><AppSoundToggle />
        </div>
      </aside>

      <div class="control-content">
    <main id="control-main" class="control-shell" tabindex="-1">
      <ControlIntro :ready-label="readyLabel">
        <template #actions>
          <button class="btn btn-ghost" type="button" :disabled="serviceChecking || opBusy" @click="pollStatus(true)">
            <ArchiveIcon name="refresh" :class="{ spin: serviceChecking }" /> {{ serviceChecking ? '检测中…' : '检测所有服务' }}
          </button>
          <RouterLink class="btn btn-primary" to="/prompt-builder"><ArchiveIcon name="spark" /> 回到创作</RouterLink>
        </template>
      </ControlIntro>

      <section id="control-overview" class="control-overview" aria-label="连接状态">
        <div class="overview-heading"><div><span class="panel-kicker">运行概览</span><h2>{{ feedbackText }}</h2><p>{{ actionNote || '正在读取本机服务状态。' }}</p></div><span class="overview-local"><ArchiveIcon name="eye" /> 本机工作台</span></div>
        <div v-if="statusError" class="control-alert" role="alert"><ArchiveIcon name="warning" /><span>{{ statusError }}，服务状态待确认，请重新检测。</span><button class="btn btn-ghost btn-sm" @click="pollStatus(true)">重试检测</button></div>
        <div class="status-wall">
          <a v-for="service in serviceCards" :key="service.name" class="status-tile" href="#control-resources" :data-state="!statusUsable ? 'checking' : service.online ? 'on' : 'off'" @click="openSection('control-resources')">
            <span class="status-tile-head"><ArchiveIcon :name="service.icon" /><small>{{ service.name }}</small><span class="status-dot"></span></span>
            <strong>{{ !statusUsable ? (statusError ? '待检测' : '检测中…') : service.online ? '已连接' : '未连接' }}</strong>
            <span class="status-tile-detail">{{ service.detail }}</span>
          </a>
        </div>
      </section>

      <!-- 操作进度 -->
      <div v-if="operation" class="panel-card operation-panel" :class="operation.status">
        <div class="operation-head">
          <div>
            <div class="panel-kicker">In progress</div>
            <strong class="panel-heading">{{ operation.label }}</strong>
          </div>
          <span class="op-state">{{ opStatusLabel }}</span>
        </div>
        <div class="meter"><span class="meter-fill" :style="{ '--fill': opProgress + '%' }"></span></div>
        <p class="operation-msg">{{ operation.message }}</p>
        <div v-if="operation.stages?.length" class="operation-stages">
          <span
            v-for="(stage, i) in operation.stages" :key="stage"
            class="op-stage"
            :class="{ done: i < operation.stageIndex, current: i === operation.stageIndex && operation.status === 'running' }"
          >{{ stage }}</span>
        </div>
      </div>

      <!-- 显存调度 -->
      <section id="control-resources" class="panel-card resource-panel">
        <div class="panel-kicker">01 / 常用操作</div>
        <h2 class="panel-heading">服务与显存调度</h2>
        <p class="panel-desc">绘图、语音、聊天同时加载容易占满显存。按需切换：先释放，再加载。</p>
        <div class="mode-grid">
          <button class="mode-card" type="button" :disabled="!statusUsable || opBusy || modeBusy" @click="switchMode('draw')">
            <span class="mode-title"><ArchiveIcon name="spark" /> 绘图优先<span class="mode-arrow">→</span></span>
            <span class="mode-desc">停止语音、卸载 Ollama，把显存让给 WebUI 出图。</span>
          </button>
          <button class="mode-card" type="button" :disabled="!statusUsable || opBusy || modeBusy" @click="switchMode('chat')">
            <span class="mode-title"><ArchiveIcon name="coffee" /> 聊天优先<span class="mode-arrow">→</span></span>            <span class="mode-desc">停止受管 WebUI，启动语音，专注角色房间。</span>
          </button>
        </div>

        <div class="service-rows">
          <div class="service-row">
            <span class="service-row-name">
              <span class="dot" :class="{ on: sdOnline }"></span>
              SD WebUI 绘图
              <span class="service-row-meta">{{ sdOnline ? (webuiManaged ? '受控' : '手动') : '未运行' }}</span>
            </span>
            <span class="service-row-actions">
              <button class="btn btn-ghost btn-sm" type="button" :disabled="!statusUsable || opBusy || sdOnline" :title="sdOnline ? '已在运行' : '启动受控 WebUI'" @click="serviceAction('webui','start')">启动</button>
              <button class="btn btn-danger btn-sm" type="button" :disabled="!statusUsable || opBusy || !sdOnline" :title="!sdOnline ? '未在运行' : '停止服务'" @click="confirmServiceAction('webui','stop')">停止</button>
            </span>
          </div>
          <div class="service-row">
            <span class="service-row-name">
              <span class="dot" :class="{ on: comfyOnline }"></span>
              ComfyUI 绘图服务
              <span class="service-row-meta">{{ comfyOnline ? (comfyManaged ? '受控' : '手动') : '未运行' }}</span>
            </span>
            <span class="service-row-actions">
              <button class="btn btn-ghost btn-sm" type="button" :disabled="!statusUsable || opBusy || comfyOnline" :title="comfyOnline ? '已在运行，无需重复启动' : '启动受控 ComfyUI'" @click="serviceAction('comfy','start')">启动</button>
              <button class="btn btn-danger btn-sm" type="button" :disabled="!statusUsable || opBusy || !comfyOnline" :title="!comfyOnline ? '未在运行' : '停止服务'" @click="confirmServiceAction('comfy','stop')">停止</button>
            </span>
          </div>
          <div class="service-row">
            <span class="service-row-name">
              <span class="dot" :class="{ on: ttsOnline }"></span>
              GPT-SoVITS 语音
              <span class="service-row-meta">{{ ttsOnline ? '在线' : '未运行' }}</span>
            </span>
            <span class="service-row-actions">
              <button class="btn btn-ghost btn-sm" type="button" :disabled="!statusUsable || opBusy || ttsOnline" :title="ttsOnline ? '已在运行' : '启动语音'" @click="serviceAction('voice','start')">启动</button>
              <button class="btn btn-danger btn-sm" type="button" :disabled="!statusUsable || opBusy || !ttsOnline" :title="!ttsOnline ? '未在运行' : '停止服务'" @click="confirmServiceAction('voice','stop')">停止</button>
            </span>
          </div>
          <div class="service-row">
            <span class="service-row-name">
              <span class="dot" :class="{ on: ollamaOnline }"></span>
              Ollama 聊天模型
              <span class="service-row-meta" :title="ollamaMeta">{{ ollamaMeta }}</span>
            </span>
            <span class="service-row-actions">
              <button class="btn btn-danger btn-sm" type="button" :disabled="!statusUsable || opBusy || !ollamaModels.length" @click="serviceAction('ollama','unload')">卸载模型释放显存</button>
            </span>
          </div>
        </div>

        <ToggleSwitch v-model="autoStartVoice" class="autostart-row" @change="saveAutoStartVoice">
          <span>打开控制面板时自动启动语音（显存紧张时不建议开启）</span>
        </ToggleSwitch>
        <p class="panel-foot">Ollama 闲置约 10 分钟会自动卸载；系统声音试听不依赖 GPT-SoVITS。</p>
        <p v-if="!scripts.webui || !scripts.comfy || !scripts.voiceStart" class="script-hint">
          未检测到部分快捷启停脚本（仅影响一键启动，若服务已手动运行仍可正常连接）：
          <span v-if="!scripts.webui">WebUI 脚本 </span>
          <span v-if="!scripts.comfy">ComfyUI 脚本 </span>
          <span v-if="!scripts.voiceStart">语音启动脚本 </span>
          <span v-if="!scripts.voiceStop">语音停止脚本 </span>
        </p>
      </section>

      <div class="control-work-grid">
      <!-- 本机生成服务配置 -->
      <ResourceLibraryPanel />
      <section id="control-services" class="panel-card service-config-panel">
        <div class="panel-kicker">02 / 连接设置</div>
        <h2 class="panel-heading">服务地址与声线</h2>
        <p class="panel-desc">设置绘图引擎与语音服务的本机地址。修改后统一保存并检测。</p>

        <label class="field-label" for="sd-host">Stability Matrix / SD WebUI 地址</label>
        <div class="field-row">
          <input id="sd-host" v-model="sdHost" class="input input-mono" type="text" :title="sdHost" placeholder="http://127.0.0.1:7860" spellcheck="false" @keydown.enter="saveConfig" />
        </div>
        <p class="field-help">端口以启动日志为准；推荐参数：<code>--api --port 7860</code></p>

        <label class="field-label" for="comfy-host">ComfyUI 地址</label>
        <div class="field-row">
          <input id="comfy-host" v-model="comfyHost" class="input input-mono" type="text" :title="comfyHost" placeholder="http://127.0.0.1:8188" spellcheck="false" @keydown.enter="saveConfig" />
        </div>
        <p class="field-help">用于 Anima、Krea 与视频生成，请填写本机 HTTP 地址。</p>

        <label class="field-label" for="tts-host">GPT-SoVITS API 地址</label>
        <div class="field-row">
          <input id="tts-host" v-model="ttsHost" class="input input-mono" type="text" :title="ttsHost" placeholder="http://127.0.0.1:9880" spellcheck="false" @keydown.enter="saveConfig" />
        </div>
        <p class="field-help">默认按需启动；默认端口为 <code>9880</code>。</p>

        <details class="voice-config">
          <summary><ArchiveIcon name="sound" /> 角色声线配置 <span class="voice-count">{{ voiceConfiguredCount }} / 2 已配置</span></summary>
          <div class="voice-grid">
            <div class="voice-card">
              <div class="voice-card-title">宁宁</div>
              <label class="sr-only" for="v-nene-ref">宁宁参考音频路径</label>
            <input id="v-nene-ref" v-model="voiceNeneRef" class="input" placeholder="参考音频路径" />
              <label class="sr-only" for="v-nene-prompt">宁宁提示文本（日文）</label>
            <input id="v-nene-prompt" v-model="voiceNenePrompt" class="input" placeholder="提示文本（日文）" />
            </div>
            <div class="voice-card">
              <div class="voice-card-title">夏目</div>
              <label class="sr-only" for="v-nat-ref">夏目参考音频路径</label>
            <input id="v-nat-ref" v-model="voiceNatsumeRef" class="input" placeholder="参考音频路径" />
              <label class="sr-only" for="v-nat-prompt">夏目提示文本（日文）</label>
            <input id="v-nat-prompt" v-model="voiceNatsumePrompt" class="input" placeholder="提示文本（日文）" />
            </div>
          </div>
        </details>
        <div class="config-save-row"><p>地址与声线一起保存，自动检测不会覆盖未保存的输入。</p><button class="btn btn-primary" type="button" :disabled="savingConfig || !statusLoaded" @click="saveConfig">{{ savingConfig ? '正在保存…' : '保存全部并检测' }}</button></div>
      </section>

      <!-- 公网分享 -->
      <section id="control-share" class="panel-card share-panel">
        <div class="panel-kicker">03 / 分享与访问</div>
        <h2 class="panel-heading">邀请朋友来画室</h2>
        <p class="panel-desc">本机访问不需要 Token；公网分享会使用临时 Token。</p>

        <div class="tunnel-toggle-row">
          <div class="tunnel-toggle-label">
            <span id="tunnel-switch-label" class="tunnel-toggle-text">开启公网分享通道</span>
            <span class="tunnel-toggle-hint">{{ tunnelEnabled ? '朋友可通过临时链接访问' : '关闭后仅本机可访问' }}</span>
          </div>
          <button
            class="tunnel-switch" type="button" role="switch"
            :aria-checked="tunnelEnabled ? 'true' : 'false'"
        aria-labelledby="tunnel-switch-label"
            @click="toggleTunnel"
          ><span class="tunnel-switch-knob"></span></button>
        </div>

        <button
          class="btn btn-lg btn-primary"
          type="button"
          :disabled="actionBusy || opBusy"
          @click="tunnelActive ? doStop() : doStart()"
        >{{ mainBtnLabel }}</button>
        <p class="action-note">{{ tunnelActive ? '分享通道运行中；停止只关公网，不影响本机绘图与聊天。' : '启动后生成本地与分享入口。' }}</p>

        <div class="access-grid">
          <div class="access-card">
            <div class="access-kicker">Local</div>
            <div class="access-title">本机地址</div>
            <div class="link-value">{{ localLink }}</div>
            <div class="inline-actions">
              <button class="btn btn-ghost btn-sm" type="button" @click="copy(localLink)">复制</button>
              <a class="btn btn-ghost btn-sm" :href="localLink" target="_blank" rel="noreferrer">打开</a>
            </div>
          </div>
          <div class="access-card">
            <div class="access-kicker">Share</div>
            <div class="access-title">分享链接</div>
            <div class="link-value" :class="{ waiting: !shareLink }">{{ shareLink || (tunnelStatus === 'disabled' ? '未生成公网链接' : '等待分享链接…') }}</div>
            <div class="inline-actions">
              <button class="btn btn-ghost btn-sm" type="button" :disabled="!shareLink" @click="copy(shareLink)">复制</button>
            </div>
          </div>
        </div>
        <div class="uptime">{{ uptime }}</div>
        <p class="security-note">分享链接可以调用你电脑上的 SD WebUI，请只发给信任的人。</p>

        <!-- 前端构建：分享伺服 dist/，源码改动后需重建 -->
        <div class="build-card" :data-stale="webBuildStale ? 'true' : 'false'">
          <div class="build-head">
            <span class="build-kicker">Web build</span>
            <strong>{{ buildLabel }}</strong>
          </div>
          <p class="build-desc">{{ buildDesc }}</p>
          <button class="btn btn-ghost btn-sm" type="button" :disabled="buildingWeb || opBusy" @click="buildWeb">
            {{ buildingWeb ? '构建中…' : (webBuildStale ? '重新构建前端' : '重新构建前端') }}
          </button>
        </div>
      </section>

      </div>
      <DesktopPreferences />

      <!-- 日志 -->
      <details id="control-logs" class="log-panel">
        <summary>
          <span class="log-summary-title"><ArchiveIcon name="book" /> 运行日志</span>
          <span class="summary-side">
            <button class="btn btn-ghost btn-sm" type="button" :disabled="exportingDiag" title="仅保存版本与运行状态，不包含密钥、聊天正文或图片" @click.stop="exportDiag">{{ exportingDiag ? '正在整理…' : '导出诊断包' }}</button>
            <button class="btn btn-ghost btn-sm" type="button" @click.stop="clearLogs">清空显示</button>
            <span class="chevron">›</span>
          </span>
        </summary>
        <div class="log-wrap">
          <div class="log-box" ref="logBoxEl">
            <div v-if="!logs.length" class="log-empty">暂无日志。</div>
            <div v-for="(line, i) in logs" :key="i" :class="lineClass(line)">
              <span class="time">{{ line.slice(0, 10) }}</span> {{ line.slice(11) }}
            </div>
          </div>
        </div>
      </details>
    </main>
      </div>
    </div>

  </div>
</template>

<script setup lang="ts">
import AppearancePreferences from '@/components/AppearancePreferences.vue'
import AppearanceButton from '@/components/AppearanceButton.vue'
import BrandLogo from '@/components/BrandLogo.vue'
import TaskCenterButton from '@/components/tasks/TaskCenterButton.vue'
import { computed, onMounted, onUnmounted } from 'vue'
import ArchiveIcon, { type ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
import AppSoundToggle from '@/components/AppSoundToggle.vue'
import AppThemeToggle from '@/components/AppThemeToggle.vue'
import DesktopPreferences from '@/components/DesktopPreferences.vue'
import ControlIntro from '@/components/ControlIntro.vue'
import ResourceLibraryPanel from '@/components/ResourceLibraryPanel.vue'
import RouteAtmosphere from '@/components/visual/RouteAtmosphere.vue'
import { useControlNavigation } from '@/composables/useControlNavigation'
import { useToast } from '@/composables/useToast'
// 桌面端更新横幅已收敛到全局 DesktopUpdateBanner（2026-08-31，任何页面可见）。
// /api/status 与 /api/logs 的契约类型。原先整体当 any —— 字段拼错、后端改名
// 都要等运行时才炸，而这个视图正好在破坏性路径上（改上游 host、启停服务、
// 开关公网隧道）。
import { useControlStatus } from '@/composables/useControlStatus'
import { confirmAction } from '@/composables/useConfirm'
import { useControlActions } from '@/composables/useControlActions'

/**
 * 全站唯一那套 toast（App.vue 里的 AppToast + useToast）。
 * 这里原先自建了第四套：一个 .toast div + 自管计时器，
 * 既没有 live region 也没有可聚焦的关闭动作。
 */
const toastApi = useToast()
function showToast(msg: string, isError = false) {
  if (isError) toastApi.error(msg)
  else toastApi.info(msg)
}

const status = useControlStatus({ showToast })
const actions = useControlActions(status, { showToast })

// 模板引用解构：状态域
const {
  tunnelActive, sdOnline, comfyOnline, ttsOnline, ollamaOnline, webuiManaged, comfyManaged, ollamaModels, ollamaVram,
  modeBusy, operation, selfHealing, serviceChecking, statusLoaded, statusError, scripts,
  sdHost, comfyHost, ttsHost, voiceNeneRef, voiceNenePrompt, voiceNatsumeRef, voiceNatsumePrompt, autoStartVoice,
  tunnelStatus, shareLink, localLink, uptime, actionBusy, mainBtnLabel, webBuild,
  feedbackText, actionNote, logs, logBoxEl,
  opBusy, opStatusLabel, opProgress, ollamaBadgeText, ollamaMeta, voiceConfiguredCount,
  readyLabel,
  pollStatus, clearLogs,
} = status

// 模板引用解构：操作域
const {
  tunnelEnabled, copy, toggleTunnel, saveConfig, savingConfig, saveAutoStartVoice,
  serviceAction, switchMode, doStart, doStop, exportDiag, exportingDiag, buildWeb, buildingWeb,
} = actions

const webBuildStale = computed(() => !!webBuild.value && webBuild.value.stale && webBuild.value.distReady)
const ttsSelfHealing = computed(() => {
  const service = selfHealing.value?.services?.tts
  return Boolean(service && (service.restarting || service.attempt > 0))
})
const buildLabel = computed(() => {
  if (!webBuild.value) return '构建状态未知'
  if (!webBuild.value.distReady) return '尚未构建'
  if (webBuild.value.stale) return '构建已过期'
  return '构建已是最新'
})
const buildDesc = computed(() => {
  if (!webBuild.value || !webBuild.value.distReady) return '公网分享伺服的是构建产物；尚未构建时分享可能无法显示最新页面。'
  const built = webBuild.value.builtAt ? '于 ' + new Date(webBuild.value.builtAt).toLocaleString('zh-CN') + ' 构建' : ''
  if (webBuild.value.stale) return built + '，但源码此后有修改——分享出去的是旧版页面，请重新构建。'
  return built + '，与当前源码一致。'
})

function lineClass(line: string) { return status.lineClass(line) }

const SERVICE_STOP_LABELS: Record<string, string> = {
  webui: 'SD WebUI 绘图服务',
  comfy: 'ComfyUI 绘图服务',
  voice: 'GPT-SoVITS 语音服务',
}

async function confirmServiceAction(service: string, action: string): Promise<void> {
  if (action !== 'stop') { serviceAction(service, action); return }
  const label = SERVICE_STOP_LABELS[service] || service
  const confirmed = await confirmAction({
    title: `停止${label}？`,
    message: '停止服务后，正在进行的绘图或语音合成任务将会中断。',
    confirmLabel: '停止服务',
    danger: true,
  })
  if (!confirmed) return
  serviceAction(service, action)
}

const sections: Array<{ id: string; label: string; icon: ArchiveIconName }> = [
  { id: 'control-overview', label: '运行概览', icon: 'eye' },
  { id: 'control-resources', label: '服务与显存', icon: 'model' },
  { id: 'control-library', label: '离线资源库', icon: 'image' },
  { id: 'control-services', label: '连接与声线', icon: 'gear' },
  { id: 'control-share', label: '分享与访问', icon: 'upload' },
  { id: 'control-logs', label: '运行日志', icon: 'book' },
]
const { activeSection, openSection } = useControlNavigation(sections.map(section => section.id))
const statusUsable = computed(() => statusLoaded.value && !statusError.value)
const serviceCards = computed<Array<{ name: string; icon: ArchiveIconName; online: boolean; detail: string }>>(() => [
  { name: 'SD WebUI', icon: 'image', online: sdOnline.value, detail: sdOnline.value ? (webuiManaged.value ? '受控绘图服务' : '手动启动的绘图服务') : 'Stable Diffusion 绘图' },
  { name: 'ComfyUI', icon: 'model', online: comfyOnline.value, detail: 'Anima · Krea · 视频' },
  { name: '角色语音', icon: 'sound', online: ttsOnline.value, detail: ttsSelfHealing.value ? '正在自动恢复连接' : `GPT-SoVITS · ${voiceConfiguredCount.value} / 2 声线已配置` },
  { name: '本地对话', icon: 'chat', online: ollamaOnline.value, detail: ollamaOnline.value ? ollamaMeta.value : 'Ollama · 按需加载模型' },
])

onMounted(() => { status.startPolling() })
onUnmounted(() => { status.stopPolling() })
</script>

<style scoped src="@/assets/css/control-view.css"></style>

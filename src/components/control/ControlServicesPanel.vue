<template>
<div class="control-panel-stack">
      <section id="control-service-status" class="control-overview" aria-label="连接状态" tabindex="-1" :aria-busy="serviceChecking || (!statusLoaded && !statusError)">
        <div class="overview-heading"><div><h2>{{ overviewFeedback.title }}</h2><p>{{ overviewFeedback.note }}</p></div><button class="btn btn-ghost btn-sm" type="button" :disabled="serviceChecking || opBusy" :aria-busy="serviceChecking" @click="recheckStatus"><ArchiveIcon name="refresh" />{{ serviceChecking ? '检测中…' : '重新检测' }}</button></div>
        <p v-if="requestedService" class="service-context">{{ requestedEngineLabel }}需要 {{ requestedService === 'webui' ? 'SD WebUI' : 'ComfyUI' }}。</p>
        <RouterLink v-if="route.query.engine === 'video'" class="btn btn-quiet btn-sm" :to="videoReturnLocation(route.query)">返回故事短片</RouterLink>
        <div class="status-wall service-rows">
          <article v-for="service in serviceCards" :key="service.key" :id="`control-service-${service.key}`" class="status-tile service-row"
            :class="{ 'service-required': requestedService === service.key }" :data-state="!statusUsable ? 'checking' : service.online ? 'on' : 'off'">
            <div class="service-row-copy"><h3 class="status-tile-head service-row-name"><ArchiveIcon :name="service.icon" />{{ service.name }}</h3><p class="status-tile-detail">{{ service.detail }}</p></div>
            <strong>{{ startingService === service.key ? operationCancelling ? '取消中…' : '启动中…' : !statusUsable ? (statusError ? '待检测' : '检测中…') : service.online ? '已连接' : '未连接' }}</strong>
            <div class="service-row-actions">
              <button v-if="startingService === service.key && canCancelOperation" class="btn btn-ghost btn-sm" type="button" :disabled="operationCancelling" @click="cancelOperation">{{ operationCancelling ? '正在取消…' : '取消启动' }}</button>
              <template v-if="service.key === 'llama'">
                <RouterLink :to="{ query: route.query, hash: '#setup-chat-options' }" class="btn btn-ghost btn-sm">准备模型</RouterLink>
                <button v-if="llamaManaged" class="btn btn-danger btn-sm" type="button" :disabled="opBusy" @click="serviceAction('llama','stop')">释放显存</button>
              </template>
              <template v-else-if="service.key !== 'ollama' && startingService !== service.key">
                <StudioTooltip v-if="!service.online" anchor content="启动服务">
                  <button class="btn btn-sm" :class="requestedService === service.key ? 'btn-primary' : 'btn-ghost'" type="button"
                    :disabled="!statusUsable || opBusy || service.online" @click="serviceAction(service.key, 'start')">启动</button>
                </StudioTooltip>
                <StudioTooltip v-else anchor content="停止服务">
                  <button class="btn btn-danger btn-sm" type="button" :disabled="!statusUsable || opBusy || !service.online"
                    @click="confirmServiceAction(service.key, 'stop')">停止</button>
                </StudioTooltip>
              </template>
              <button v-else-if="service.key === 'ollama' && ollamaModels.length" class="btn btn-danger btn-sm" type="button" :disabled="!statusUsable || opBusy"
                @click="serviceAction('ollama', 'unload')">释放显存</button>
            </div>
          </article>
        </div>
      </section>

      <section id="control-resources" class="panel-card resource-panel">
        <div class="panel-kicker">常用操作</div>
        <h2 class="panel-heading">显存与运行偏好</h2>
        <div class="mode-grid">
          <button class="mode-card" type="button" :disabled="!statusUsable || opBusy || modeBusy" @click="switchMode('draw')">
            <span class="mode-title"><ArchiveIcon name="spark" /> 绘图优先<ArchiveIcon class="mode-arrow" name="chevron-down" /></span>
            <span class="mode-desc">{{ imageProvider === 'native' ? '释放聊天与语音显存' : '释放显存，启动 ComfyUI' }}</span>
          </button>
          <button class="mode-card" type="button" :disabled="!statusUsable || opBusy || modeBusy" @click="switchMode('chat')">
            <span class="mode-title"><ArchiveIcon name="coffee" /> 聊天与语音优先<ArchiveIcon class="mode-arrow" name="chevron-down" /></span>
            <span class="mode-desc">释放绘图显存，启动语音</span>
          </button>
        </div>

        <ToggleSwitch v-model="autoStartVoice" :disabled="savingAutoStartVoice || !statusLoaded" class="autostart-row" @change="saveAutoStartVoice">
          <span>进入控制面板时启动语音<span class="autostart-hint">显存不足建议关闭</span></span>
        </ToggleSwitch>
        <p v-if="(imageProvider !== 'native' && !scripts.comfy) || !scripts.voiceStart" class="script-hint">
          未检测到快捷启停脚本（服务仍可手动运行后连接）：
          <span v-if="imageProvider !== 'native' && !scripts.comfy">ComfyUI 脚本 </span>
          <span v-if="!scripts.voiceStart">语音启动脚本 </span>
          <span v-if="!scripts.voiceStop">语音停止脚本 </span>
        </p>
      </section>

      <details id="control-connection-settings" class="panel-card service-config-panel">
        <StudioDisclosureSummary><span>服务地址与角色声线<small class="inference-disclosure-hint">默认地址通常无需调整</small></span></StudioDisclosureSummary>
        <div data-disclosure-content>
        <label class="field-label" for="comfy-host">ComfyUI 地址</label>
        <div class="field-row tw:flex tw:gap-s-2">
          <StudioTooltip :content="comfyHost">
            <input id="comfy-host" v-model="comfyHost" class="input input-mono" type="text" placeholder="http://127.0.0.1:8188" aria-describedby="comfy-host-help" spellcheck="false" @keydown.enter="saveConfig" />
          </StudioTooltip>
        </div>
        <p id="comfy-host-help" class="field-help">ComfyUI 绘图与视频地址（原生模式无需连接）。</p>

        <label class="field-label" for="tts-engine">角色语音引擎</label>
        <StudioSelect id="tts-engine" v-model="ttsEngine" label="角色语音引擎" aria-describedby="tts-engine-help"
          :options="[{ value: 'voxcpm2', label: 'VoxCPM2' }, { value: 'gpt-sovits', label: 'GPT-SoVITS' }]" />
        <p id="tts-engine-help" class="field-help">切换后重启应用生效。</p>
        <label class="field-label" for="tts-host">语音 API 地址</label>
        <div class="field-row tw:flex tw:gap-s-2">
          <StudioTooltip :content="ttsHost">
            <input id="tts-host" v-model="ttsHost" class="input input-mono" type="text" placeholder="http://127.0.0.1:9880" aria-describedby="tts-host-help" spellcheck="false" @keydown.enter="saveConfig" />
          </StudioTooltip>
        </div>
        <p id="tts-host-help" class="field-help">语音服务默认按需启动。</p>

        <details class="voice-config">
          <StudioDisclosureSummary><ArchiveIcon name="sound" /> 角色声线配置 <span class="voice-count">{{ voiceConfiguredCount }} / 2 已配置</span></StudioDisclosureSummary>
          <div data-disclosure-content class="voice-grid">
            <div class="voice-card tw:grid tw:gap-s-2 tw:min-w-0">
              <div class="voice-card-title">宁宁</div>
              <template v-if="ttsEngine === 'voxcpm2'">
                <label for="v-nene-lora">宁宁 LoRA 权重路径</label>
                <input id="v-nene-lora" v-model="voiceNeneLora" class="input" placeholder="lora_weights.safetensors 路径" />
              </template>
              <label for="v-nene-ref">宁宁参考音频路径</label>
            <input id="v-nene-ref" v-model="voiceNeneRef" class="input" placeholder="参考音频路径" />
              <label for="v-nene-prompt">宁宁提示文本（日文）</label>
            <input id="v-nene-prompt" v-model="voiceNenePrompt" class="input" placeholder="提示文本（日文）" />
            </div>
            <div class="voice-card tw:grid tw:gap-s-2 tw:min-w-0">
              <div class="voice-card-title">夏目</div>
              <template v-if="ttsEngine === 'voxcpm2'">
                <label for="v-nat-lora">夏目 LoRA 权重路径</label>
                <input id="v-nat-lora" v-model="voiceNatsumeLora" class="input" placeholder="lora_weights.safetensors 路径" />
              </template>
              <label for="v-nat-ref">夏目参考音频路径</label>
            <input id="v-nat-ref" v-model="voiceNatsumeRef" class="input" placeholder="参考音频路径" />
              <label for="v-nat-prompt">夏目提示文本（日文）</label>
            <input id="v-nat-prompt" v-model="voiceNatsumePrompt" class="input" placeholder="提示文本（日文）" />
            </div>
          </div>
        </details>
        <div class="config-save-row" :aria-busy="savingConfig"><StudioLiquidButton label="保存连接与声线" :busy="savingConfig" :complete="configSaved" :disabled="opBusy || !statusLoaded" @click="saveConfig" /></div>
        </div>
      </details>
</div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { videoReturnLocation } from '@/utils/videoNavigation'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import { useControlContext } from '@/composables/useControlContext'
const { status, actions } = useControlContext()
const route = useRoute()
const statusUsable = computed(() => status.statusLoaded.value && !status.statusError.value)
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioLiquidButton from '@/components/ui/StudioLiquidButton.vue'
import type { ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'
import { confirmAction } from '@/composables/useConfirm'
import type { ControlService, ControlServiceAction } from '@/api/controlApi'
const { comfyOnline, sdOnline, ttsOnline, ollamaOnline, comfyManaged, ollamaModels, modeBusy,
  selfHealing, serviceChecking, statusLoaded, statusError, scripts, comfyHost, ttsHost, ttsEngine, activeVoiceEngine,
  llamaOnline, llamaManaged, llamaLabel, voiceNeneLora, voiceNatsumeLora, voiceNeneRef, voiceNenePrompt,
  voiceNatsumeRef, voiceNatsumePrompt, autoStartVoice, savingAutoStartVoice, overviewFeedback, imageProvider,
  opBusy, operation, ollamaMeta, voiceConfiguredCount, pollStatus } = status
const { serviceAction, switchMode, saveAutoStartVoice, saveConfig, savingConfig, configSaved, canCancelOperation, operationCancelling, cancelOperation } = actions
const startingService = computed(() => operation.value?.status === 'running' && operation.value.kind.endsWith('-start') ? operation.value.kind.slice(0, -6) : '')
function recheckStatus() { if (!serviceChecking.value && !opBusy.value) void pollStatus(true) }
const ttsSelfHealing = computed(() => {
  const service = selfHealing.value?.services?.tts
  return Boolean(service && (service.restarting || service.attempt > 0))
})
const SERVICE_STOP_LABELS: Record<string, string> = {
  webui: 'SD WebUI 绘图服务',
  comfy: 'ComfyUI 绘图服务',
  voice: '角色语音服务',
}

async function confirmServiceAction(service: ControlService, action: ControlServiceAction): Promise<void> {
  if (action !== 'stop') { serviceAction(service, action); return }
  const label = SERVICE_STOP_LABELS[service] || service
  const confirmed = await confirmAction({
    title: `停止${label}？`,
    message: '正在进行的任务将会中断。',
    confirmLabel: '停止服务',
    danger: true,
  })
  if (!confirmed) return
  serviceAction(service, action)
}

const requestedService = computed(() => route.query.engine === 'sd' ? 'webui'
  : route.query.engine === 'video' || imageProvider.value === 'comfy' && ['anima', 'krea2'].includes(String(route.query.engine)) ? 'comfy' : '')
const requestedEngineLabel = computed(() => ({ sd: 'SD 绘图', anima: 'Anima 绘图', krea2: 'Krea 2 绘图', video: '故事短片' } as Record<string, string>)[String(route.query.engine)] || '当前创作')
const serviceCards = computed<Array<{ key: ControlService; name: string; icon: ArchiveIconName; online: boolean; detail: string }>>(() => [
  ...(requestedService.value === 'webui' || sdOnline.value ? [{ key: 'webui' as const, name: 'SD WebUI', icon: 'model' as const, online: sdOnline.value, detail: '兼容已有 SD 绘图环境' }] : []),
  { key: 'llama', name: 'llama.cpp 本地聊天', icon: 'chat', online: llamaOnline.value, detail: llamaLabel.value || '按需加载' },
  { key: 'comfy', name: 'ComfyUI', icon: 'model', online: comfyOnline.value, detail: `${imageProvider.value === 'native' ? '兼容引擎 · 视频' : 'Anima · Krea 2 · 视频'}${comfyOnline.value ? (comfyManaged.value ? ' · 受控' : ' · 手动') : ''}` },
  { key: 'voice', name: `${activeVoiceEngine.value} 语音`, icon: 'sound', online: ttsOnline.value, detail: ttsSelfHealing.value ? '自动恢复中…' : `${voiceConfiguredCount.value} / 2 声线已配置` },
  { key: 'ollama', name: 'Ollama 本地对话', icon: 'chat', online: ollamaOnline.value, detail: ollamaOnline.value ? ollamaMeta.value : '按需加载' },
])
</script>

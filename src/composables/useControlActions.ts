import { getDesktopCapabilities } from '../platform/desktop/capabilities.ts'
import { downloadBlob } from '../utils/downloadBlob.ts'
/**
 * 控制面板 · 操作编排（从 ControlView.vue 拆出）。
 *
 * 所有权：配置与偏好保存、服务启停、模式切换、
 * 公网隧道启停与诊断导出。所有 HTTP 都走统一错误信封。
 */

import { ref } from 'vue'
import {
  controlApi,
  type ControlService,
  type ControlServiceAction,
} from '../api/controlApi.ts'
import { maintenanceApi } from '../api/maintenanceApi.ts'
import type { useControlStatus } from './useControlStatus.ts'
import { settingsRepository, TUNNEL_ENABLED_SETTING } from '../storage/settingsRepository.ts'

type StatusApi = ReturnType<typeof useControlStatus>

interface ActionHooks {
  showToast: (msg: string, isError?: boolean) => void
}

export function useControlActions(
  status: StatusApi,
  { showToast }: ActionHooks,
) {
  const tunnelEnabled = ref(settingsRepository.get(TUNNEL_ENABLED_SETTING) ?? true)

  /** catch 里取消息：替代 `catch (e: any) { e.message }` —— unknown 才是 catch 的真实类型 */
  function errorMessage(error: unknown, fallback: string): string {
    if (error instanceof Error && error.message) return error.message
    const text = String(error ?? '').trim()
    return text || fallback
  }
  function toggleTunnel() {
    if (status.actionBusy.value || status.opBusy.value) return
    tunnelEnabled.value = !tunnelEnabled.value
    settingsRepository.set(TUNNEL_ENABLED_SETTING, tunnelEnabled.value)
    status.mainBtnLabel.value = status.tunnelActive.value ? '停止公网分享' : '启动并生成分享链接'
  }

  function buildConfigPayload() {
    const last = status.lastStatus()
    const voices = last?.restartRequired ? last.savedConfig?.voices : last?.voices
    const neneBase = voices?.nene || {}
    const natBase = voices?.natsume || {}
    return {
      sdHost: status.sdHost.value.trim(),
      comfyHost: status.comfyHost.value.trim(),
      ttsHost: status.ttsHost.value.trim(),
      ttsEngine: status.ttsEngine.value === 'voxcpm2' ? 'voxcpm2' as const : 'gpt-sovits' as const,
      voices: {
        nene: { ...neneBase, loraWeightsPath: status.voiceNeneLora.value.trim(), refAudioPath: status.voiceNeneRef.value.trim(), promptText: status.voiceNenePrompt.value.trim(), promptLang: 'ja', textLang: 'ja' },
        natsume: { ...natBase, loraWeightsPath: status.voiceNatsumeLora.value.trim(), refAudioPath: status.voiceNatsumeRef.value.trim(), promptText: status.voiceNatsumePrompt.value.trim(), promptLang: 'ja', textLang: 'ja' },
      },
    }
  }

  async function saveConfigDraft() {
    const payload = buildConfigPayload()
    const snapshot = status.captureConfigEdits()
    const result = await controlApi.saveConfig(payload)
    const hasNewerEdits = status.acknowledgeConfigEdits(snapshot)
    // Invalidate pre-acknowledgement reads before yielding to newer edits or polls.
    status.pollStatus(true)
    return { result, hasNewerEdits }
  }

  const savingConfig = ref(false)
  const configSaved = ref(false)
  async function saveConfig(event?: Event) {
    if (event instanceof KeyboardEvent && (event.isComposing || event.keyCode === 229)) return
    if (savingConfig.value || status.opBusy.value || !status.statusLoaded.value) return
    savingConfig.value = true
    configSaved.value = false
    status.feedbackText.value = '正在保存并重新检测…'
    try {
      const { result, hasNewerEdits } = await saveConfigDraft()
      configSaved.value = !hasNewerEdits
      const message = result?.restartRequired ? (result.message || '配置已保存，重新启动应用后生效') : '生成服务配置已保存'
      showToast(hasNewerEdits ? message + '；后续修改尚未保存' : message)
    } catch (e) { showToast(errorMessage(e, '保存失败'), true); status.pollStatus() }
    finally { savingConfig.value = false }
  }

  async function saveAutoStartVoice() {
    if (status.savingAutoStartVoice.value) return
    const requested = status.autoStartVoice.value
    status.savingAutoStartVoice.value = true
    try {
      const result = await controlApi.savePreference(requested)
      const acknowledged = typeof result.autoStartVoice === 'boolean' ? result.autoStartVoice : requested
      status.autoStartVoice.value = acknowledged
      showToast(acknowledged ? '已开启：下次自动启动语音' : '已关闭：语音改为按需启动')
    } catch (e) {
      // A lost response does not prove rollback. Re-read the saved preference.
      showToast('保存结果尚未确认：' + errorMessage(e, '连接中断') + '；正在重新读取设置', true)
    } finally {
      status.savingAutoStartVoice.value = false
      // Starting a new read synchronously invalidates pre-acknowledgement polls.
      await status.pollStatus(true)
    }
  }

  async function serviceAction(service: ControlService, action: ControlServiceAction) {
    if (status.opBusy.value) { showToast('有操作正在进行，请稍候', true); return }
    status.operationSubmitting.value = true
    showToast((action === 'start' ? '正在启动' : action === 'stop' ? '正在停止' : '正在处理') + '…')
    try {
      const data = await controlApi.serviceAction(service, action)
      if (data.operation) status.operation.value = data.operation
      showToast(data.message || '已提交')
      status.pollStatus(true); status.pollLogs()
    } catch (e) { showToast(errorMessage(e, '操作失败'), true); status.pollStatus(true) }
    finally { status.operationSubmitting.value = false }
  }

  async function switchMode(mode: 'draw' | 'chat') {
    if (status.opBusy.value) { showToast('有操作正在进行，请稍候', true); return }
    status.operationSubmitting.value = true
    showToast(mode === 'draw' ? '切换到绘图优先…' : '切换到聊天优先…')
    try {
      const data = await controlApi.switchMode(mode)
      if (data.operation) status.operation.value = data.operation
      status.modeBusy.value = true
      showToast(data.message || '模式切换已开始')
      status.pollStatus(true); status.pollLogs()
    } catch (e) { showToast(errorMessage(e, '模式切换失败'), true); status.pollStatus(true) }
    finally { status.operationSubmitting.value = false }
  }

  async function doStart() {
    if (status.opBusy.value || savingConfig.value) { showToast('有操作正在进行，请稍候', true); return }
    if (!tunnelEnabled.value) { showToast('请先开启公网分享通道'); return }
    if (status.statusError.value) { showToast('请先重新检测本机控制服务', true); return }
    if (!status.lastStatus()) { showToast('控制面板仍在读取配置，请稍候再试', true); status.pollStatus(); return }
    if (status.lastStatus()?.restartRequired) { showToast('配置已保存，请重新启动应用后再启用公网分享'); return }
    status.actionBusy.value = true
    status.operationSubmitting.value = true
    status.mainBtnLabel.value = '正在启用公网分享…'
    status.feedbackText.value = '正在保存并重新检测…'
    try {
      const { result, hasNewerEdits } = await saveConfigDraft()
      const draftNote = hasNewerEdits ? '；后续修改尚未保存' : ''
      if (result?.restartRequired) { showToast((result.message || '配置已保存，请重新启动应用后再启用公网分享') + draftNote); return }
      showToast('生成服务配置已保存' + draftNote)
      await controlApi.start(tunnelEnabled.value)
      showToast('已请求启动公网分享，连接成功后会显示链接')
      status.startPolling()
    } catch (e) { showToast('启动失败：' + errorMessage(e, '未知原因'), true) }
    finally { status.actionBusy.value = false; status.operationSubmitting.value = false; status.pollStatus() }
  }

  async function doStop() {
    if (status.opBusy.value) { showToast('有操作正在进行，请稍候', true); return }
    status.operationSubmitting.value = true
    status.actionBusy.value = true
    status.mainBtnLabel.value = '正在停止公网分享…'
    try {
      await controlApi.stop()
      showToast('公网分享已停止；网站与各生成服务不受影响')
      status.shareLink.value = ''
      status.tunnelStatus.value = 'disabled'
      status.tunnelActive.value = false
    } catch (e) { showToast('停止失败：' + errorMessage(e, '未知原因'), true) }
    finally { status.actionBusy.value = false; status.operationSubmitting.value = false; status.pollStatus() }
  }

  const exportingDiag = ref(false)
  async function exportDiag() {
    if (exportingDiag.value) return
    exportingDiag.value = true
    showToast('正在整理诊断包…')
    try {
      const data = await controlApi.getDiagnostics()
      const [{ buildDiagnosticExport }, { version }, { DATA_VERSION }] = await Promise.all([
        import('../utils/diagnosticExport.ts'), import('../../package.json'), import('../stores/sceneStore'),
      ])
      const report = buildDiagnosticExport(data, version, DATA_VERSION)
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16)
      downloadBlob(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json;charset=utf-8' }), 'huiyu-diagnostics-' + stamp + '.json')
      showToast('脱敏诊断包已保存到本机')
    } catch (e) { showToast(errorMessage(e, '诊断包导出失败'), true) }
    finally { exportingDiag.value = false }
  }

  const buildingWeb = ref(false)

  /** 重新构建前端（公网分享伺服 dist/，源码改动后需重建才生效） */
  async function buildWeb() {
    if (buildingWeb.value) return
    buildingWeb.value = true
    if (getDesktopCapabilities()) {
      try {
        if (await getDesktopCapabilities()!.isPackaged()) {
          showToast('桌面应用模式不支持重建前端（源码不在安装包内）', true)
          buildingWeb.value = false
          return
        }
      } catch { /* 查询失败继续走服务端，501 兜底 */ }
    }
    showToast('正在构建前端，约需 10-30 秒…')
    try {
      const data = await maintenanceApi.buildWeb()
      showToast(`前端已重建（${Math.round(data.durationMs / 1000)} 秒），分享内容已更新`)
    } catch (e) {
      showToast('构建失败：' + errorMessage(e, '未知原因'), true)
    } finally {
      buildingWeb.value = false
      status.pollStatus(true)
    }
  }

  return {
    tunnelEnabled, errorMessage, toggleTunnel, saveConfig, savingConfig, configSaved, saveAutoStartVoice,
    serviceAction, switchMode, doStart, doStop, exportDiag, exportingDiag,
    buildWeb, buildingWeb,
  }
}

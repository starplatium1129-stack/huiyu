import { getDesktopCapabilities } from '../platform/desktop/capabilities.ts'
import { downloadBlob } from '../utils/downloadBlob.ts'
import { copyText } from '../utils/clipboard.ts'
/**
 * 控制面板 · 操作编排（从 ControlView.vue 拆出）。
 *
 * 所有权：配置与偏好保存、服务启停、模式切换、
 * 公网隧道启停与诊断导出。所有 HTTP 都走统一错误信封。
 */

import { ref } from 'vue'
import {
  controlApi,
  type ControlApi,
  type ControlService,
  type ControlServiceAction,
} from '../api/controlApi.ts'
import { maintenanceApi, type MaintenanceApi } from '../api/maintenanceApi.ts'
import type { useControlStatus } from './useControlStatus.ts'
import { settingsRepository, TUNNEL_ENABLED_SETTING } from '../storage/settingsRepository.ts'

type StatusApi = ReturnType<typeof useControlStatus>

interface ActionHooks {
  showToast: (msg: string, isError?: boolean) => void
  control?: ControlApi
  maintenance?: MaintenanceApi
}

export function useControlActions(
  status: StatusApi,
  { showToast, control = controlApi, maintenance = maintenanceApi }: ActionHooks,
) {
  const tunnelEnabled = ref(settingsRepository.get(TUNNEL_ENABLED_SETTING) ?? true)

  /** catch 里取消息：替代 `catch (e: any) { e.message }` —— unknown 才是 catch 的真实类型 */
  function errorMessage(error: unknown, fallback: string): string {
    if (error instanceof Error && error.message) return error.message
    const text = String(error ?? '').trim()
    return text || fallback
  }
  async function copy(text: string) {
    if (!text) return
    const copied = await copyText(text)
    showToast(copied ? '已复制到剪贴板' : '复制未完成，请选中内容后手动复制', !copied)
  }

  function toggleTunnel() {
    tunnelEnabled.value = !tunnelEnabled.value
    settingsRepository.set(TUNNEL_ENABLED_SETTING, tunnelEnabled.value)
    status.mainBtnLabel.value = status.tunnelActive.value ? '停止公网分享' : '启动并生成分享链接'
  }

  function buildConfigPayload() {
    const last = status.lastStatus()
    const neneBase = last?.voices?.nene || {}
    const natBase = last?.voices?.natsume || {}
    return {
      sdHost: status.sdHost.value.trim(),
      comfyHost: status.comfyHost.value.trim(),
      ttsHost: status.ttsHost.value.trim(),
      voices: {
        nene: { ...neneBase, refAudioPath: status.voiceNeneRef.value.trim(), promptText: status.voiceNenePrompt.value.trim(), promptLang: 'ja', textLang: 'ja' },
        natsume: { ...natBase, refAudioPath: status.voiceNatsumeRef.value.trim(), promptText: status.voiceNatsumePrompt.value.trim(), promptLang: 'ja', textLang: 'ja' },
      },
    }
  }

  const savingConfig = ref(false)
  async function saveConfig() {
    if (savingConfig.value) return
    savingConfig.value = true
    status.feedbackText.value = '正在保存并重新检测…'
    try {
      await control.saveConfig(buildConfigPayload())
      showToast('生成服务配置已保存')
      status.pollStatus(true)
    } catch (e) { showToast(errorMessage(e, '保存失败'), true); status.pollStatus() }
    finally { savingConfig.value = false }
  }

  async function saveAutoStartVoice() {
    try {
      await control.savePreference(status.autoStartVoice.value)
      showToast(status.autoStartVoice.value ? '已开启：下次自动启动语音' : '已关闭：语音改为按需启动')
    } catch (e) {
      // 请求失败时把开关拨回去，避免 UI 与落盘状态不一致
      status.autoStartVoice.value = !status.autoStartVoice.value
      showToast(errorMessage(e, '保存失败'), true)
    }
  }

  function isControlService(value: string): value is ControlService {
    return value === 'voice' || value === 'webui' || value === 'comfy' || value === 'ollama'
  }

  function isControlServiceAction(value: string): value is ControlServiceAction {
    return value === 'start' || value === 'stop' || value === 'unload'
  }

  async function serviceAction(service: string, action: string) {
    if (status.opBusy.value) { showToast('有操作正在进行，请稍候', true); return }
    if (!isControlService(service) || !isControlServiceAction(action)) {
      showToast('不支持的服务操作', true)
      return
    }
    showToast((action === 'start' ? '正在启动' : action === 'stop' ? '正在停止' : '正在处理') + '…')
    try {
      const data = await control.serviceAction(service, action)
      if (data.operation) status.operation.value = data.operation
      showToast(data.message || '已提交')
      status.pollStatus(true); status.pollLogs()
    } catch (e) { showToast(errorMessage(e, '操作失败'), true); status.pollStatus(true) }
  }

  async function switchMode(mode: 'draw' | 'chat') {
    if (status.opBusy.value) { showToast('有操作正在进行，请稍候', true); return }
    showToast(mode === 'draw' ? '切换到绘图优先…' : '切换到聊天优先…')
    try {
      const data = await control.switchMode(mode)
      if (data.operation) status.operation.value = data.operation
      status.modeBusy.value = true
      showToast(data.message || '模式切换已开始')
      status.pollStatus(true); status.pollLogs()
    } catch (e) { showToast(errorMessage(e, '模式切换失败'), true); status.pollStatus(true) }
  }

  async function doStart() {
    if (!status.lastStatus()) { showToast('控制面板仍在读取配置，请稍候再试', true); status.pollStatus(); return }
    status.actionBusy.value = true
    status.mainBtnLabel.value = '正在启用公网分享…'
    status.feedbackText.value = '正在保存并重新检测…'
    try {
      await control.saveConfig(buildConfigPayload())
      showToast('生成服务配置已保存')
      await control.start(tunnelEnabled.value)
      showToast('公网分享已启用')
      status.startPolling()
    } catch (e) { showToast('启动失败：' + errorMessage(e, '未知原因'), true) }
    finally { status.actionBusy.value = false; status.pollStatus() }
  }

  async function doStop() {
    status.actionBusy.value = true
    status.mainBtnLabel.value = '正在停止公网分享…'
    try {
      await control.stop()
      showToast('公网分享已停止；网站与各生成服务不受影响')
      status.shareLink.value = ''
      status.tunnelStatus.value = 'disabled'
      status.tunnelActive.value = false
    } catch (e) { showToast('停止失败：' + errorMessage(e, '未知原因'), true) }
    finally { status.actionBusy.value = false; status.pollStatus() }
  }

  const exportingDiag = ref(false)
  async function exportDiag() {
    if (exportingDiag.value) return
    exportingDiag.value = true
    showToast('正在整理诊断包…')
    try {
      const data = await control.getDiagnostics()
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
    if (getDesktopCapabilities()) {
      try {
        if (await getDesktopCapabilities()!.isPackaged()) {
          showToast('桌面应用模式不支持重建前端（源码不在安装包内）', true)
          return
        }
      } catch { /* 查询失败继续走服务端，501 兜底 */ }
    }
    buildingWeb.value = true
    showToast('正在构建前端，约需 10-30 秒…')
    try {
      const data = await maintenance.buildWeb()
      showToast(`前端已重建（${Math.round(data.durationMs / 1000)} 秒），分享内容已更新`)
    } catch (e) {
      showToast('构建失败：' + errorMessage(e, '未知原因'), true)
    } finally {
      buildingWeb.value = false
      status.pollStatus(true)
    }
  }

  return {
    tunnelEnabled, errorMessage, copy, toggleTunnel, saveConfig, savingConfig, saveAutoStartVoice,
    serviceAction, switchMode, doStart, doStop, exportDiag, exportingDiag,
    buildWeb, buildingWeb,
  }
}

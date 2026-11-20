import type { Ref } from 'vue'
import type { useChatStorage } from './useChatStorage'
import type { ChatProvider } from './chatStorageTypes'

export interface ChatConnectionOptions {
  storage: Pick<ReturnType<typeof useChatStorage>, 'setApiSettings' | 'setModel'>
  onError: (message: string, kind?: string, timeout?: number) => void
  chatProvider: Ref<ChatProvider>
  currentModel: Ref<string>
  apiBaseUrl: Ref<string>
  hostApiBaseUrl?: Ref<string>
  apiModel: Ref<string>
  apiKey: Ref<string>
  webSearchEnabled: Ref<boolean>
  /** 使用站主托管配置（访客模式）：前端不带 key，服务端代填 */
  useHostConfig: Ref<boolean>
  /** 启用桌宠本地工具（companionTools）：仅桌面应用 + API 模式生效 */
  companionTools: Ref<boolean>
  /** 模型推理强度（off/low/medium/high，用户可调；仅 API 模式生效） */
  reasoning: Ref<'off' | 'low' | 'medium' | 'high'>
}

export function createChatTurnConnection(options: ChatConnectionOptions) {
  function captureConnection() {
    return { provider: options.chatProvider.value, currentModel: options.currentModel.value,
      baseUrl: options.apiBaseUrl.value, apiModel: options.apiModel.value, apiKey: options.apiKey.value,
      hostConfig: options.useHostConfig.value, webSearch: options.webSearchEnabled.value,
      tools: options.companionTools.value, reasoning: options.reasoning.value, hostBaseUrl: options.hostApiBaseUrl?.value || '' }
  }
  type TurnConnection = ReturnType<typeof captureConnection>
  const connectionMatches = (connection: TurnConnection) => {
    const live = captureConnection()
    return (Object.keys(connection) as Array<keyof TurnConnection>).every(key => live[key] === connection[key])
  }

  // A stream may canonicalize its own model, but never a newer connection draft.
  function applyModelWriteback(rawModel: unknown, hostMode: boolean, useVision: boolean, connection: TurnConnection) {
    if (connection.provider === 'muse') return
    if (connection.provider === 'api' && !hostMode && !useVision && String(rawModel) === connection.apiModel) return
    const ownsDraft = connectionMatches(connection)
    if (connection.provider === 'api' && !hostMode && !useVision) {
      connection.apiModel = String(rawModel)
      if (!ownsDraft) return
      options.apiModel.value = connection.apiModel
      void Promise.resolve(options.storage.setApiSettings({
        baseUrl: connection.baseUrl, model: connection.apiModel, apiKey: connection.apiKey,
      }, 'model')).catch(() => { if (connectionMatches(connection)) options.onError('模型配置未能安全保存，当前回复不受影响，请稍后重试。') })
    } else if (connection.provider !== 'api' || hostMode) {
      connection.currentModel = String(rawModel)
      if (!ownsDraft) return
      options.currentModel.value = connection.currentModel
      options.storage.setModel(connection.currentModel)
    }
  }
  return { captureConnection, connectionMatches, applyModelWriteback }
}

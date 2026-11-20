import { apiClient, type ApiResponseObject } from './client'

export type ChannelCharacter = 'nene' | 'natsume'
export type ChannelPhase = 'disabled' | 'connecting' | 'online' | 'error'
export const qqMuseContextLimits = [6, 16, 32, 64] as const

export interface QqGroup { id: string; label: string }

export interface QqChannelStatus {
  configured: boolean
  enabled: boolean
  appId: string | null
  character: ChannelCharacter
  drawing: boolean
  groupDrawing: boolean
  groupMuse?: boolean
  privateMuse?: boolean
  groupMuseAll?: boolean
  museContextLimit?: number
  museProactive?: boolean
  groupMuseStatus?: 'remoteDisabled' | 'waiting' | 'receiving' | 'vmConfigured' | 'vmUnavailable' | 'vmConfigError' | null
  groups: QqGroup[]
  paired: boolean
  phase: ChannelPhase
  detail: string | null
  pairCode: string | null
  pairExpiresAt: number | null
  groupPairCode: string | null
  groupPairExpiresAt: number | null
}

export interface QqChannelSettings {
  appId: string
  secret?: string
  character: ChannelCharacter
  enabled: boolean
  drawing: boolean
  groupDrawing: boolean
  groupMuse?: boolean
  privateMuse?: boolean
  groupMuseAll?: boolean
  museContextLimit?: number
  museProactive?: boolean
}

function validate(value: ApiResponseObject): boolean {
  return value.ok === true && !('secret' in value) && !('sealedSecret' in value)
    && typeof value.configured === 'boolean' && typeof value.enabled === 'boolean'
    && typeof value.drawing === 'boolean' && typeof value.paired === 'boolean' && typeof value.groupDrawing === 'boolean'
    && [value.groupMuse, value.privateMuse, value.groupMuseAll, value.museProactive]
      .every(flag => flag === undefined || typeof flag === 'boolean')
    && (value.museContextLimit === undefined || qqMuseContextLimits.some(limit => limit === value.museContextLimit))
    && (value.groupMuseStatus == null || ['remoteDisabled', 'waiting', 'receiving', 'vmConfigured', 'vmUnavailable', 'vmConfigError'].includes(String(value.groupMuseStatus)))
    && Array.isArray(value.groups) && value.groups.every(group => group && typeof group.id === 'string' && typeof group.label === 'string')
    && (value.character === 'nene' || value.character === 'natsume')
    && ['disabled', 'connecting', 'online', 'error'].includes(String(value.phase))
    && [value.appId, value.detail, value.pairCode, value.groupPairCode].every(item => item === null || typeof item === 'string')
    && [value.pairExpiresAt, value.groupPairExpiresAt].every(item => item === null || typeof item === 'number' && Number.isFinite(item))
}

const qqPath = '/api/workspace/companion-channels/qq'

export const companionQqApi = {
  status: (signal: AbortSignal) => apiClient.request<QqChannelStatus>(qqPath, { signal, cache: 'no-store', cachePolicy: 'bypass', timeoutMs: 8000, validate }),
  save: (body: QqChannelSettings, signal: AbortSignal) => apiClient.request<QqChannelStatus>(qqPath, { method: 'PUT', body, signal, timeoutMs: 8000, validate }),
  pair: (signal: AbortSignal) => apiClient.request<QqChannelStatus>(`${qqPath}/pair`, { method: 'POST', signal, timeoutMs: 8000, validate }),
  pairGroup: (label: string, signal: AbortSignal) => apiClient.request<QqChannelStatus>(`${qqPath}/pair-group`, { method: 'POST', body: { label }, signal, timeoutMs: 8000, validate }),
  removeGroup: (id: string, signal: AbortSignal) => apiClient.request<QqChannelStatus>(`${qqPath}/groups/${encodeURIComponent(id)}`, { method: 'DELETE', signal, timeoutMs: 8000, validate }),
}

export interface WeChatChannelSettings {
  enabled: boolean
  drawing: boolean
  character: ChannelCharacter
}

export interface WeChatChannelStatus extends WeChatChannelSettings {
  paired: boolean
  keyCreated: boolean
  origin: string
  credentials: { token: string; pairCode: string; pairExpiresAt: number } | null
}

function validateWeChat(value: ApiResponseObject): boolean {
  const credentials = value.credentials as WeChatChannelStatus['credentials']
  return value.ok === true && typeof value.origin === 'string' && (value.character === 'nene' || value.character === 'natsume')
    && [value.enabled, value.drawing, value.paired, value.keyCreated].every(item => typeof item === 'boolean')
    && (credentials === null || Boolean(credentials && /^[a-f0-9]{64}$/.test(credentials.token)
      && /^[a-f0-9]{12}$/.test(credentials.pairCode) && Number.isFinite(credentials.pairExpiresAt)))
}

const weChatPath = '/api/workspace/companion-channels/wechat'
export const companionWeChatApi = {
  status: (signal: AbortSignal) => apiClient.request<WeChatChannelStatus>(weChatPath, { signal, cache: 'no-store', cachePolicy: 'bypass', timeoutMs: 8000, validate: validateWeChat }),
  save: (body: WeChatChannelSettings, signal: AbortSignal) => apiClient.request<WeChatChannelStatus>(weChatPath, { method: 'PUT', body, signal, timeoutMs: 8000, validate: validateWeChat }),
  key: (signal: AbortSignal) => apiClient.request<WeChatChannelStatus>(`${weChatPath}/key`, { method: 'POST', signal, timeoutMs: 8000, validate: validateWeChat }),
}

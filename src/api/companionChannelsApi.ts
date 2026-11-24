import { apiClient, type ApiResponseObject } from './client'

export type ChannelCharacter = 'nene' | 'natsume'
export type QqCharacterId = ChannelCharacter | `card-${string}`
export type ChannelPhase = 'disabled' | 'connecting' | 'online' | 'error'
export const qqChatProviders = ['default', 'chatgpt', 'chatgpt-private'] as const
export type QqChatProvider = typeof qqChatProviders[number]
export const qqOwnerBonds = ['default', 'close', 'intimate'] as const
export type QqOwnerBond = typeof qqOwnerBonds[number]
export const qqVoiceModes = ['off', 'on-demand', 'auto'] as const
export type QqVoiceMode = typeof qqVoiceModes[number]
export const qqVoiceProfiles = ['auto', 'nene', 'natsume'] as const
export type QqVoiceProfile = string
export const qqMuseContextLimits = [6, 16, 32, 64] as const

export interface QqGroup { id: string; label: string; ownerBound?: boolean }
export interface QqFriend { id: string; label: string }

export interface QqChannelStatus {
  id: string
  name: string
  configured: boolean
  enabled: boolean
  appId: string | null
  character: QqCharacterId
  chatProvider?: QqChatProvider
  ownerBond?: QqOwnerBond
  ownerCallName?: string
  ownerNote?: string
  voiceMode?: QqVoiceMode
  groupVoice?: boolean
  voiceProfile?: QqVoiceProfile
  drawing: boolean
  groupDrawing: boolean
  groupNaturalReplies?: boolean
  groupMuse?: boolean
  privateMuse?: boolean
  groupMuseAll?: boolean
  museContextLimit?: number
  museProactive?: boolean
  groupMuseStatus?: 'remoteDisabled' | 'waiting' | 'receiving' | 'vmConfigured' | 'vmUnavailable' | 'vmConfigError' | null
  groups: QqGroup[]
  friends?: QqFriend[]
  paired: boolean
  phase: ChannelPhase
  detail: string | null
  pairCode: string | null
  pairExpiresAt: number | null
  groupPairCode: string | null
  groupPairExpiresAt: number | null
  friendPairCode?: string | null
  friendPairExpiresAt?: number | null
}

export interface QqBotsResponse {
  bots: QqChannelStatus[]
  bot?: QqChannelStatus
}

export interface QqChannelSettings {
  name?: string
  appId: string
  secret?: string
  character: QqCharacterId
  chatProvider?: QqChatProvider
  ownerBond?: QqOwnerBond
  ownerCallName?: string
  ownerNote?: string
  voiceMode?: QqVoiceMode
  groupVoice?: boolean
  voiceProfile?: QqVoiceProfile
  enabled: boolean
  drawing: boolean
  groupDrawing: boolean
  groupNaturalReplies?: boolean
  groupMuse?: boolean
  privateMuse?: boolean
  groupMuseAll?: boolean
  museContextLimit?: number
  museProactive?: boolean
}

export interface QqChatCardOption {
  id: `card-${string}`
  name: string
  catalogId?: string
}

export interface QqVoiceServiceStatus {
  online: boolean
  available?: boolean
  engineId: string
  engine: string
  clientSide?: boolean
  voices?: Record<string, boolean>
  voiceLabels?: Record<string, string>
  voiceCatalogMap?: Record<string, string>
}

function isObject(value: unknown): value is ApiResponseObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isQqCharacter(value: unknown): value is QqCharacterId {
  return value === 'nene' || value === 'natsume'
    || (typeof value === 'string' && /^card-[a-f0-9]{64}$/.test(value))
}

function validateBot(value: unknown): boolean {
  if (!isObject(value)) return false
  return value.ok === true && !('secret' in value) && !('sealedSecret' in value)
    && typeof value.id === 'string' && value.id.length > 0
    && typeof value.name === 'string'
    && typeof value.configured === 'boolean' && typeof value.enabled === 'boolean'
    && typeof value.drawing === 'boolean' && typeof value.paired === 'boolean' && typeof value.groupDrawing === 'boolean'
    && [value.groupMuse, value.privateMuse, value.groupMuseAll, value.museProactive, value.groupVoice, value.groupNaturalReplies]
      .every(flag => flag === undefined || typeof flag === 'boolean')
    && (value.chatProvider === undefined || qqChatProviders.some(provider => provider === value.chatProvider))
    && (value.ownerBond === undefined || qqOwnerBonds.some(bond => bond === value.ownerBond))
    && [value.ownerCallName, value.ownerNote].every(item => item === undefined || typeof item === 'string')
    && (value.voiceMode === undefined || qqVoiceModes.some(mode => mode === value.voiceMode))
    && (value.voiceProfile === undefined || (typeof value.voiceProfile === 'string' && (value.voiceProfile === 'auto' || /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.voiceProfile))))
    && (value.museContextLimit === undefined || qqMuseContextLimits.some(limit => limit === value.museContextLimit))
    && (value.groupMuseStatus == null || ['remoteDisabled', 'waiting', 'receiving', 'vmConfigured', 'vmUnavailable', 'vmConfigError'].includes(String(value.groupMuseStatus)))
    && Array.isArray(value.groups) && value.groups.every(group => isObject(group)
      && typeof group.id === 'string' && typeof group.label === 'string'
      && (group.ownerBound === undefined || typeof group.ownerBound === 'boolean'))
    && (value.friends === undefined || (Array.isArray(value.friends) && value.friends.every(friend => isObject(friend)
      && typeof friend.id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(friend.id)
      && typeof friend.label === 'string')))
    && isQqCharacter(value.character)
    && ['disabled', 'connecting', 'online', 'error'].includes(String(value.phase))
    && [value.appId, value.detail, value.pairCode, value.groupPairCode].every(item => item === null || typeof item === 'string')
    && [value.pairExpiresAt, value.groupPairExpiresAt].every(item => item === null || typeof item === 'number' && Number.isFinite(item))
    && (value.friendPairCode == null || typeof value.friendPairCode === 'string' && /^[a-f0-9]{12}$/.test(value.friendPairCode))
    && (value.friendPairExpiresAt == null || typeof value.friendPairExpiresAt === 'number' && Number.isFinite(value.friendPairExpiresAt))
}

function validateBots(value: ApiResponseObject): boolean {
  return value.ok === true
    && Array.isArray(value.bots) && value.bots.every(validateBot)
    && (value.bot === undefined || validateBot(value.bot))
}

function validateCards(value: ApiResponseObject): boolean {
  return Array.isArray(value.cards)
    && value.cards.every(card => isObject(card)
      && typeof card.id === 'string' && /^card-[a-f0-9]{64}$/.test(card.id)
      && typeof card.name === 'string'
      && (card.catalogId === undefined || typeof card.catalogId === 'string'))
}

function validateVoiceStatus(value: ApiResponseObject): boolean {
  return typeof value.online === 'boolean'
    && (value.available === undefined || typeof value.available === 'boolean')
    && typeof value.engineId === 'string'
    && typeof value.engine === 'string'
    && (value.clientSide === undefined || typeof value.clientSide === 'boolean')
    && (value.voices === undefined || isObject(value.voices))
}

const qqBotsPath = '/api/workspace/companion-channels/qq/bots'

export const companionQqApi = {
  list: (signal: AbortSignal) => apiClient.request<QqBotsResponse>(qqBotsPath, { signal, cache: 'no-store', cachePolicy: 'bypass', timeoutMs: 8000, validate: validateBots }),
  create: (body: QqChannelSettings, signal: AbortSignal) => apiClient.request<QqBotsResponse>(qqBotsPath, { method: 'POST', body, signal, timeoutMs: 10_000, validate: validateBots }),
  update: (botId: string, body: QqChannelSettings, signal: AbortSignal) => apiClient.request<QqBotsResponse>(`${qqBotsPath}/${encodeURIComponent(botId)}`, { method: 'PUT', body, signal, timeoutMs: 10_000, validate: validateBots }),
  remove: (botId: string, signal: AbortSignal) => apiClient.request<QqBotsResponse>(`${qqBotsPath}/${encodeURIComponent(botId)}`, { method: 'DELETE', signal, timeoutMs: 8000, validate: validateBots }),
  pair: (botId: string, signal: AbortSignal) => apiClient.request<QqBotsResponse>(`${qqBotsPath}/${encodeURIComponent(botId)}/pair`, { method: 'POST', signal, timeoutMs: 8000, validate: validateBots }),
  pairGroup: (botId: string, label: string, signal: AbortSignal) => apiClient.request<QqBotsResponse>(`${qqBotsPath}/${encodeURIComponent(botId)}/pair-group`, { method: 'POST', body: { label }, signal, timeoutMs: 8000, validate: validateBots }),
  removeGroup: (botId: string, groupId: string, signal: AbortSignal) => apiClient.request<QqBotsResponse>(`${qqBotsPath}/${encodeURIComponent(botId)}/groups/${encodeURIComponent(groupId)}`, { method: 'DELETE', signal, timeoutMs: 8000, validate: validateBots }),
  pairFriend: (botId: string, label: string, signal: AbortSignal) => apiClient.request<QqBotsResponse>(`${qqBotsPath}/${encodeURIComponent(botId)}/pair-friend`, { method: 'POST', body: { label }, signal, timeoutMs: 8000, validate: validateBots }),
  removeFriend: (botId: string, friendId: string, signal: AbortSignal) => apiClient.request<QqBotsResponse>(`${qqBotsPath}/${encodeURIComponent(botId)}/friends/${encodeURIComponent(friendId)}`, { method: 'DELETE', signal, timeoutMs: 8000, validate: validateBots }),
  cards: (signal: AbortSignal) => apiClient.request<{ cards: QqChatCardOption[] }>('/api/chat/cards', { signal, cache: 'no-store', cachePolicy: 'bypass', timeoutMs: 10_000, validate: validateCards }),
  voiceStatus: (signal: AbortSignal) => apiClient.request<QqVoiceServiceStatus>('/api/tts-status', { signal, cache: 'no-store', cachePolicy: 'bypass', timeoutMs: 8000, validate: validateVoiceStatus }),
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

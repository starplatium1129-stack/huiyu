import { computed, type Ref } from 'vue'
import type { StudioSelectGroup, StudioSelectOption } from '@/components/ui/StudioSelect.vue'
import type { ChatGptStatus } from '@/api/chatApi'
import {
  qqMuseContextLimits,
  type QqChannelStatus,
  type QqCharacterId,
  type QqChatCardOption,
  type QqChatProvider,
  type QqOwnerBond,
  type QqVoiceMode,
  type QqVoiceServiceStatus,
} from '@/api/companionChannelsApi'

const builtinCharacters: readonly StudioSelectOption[] = [
  { value: 'nene', label: '绫地宁宁 · nene' },
  { value: 'natsume', label: '四季夏目 · natsume' },
]
export const ownerBondOptions: ReadonlyArray<{ value: QqOwnerBond; label: string }> = [
  { value: 'default', label: '保持原设' },
  { value: 'close', label: '亲近偏爱' },
  { value: 'intimate', label: '专属恋人' },
]
export const chatProviderOptions: ReadonlyArray<{ value: QqChatProvider; label: string }> = [
  { value: 'default', label: '主机 API / Ollama' },
  { value: 'chatgpt', label: 'ChatGPT · 私聊和群聊' },
  { value: 'chatgpt-private', label: 'ChatGPT · 仅私聊' },
]
export const voiceModeOptions: ReadonlyArray<{ value: QqVoiceMode; label: string }> = [
  { value: 'off', label: '关闭' },
  { value: 'on-demand', label: '按需发送' },
  { value: 'auto', label: '每条都发' },
]
export function useQqVoiceProfileOptions(voiceStatus: Ref<QqVoiceServiceStatus | null>) {
  return computed<readonly StudioSelectOption[]>(() => {
    const voices = voiceStatus.value?.voices ?? {}
    const labels = voiceStatus.value?.voiceLabels ?? {}
    const extraIds = Object.keys(voices)
      .filter(id => id !== 'nene' && id !== 'natsume')
      .sort()
    const engineNeedsLocalFiles = voiceStatus.value?.engineId === 'gpt-sovits-native'
      || voiceStatus.value?.engineId === 'gpt-sovits'
      || voiceStatus.value?.engineId === 'voxcpm2'
    const options: StudioSelectOption[] = [
      { value: 'auto', label: '自动匹配（默认）' },
      { value: 'nene', label: `${labels.nene || '宁宁'}声线` },
      { value: 'natsume', label: `${labels.natsume || '夏目'}声线` },
    ]
    for (const id of extraIds) {
      const name = labels[id] || (id === 'roxy' ? '洛琪希' : id)
      const ready = Boolean(voices[id]) && (!engineNeedsLocalFiles || voiceStatus.value?.available === true || voiceStatus.value?.online === true)
      options.push({
        value: id,
        label: ready ? `${name}声线` : `${name}声线（本机未就绪）`,
        disabled: !ready,
      })
    }
    return options
  })
}
export const contextOptions = qqMuseContextLimits.map(value => ({ value, label: `${value} 条` }))
export const museStatusLabels = {
  remoteDisabled: '远程接口未启动，请检查原生绘图的「允许连接」。',
  waiting: '正在等待 Muse 通过远程接口收信。最近 90 秒没有收信请求。',
  receiving: '最近 90 秒收到过 Muse 的收信请求。',
  vmConfigured: '已指定 Muse 虚拟机。收到提问后，绘遇会投递问题并查询答复。',
  vmUnavailable: '虚拟机接口暂未就绪。请检查接收端口和回复格式，绘遇会在消息过期前重试。',
  vmConfigError: '虚拟机配置无效。请检查 muse-qq-vm.json，然后重新保存 QQ 连接。',
}

export function phaseLabel(bot: QqChannelStatus): string {
  if (bot.phase === 'online') return bot.paired || bot.groups.length ? '在线 · 已绑定' : '在线 · 待绑定'
  return { connecting: '连接中', disabled: '已停用', error: '连接异常' }[bot.phase]
}

export function useQqCharacterOptions(cards: Ref<QqChatCardOption[]>, character: Ref<QqCharacterId>) {
  const cardMap = computed(() => new Map(cards.value.map(card => [card.id, card])))
  const projectCards = computed(() => cards.value.filter(card => Boolean(card.catalogId)))
  const importedCards = computed(() => cards.value.filter(card => !card.catalogId))

  function characterDisplayName(id: string): string {
    if (id === 'nene') return '绫地宁宁'
    if (id === 'natsume') return '四季夏目'
    return cardMap.value.get(id as `card-${string}`)?.name || '项目角色卡'
  }

  const selectedCharacterName = computed(() => characterDisplayName(character.value))

  const characterGroups = computed<readonly StudioSelectGroup[]>(() => {
    const groups: StudioSelectGroup[] = [
      { label: '默认角色', options: builtinCharacters },
    ]
    if (projectCards.value.length) {
      groups.push({
        label: `项目角色卡（${projectCards.value.length}）`,
        options: projectCards.value.map(card => ({
          value: card.id,
          label: card.catalogId ? `${card.name} · ${card.catalogId}` : card.name,
        })),
      })
    }
    if (importedCards.value.length) {
      groups.push({
        label: `导入的角色卡（${importedCards.value.length}）`,
        options: importedCards.value.map(card => ({
          value: card.id,
          label: card.name,
        })),
      })
    }
    const hasCurrent = character.value === 'nene' || character.value === 'natsume'
      || cardMap.value.has(character.value as `card-${string}`)
    if (!hasCurrent && character.value) {
      groups.push({
        label: '当前绑定',
        options: [{ value: character.value, label: '已绑定的角色卡' }],
      })
    }
    return groups
  })

  function botTitle(bot: QqChannelStatus): string {
    return bot.name.trim() || characterDisplayName(bot.character) || bot.appId || 'QQ 机器人'
  }

  return { botTitle, characterGroups, selectedCharacterName }
}

type ServiceStatusInputs = {
  chatProvider: Ref<QqChatProvider>
  chatGptStatus: Ref<ChatGptStatus | null>
  groupDrawing: Ref<boolean>
  voiceStatus: Ref<QqVoiceServiceStatus | null>
}

export function useQqServiceStatus({ chatProvider, chatGptStatus, groupDrawing, voiceStatus }: ServiceStatusInputs) {
  const usesChatGpt = computed(() => chatProvider.value === 'chatgpt' || chatProvider.value === 'chatgpt-private')

  const chatProviderHelp = computed(() => {
    if (chatProvider.value === 'chatgpt') return '群成员 @ 机器人也会使用你的订阅额度。'
    if (chatProvider.value === 'chatgpt-private') return '群聊使用主机 API / Ollama。'
    return ''
  })

  const chatGptNeedsAttention = computed(() => {
    const value = chatGptStatus.value
    if (!value) return false
    return !value.signedIn || !value.planEnabled || !value.selectedModel || value.usagePaused
  })

  const chatGptNotice = computed(() => {
    const value = chatGptStatus.value
    if (!value) return ''
    if (!value.signedIn) return '请登录 ChatGPT'
    if (!value.planEnabled) return '订阅权限待授权'
    if (!value.selectedModel) return '请选择 ChatGPT 模型'
    if (value.usagePaused) return '额度已达上限，发送已暂停'
    const activeAccount = value.accounts.find(account => account.active)
    const modelLabel = value.selectedModelName || value.selectedModel
    return activeAccount ? `${modelLabel} · ${activeAccount.label}` : modelLabel
  })

  const drawingHelp = computed(() => {
    if (chatProvider.value === 'default') return '需本机绘图模型和支持工具调用的 API。'
    if (chatProvider.value === 'chatgpt-private' && groupDrawing.value) return '需本机绘图模型。群聊绘图还需支持工具调用的 API。'
    return '需本机绘图模型。'
  })

  const voiceReady = computed(() => {
    const value = voiceStatus.value
    if (!value) return false
    return value.available ?? value.online
  })

  const voiceHasProfile = computed(() => {
    const voices = voiceStatus.value?.voices
    if (!voices) return true
    return Object.values(voices).some(Boolean)
  })

  const voiceNeedsAttention = computed(() => {
    const value = voiceStatus.value
    if (!value) return false
    return value.engineId === 'off'
      || value.engineId === 'system'
      || Boolean(value.clientSide)
      || !voiceReady.value
      || !voiceHasProfile.value
  })

  const voiceNotice = computed(() => {
    const value = voiceStatus.value
    if (!value) return ''
    if (value.engineId === 'off') return '语音已关闭'
    if (value.engineId === 'system' || value.clientSide) return '请选择云端或本机语音引擎'
    if (!voiceReady.value) return `${value.engine} 未就绪`
    if (!voiceHasProfile.value) return `${value.engine} 缺少可用声线`
    return value.online ? `${value.engine} 已就绪` : `${value.engine} 按需加载`
  })

  return { usesChatGpt, chatProviderHelp, chatGptNeedsAttention, chatGptNotice, drawingHelp, voiceNeedsAttention, voiceNotice }
}

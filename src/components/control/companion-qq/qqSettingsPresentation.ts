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
  { value: 'default', label: '保持原设（默认）' },
  { value: 'close', label: '亲近偏爱（认主）' },
  { value: 'intimate', label: '专属恋人（深度认主）' },
]
export const chatProviderOptions: ReadonlyArray<{ value: QqChatProvider; label: string }> = [
  { value: 'default', label: '主机 API / 本地 Ollama（默认）' },
  { value: 'chatgpt', label: 'ChatGPT 订阅额度' },
  { value: 'chatgpt-private', label: '仅私聊用 ChatGPT 订阅' },
]
export const voiceModeOptions: ReadonlyArray<{ value: QqVoiceMode; label: string }> = [
  { value: 'off', label: '关闭' },
  { value: 'on-demand', label: '按需发送（/语音 或对话要求）' },
  { value: 'auto', label: '每条回复附带语音' },
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

  const characterHelp = computed(() => {
    const total = projectCards.value.length + 2
    const importedNote = importedCards.value.length ? `及 ${importedCards.value.length} 张导入角色卡` : ''
    return `可直接搜索并选用项目内 ${total} 张角色卡${importedNote}；每个机器人拥有独立人设和聊天记忆。`
  })

  function botTitle(bot: QqChannelStatus): string {
    return bot.name.trim() || characterDisplayName(bot.character) || bot.appId || 'QQ 机器人'
  }

  return { botTitle, characterGroups, characterHelp, selectedCharacterName }
}

type ServiceStatusInputs = {
  chatProvider: Ref<QqChatProvider>
  chatGptStatus: Ref<ChatGptStatus | null>
  groupDrawing: Ref<boolean>
  voiceMode: Ref<QqVoiceMode>
  voiceStatus: Ref<QqVoiceServiceStatus | null>
}

export function useQqServiceStatus({ chatProvider, chatGptStatus, groupDrawing, voiceMode, voiceStatus }: ServiceStatusInputs) {
  const usesChatGpt = computed(() => chatProvider.value === 'chatgpt' || chatProvider.value === 'chatgpt-private')

  const chatProviderHelp = computed(() => {
    if (chatProvider.value === 'chatgpt') return '私聊和已绑定群聊都使用本机登录的 ChatGPT 订阅额度（支持绘图和语音工具调用）。群聊中群成员 @ 机器人也会消耗你的订阅额度。'
    if (chatProvider.value === 'chatgpt-private') return '仅已绑定的 QQ 私聊使用本机登录的 ChatGPT 订阅额度；已绑定群聊继续使用主机 API 或本地 Ollama。'
    return '优先使用角色房间保存的主机 API 配置；未配置时回退到本地 Ollama。'
  })

  const chatGptNeedsAttention = computed(() => {
    const value = chatGptStatus.value
    if (!value) return false
    return !value.signedIn || !value.planEnabled || !value.selectedModel || value.usagePaused
  })

  const chatGptNotice = computed(() => {
    const value = chatGptStatus.value
    if (!value) return ''
    if (!value.signedIn) return '尚未登录 ChatGPT 订阅账号，请先完成登录并选择模型。'
    if (!value.planEnabled) return '已登录 ChatGPT，但尚未开启订阅额度权限，请先完成授权。'
    if (!value.selectedModel) return '尚未选择 ChatGPT 模型，请先选好可用模型（例如 gpt-6-luna）。'
    if (value.usagePaused) return '当前 ChatGPT 订阅额度已达上限并暂停发送，请查看用量后恢复发送。'
    const activeAccount = value.accounts.find(account => account.active)
    const modelLabel = value.selectedModelName || value.selectedModel
    return activeAccount
      ? `当前已就绪：${activeAccount.label} · ${modelLabel}（在角色房间切换账号或模型后自动生效）。`
      : `当前已就绪：${modelLabel}（在角色房间切换账号或模型后自动生效）。`
  })

  const drawingHelp = computed(() => {
    const cardNote = '绑定项目角色卡后，让机器人画自己时会自动关联对应角色素材。'
    if (chatProvider.value === 'chatgpt') return `绘图需要本机绘图模型；ChatGPT 订阅已支持绘图工具调用。${cardNote}`
    if (chatProvider.value === 'chatgpt-private') {
      return groupDrawing.value
        ? `私聊绘图可通过 ChatGPT 订阅触发；群聊绘图仍需在角色房间保存主机 API，并准备好本机绘图模型。${cardNote}`
        : `私聊绘图需要本机绘图模型；ChatGPT 订阅已支持绘图工具调用。${cardNote}`
    }
    return `绘图需要支持工具调用的聊天 API（或改选 ChatGPT 订阅）和本机绘图模型。${cardNote}`
  })

  const voiceHelp = computed(() => {
    if (voiceMode.value === 'auto') return '每条文字回复后自动附带一条 QQ 语音，同时也支持发 /语音 朗读指定台词。'
    if (voiceMode.value === 'on-demand') return '私聊发 /语音（或直接对机器人说「发条语音」）时合成并发送 QQ 语音条。'
    return '关闭后仅发送文字和图片，不合成语音。'
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
    if (value.engineId === 'off') return '当前本机语音服务处于关闭状态，请先启用云端语音接口或本机角色语音。'
    if (value.engineId === 'system' || value.clientSide) return 'QQ 语音不支持浏览器系统朗读，请改用云端语音接口（OpenAI 兼容 TTS）或本机角色语音。'
    if (!voiceReady.value) return `当前语音引擎（${value.engine}）未就绪，请检查配置后再使用 QQ 语音。`
    if (!voiceHasProfile.value) return `当前语音引擎（${value.engine}）尚未配置可用声线，请先导入或填写声线。`
    if (!value.online && value.available) {
      return `当前本机语音引擎已配置：${value.engine}（首次发语音时会自动加载模型）。`
    }
    return `当前本机语音引擎已就绪：${value.engine}。`
  })

  return { usesChatGpt, chatProviderHelp, chatGptNeedsAttention, chatGptNotice, drawingHelp, voiceHelp, voiceNeedsAttention, voiceNotice }
}

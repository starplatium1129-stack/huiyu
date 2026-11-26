import { inferEmotion } from '@/utils/stream'
import { stripChatMarkupForSpeech } from '@/utils/chatMessageFormat'
import { getCompanionCharacter } from '@/utils/companionRegistry'
import { getCardSpriteRecord } from '@/utils/chatCardSprites'
import { extractStatusUpdate, type ChatSceneState } from '@/utils/chatSceneState'
import { generateCompanionImage } from './companionImageGeneration'
import { retainCompanionImageMessage } from './companionChatTools'
import type { ChatMessage } from './chatStorageTypes'
import type { CompanionChatImage } from '@/types/companionDrawing'

const EMOTION_VISUAL: Record<string, string> = {
  happy: 'warm happy smile, bright expressive eyes',
  gentle: 'soft affectionate smile, gentle relaxed gaze',
  shy: 'blushing cheeks, shy flustered expression',
  serious: 'focused serious expression, steady gaze',
  sad: 'melancholic downcast expression, vulnerable eyes',
  neutral: 'calm natural expression',
}

function buildVisualPrompt(args: {
  appearanceTags?: string
  emotion: string
  sceneState?: ChatSceneState
  contextHint?: string
}): string {
  const parts: string[] = ['cinematic anime cg illustration, expressive lighting, detailed background']
  if (args.appearanceTags?.trim()) parts.push(args.appearanceTags.trim())
  parts.push(EMOTION_VISUAL[args.emotion] || EMOTION_VISUAL.neutral)
  if (args.sceneState?.mood) parts.push(`atmosphere matching ${args.sceneState.mood}`)
  if (args.contextHint) parts.push(args.contextHint.slice(0, 180))
  return parts.join(', ')
}

export async function illustrateChatMessage(options: {
  characterId: string
  branchId: string
  characterName: string
  targetMessage: Pick<ChatMessage, 'mid' | 'content'>
  recentMessages: readonly Pick<ChatMessage, 'content'>[]
  sceneState?: ChatSceneState
  storage: {
    save(): boolean | undefined
    attachMessageImage(char: string, branch: string, mid: string, image: CompanionChatImage): boolean
  }
  signal: AbortSignal
  report?: (message: string) => void
}): Promise<CompanionChatImage> {
  const { characterId, branchId, characterName, targetMessage, recentMessages, sceneState, storage, signal, report } = options
  const companion = getCompanionCharacter(characterId)
  const catalogId = companion?.catalogId
  const isStudio = characterId === 'nene' || characterId === 'natsume'
  const drawCharacter = isStudio ? characterId : catalogId || characterId
  const unbound = !isStudio && !catalogId

  const spriteRecord = characterId.startsWith('card-') ? getCardSpriteRecord(characterId) : undefined
  if (unbound && !spriteRecord?.appearanceTags) {
    throw new Error('这张未绑定的角色卡还没有外观标签，请先在「表情差分」中反推或填写英文外观特征，再生成剧情插画。')
  }

  const cleanText = stripChatMarkupForSpeech(targetMessage.content).slice(0, 260)
  const statusHint = extractStatusUpdate(targetMessage.content)
  const emotion = statusHint?.mood || inferEmotion(cleanText, characterId)
  const recentSummary = recentMessages
    .slice(-3)
    .map(m => stripChatMarkupForSpeech(m.content).slice(0, 90))
    .filter(Boolean)
    .join(' / ')

  const sceneLines = [
    sceneState?.location ? `地点：${sceneState.location}` : '',
    sceneState?.outfit ? `穿着：${sceneState.outfit}` : '',
    recentSummary || cleanText,
  ].filter(Boolean)

  const visualDescription = buildVisualPrompt({
    appearanceTags: spriteRecord?.appearanceTags,
    emotion,
    sceneState,
    contextHint: cleanText,
  })

  report?.('正在为这段剧情绘制插画…')
  const result = await generateCompanionImage(
    {
      character: drawCharacter,
      description: `${characterName} 剧情插画：${sceneLines.join('；')}`.slice(0, 1200),
      visualDescription,
      allowUnbound: unbound,
    },
    {
      character: characterId,
      signal,
      report,
    },
  )

  const image: CompanionChatImage = {
    path: result.resultPath,
    name: `${characterName} · 剧情插画`,
    taskId: result.taskId,
    ...(result.imageId ? { imageId: result.imageId } : {}),
    ...(result.artworkId ? { artworkId: result.artworkId } : {}),
  }

  signal.throwIfAborted()
  if (!storage.attachMessageImage(characterId, branchId, targetMessage.mid, image)) {
    throw new Error('插画已生成，但未能写入该条消息记录，请到作品册查看。')
  }
  await retainCompanionImageMessage(storage, result.taskId)
  return image
}

import { interrogateImage } from '@/api/interrogateImage'
import { acknowledgeCompanionImage, generateCompanionImage } from './companionImageGeneration'
import {
  CARD_SPRITE_EMOTIONS,
  type CardSpriteEmotion,
} from '@/utils/chatCardSprites'
import type { CompanionChatImage } from '@/types/companionDrawing'

const EXCLUDE_TAG_PATTERN = /\b(smile|grin|blush|shy|cry|tears|sad|angry|serious|frown|happy|open mouth|closed eyes|looking at viewer|portrait|upper body|solo|1girl|1boy|simple background|white background|pastel background|indoors|outdoors)\b/i

export async function inferCardAppearanceTags(avatarUrl: string, signal: AbortSignal): Promise<string> {
  if (!avatarUrl || avatarUrl.endsWith('/logo.svg')) {
    throw new Error('当前角色卡没有可用的参考头像，请手动填写英文外观特征。')
  }
  const result = await interrogateImage(avatarUrl, signal)
  const filtered = result.tags
    .map(tag => tag.trim())
    .filter(tag => tag && !EXCLUDE_TAG_PATTERN.test(tag))
    .slice(0, 18)
  if (!filtered.length) {
    throw new Error('未能从头像中提取外观词条，请手动填写英文外观特征（例如 silver hair, violet eyes）。')
  }
  return filtered.join(', ')
}

export async function generateCardEmotionSprite(options: {
  cardId: string
  cardName: string
  catalogId?: string
  appearanceTags: string
  emotion: CardSpriteEmotion
  signal: AbortSignal
  onProgress?: (text: string) => void
}): Promise<CompanionChatImage> {
  const { cardId, cardName, catalogId, appearanceTags, emotion, signal, onProgress } = options
  const meta = CARD_SPRITE_EMOTIONS.find(item => item.id === emotion)
  if (!meta) throw new Error('未知的表情差分类型')
  const targetCharacter = catalogId || cardId
  const unbound = !catalogId && cardId !== 'nene' && cardId !== 'natsume'
  const tags = appearanceTags.trim()
  if (unbound && !tags) {
    throw new Error('这张角色卡未绑定素材库角色，请先点击“自动反推外观”或填写英文外观词条。')
  }
  const visualDescription = [tags, meta.prompt].filter(Boolean).join(', ')
  onProgress?.(`正在生成「${meta.label}」差分立绘…`)
  const result = await generateCompanionImage(
    {
      character: targetCharacter,
      description: `${cardName} ${meta.label} 表情立绘`,
      visualDescription,
      allowUnbound: unbound,
      noArtist: true,
    },
    {
      character: cardId,
      signal,
      report: onProgress,
    },
  )
  await acknowledgeCompanionImage(result.taskId)
  return {
    path: result.resultPath,
    name: `${cardName} · ${meta.label}立绘`,
    taskId: result.taskId,
    ...(result.imageId ? { imageId: result.imageId } : {}),
    ...(result.artworkId ? { artworkId: result.artworkId } : {}),
  }
}

export async function generateCardSpriteSet(options: {
  cardId: string
  cardName: string
  catalogId?: string
  appearanceTags: string
  emotions: readonly CardSpriteEmotion[]
  signal: AbortSignal
  onProgress?: (text: string) => void
  onSlotReady: (emotion: CardSpriteEmotion, image: CompanionChatImage) => void
}): Promise<number> {
  let generated = 0
  for (let index = 0; index < options.emotions.length; index += 1) {
    options.signal.throwIfAborted()
    const emotion = options.emotions[index]
    const meta = CARD_SPRITE_EMOTIONS.find(item => item.id === emotion)
    options.onProgress?.(`正在生成 ${meta?.label || emotion}（${index + 1}/${options.emotions.length}）…`)
    const image = await generateCardEmotionSprite({
      cardId: options.cardId,
      cardName: options.cardName,
      catalogId: options.catalogId,
      appearanceTags: options.appearanceTags,
      emotion,
      signal: options.signal,
      onProgress: options.onProgress,
    })
    options.onSlotReady(emotion, image)
    generated += 1
  }
  return generated
}

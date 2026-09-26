import { getCurrentScope, onScopeDispose, type Ref } from 'vue'
import type { ShotDraft } from './shotListTypes'
import type { ReferenceCard } from './useReferenceCards'
import { useVideoStore } from '@/stores/videoStore'
import { artworkRepository } from '@/storage/artworkRepository'
import { uploadVideoImage } from '@/api/videoApi'
import { getCharacterReferences } from '@/utils/characterReferenceData'

/**
 * 分镜编辑器·绘图页镜头导入（2026-09-06 自 ShotListEditor 下沉，体验报告 F4）。
 *
 * 旧实现的三个真实痛点：
 * 1. 导入开始即 clearShotsCtx——待办先清空，首帧失败也报「全部挂载成功」；
 * 2. 图片失败走空 catch 仍计入 imported，用户不知道缺了什么；
 * 3. 角色参考卡装配不带服装参数，图是角色 A 的特典服装，参考卡却是默认服装（F3）。
 *
 * 现在：先窥视待办 → 逐镜建草稿并单独确认首帧 → 全部处理完才消费待办；
 * 首帧失败的镜头保留 sourceImageId（= 草稿 imageId）可单独重试；
 * 参考卡按「角色 + 服装」对装配，同一角色多服装各占一卡槽。
 */

export interface ShotImportDeps {
  shots: Ref<ShotDraft[]>
  identityCard: Ref<string>
  referenceCards: Ref<ReferenceCard[]>
  /** 装配指定卡槽的角色参考图（返回成功装配的张数）。 */
  autoLoadCharacterReferences: (charId: string, cardIndex?: number, outfitId?: string) => Promise<number>
  /** 热门角色身份散文兜底（参考档案缺失时）。 */
  popularIdentityProse: (charId: string) => string
}

export interface ShotImportOutcome {
  imported: number
  framesReady: number
  framesPending: number
  /** 本次新装配参考卡的角色数与失败数。 */
  refCardsAssembled: number
  refCardsFailed: number
}

/** 参数自动推断：按描述关键词选景别/镜头/主体运动（中英文都认）。 */
export function inferShotParams(prompt: string): {
  shotSize: ShotDraft['shotSize']
  camera: ShotDraft['camera']
  motion: ShotDraft['motion']
} {
  const text = String(prompt || '')
  let shotSize: ShotDraft['shotSize'] = ''
  if (/(特写|近景|大头|close-?up|face\s*shot|macro|脸部)/i.test(text)) shotSize = 'closeup'
  else if (/(全景|远景|全身|wide\s*shot|establishing|full\s+body|long\s*shot)/i.test(text)) shotSize = 'wide'
  else if (/(中景|腰部|medium\s*shot|waist)/i.test(text)) shotSize = 'medium'

  let camera: ShotDraft['camera'] = 'still'
  if (/(推进|推近|推入|推镜|push\s*in|zoom\s*in|dolly\s*in|前推)/i.test(text)) camera = 'push'
  else if (/(拉远|拉近|拉镜|拉出|pull\s*(?:out|back)|zoom\s*out|dolly\s*out)/i.test(text)) camera = 'pull'
  else if (/(横移|平移|摇镜|pan(?:ning)?|tracking|跟拍)/i.test(text)) camera = 'pan'
  else if (/(环绕|环绕镜头|orbit|arc\s*around|绕行)/i.test(text)) camera = 'orbit'

  let motion: ShotDraft['motion'] = 'subtle'
  if (/(表现力|夸张|激烈|戏剧|爆发|expressive|dramatic|intense|energetic)/i.test(text)) motion = 'expressive'
  else if (/(转身|回头|回望|回眸|奔跑|跑向|跑进|跑出|走向|走进|走出|走到|坐下|躺下|站起|起身|跳跃|跳起|跳向|起舞|挥手|挥动|举起|拿起|放下|端起|推开|拉开|打开|关上|翻页|弹奏|歌唱|呼喊|微笑|轻笑|大笑|哭泣|仰望|俯身|弯腰|行走|跑动|迈步|踱步|跪下|拥抱|亲吻|抬头|低头|转头|伸手|捡起|拾起|抱起|\bmov(?:e|es|ed|ing)\b|\bwalk(?:s|ed|ing)\b|\brun(?:s|ning)\b|\bjump(?:s|ed|ing)\b|\bturn(?:s|ed|ing)\b|\brais(?:e|es|ed|ing)\b|\breach(?:es|ed|ing)\b|\bstand(?:s|ing)\b|\bsit(?:s|ting)\b|\bdanc(?:e|es|ed|ing)\b|\blift(?:s|ed|ing)\b|\bplac(?:e|es|ed|ing)\b|\bopen(?:s|ed|ing)\b|\bclos(?:e|es|ed|ing)\b|\bwav(?:e|es|ed|ing)\b|\bgrab(?:s|bed|bing)\b|\bstep(?:s|ped|ping)\b|\blean(?:s|ed|ing)\b|\bbend(?:s|ing)\b|\bkneel(?:s|ing)\b|\bbow(?:s|ing)\b|\bnod(?:s|ded|ding)\b|\bsmil(?:e|es|ed|ing)\b|\blaugh(?:s|ed|ing)\b|\bwhisper(?:s|ed|ing)\b|\bspeak(?:s|ing)\b|\bsay(?:s|ing)\b|\bsing(?:s|ing)\b|\bsigh(?:s|ed|ing)\b)/i.test(text)) motion = 'natural'
  return { shotSize, camera, motion }
}

function readBlobAsDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(reader.error ?? new Error('图片读取失败'))
    reader.readAsDataURL(blob)
  })
}

export function useShotImport(deps: ShotImportDeps) {
  const { shots, identityCard, referenceCards } = deps
  const videoStore = useVideoStore()
  let disposed = false
  if (getCurrentScope()) onScopeDispose(() => { disposed = true })

  /** 单镜首帧挂载：IndexedDB 取 blob → 上传换受控文件名 → 本地预览。 */
  async function mountShotFrame(shot: ShotDraft, imageId: string): Promise<boolean> {
    try {
      const blob = await artworkRepository.getImage(imageId)
      if (!blob || !blob.size) return false
      const dataUrl = await readBlobAsDataURL(blob)
      const comma = dataUrl.indexOf(',')
      if (comma < 0) return false
      const upload = await uploadVideoImage(dataUrl.slice(comma + 1))
      if (disposed) return false
      if (shot.imageUrl) URL.revokeObjectURL(shot.imageUrl)
      shot.imageName = upload.name
      shot.imageUrl = URL.createObjectURL(blob)
      return true
    } catch {
      return false
    }
  }

  /**
   * 只重试首帧缺失的镜头（有 imageId 无 imageName）：导入失败/草稿恢复图失效
   * 后的精确补救入口，不重跑整轮导入。
   */
  async function retryPendingFrames(): Promise<{ fixed: number; remaining: number }> {
    let fixed = 0
    let remaining = 0
    for (const shot of shots.value) {
      if (!shot.imageId || shot.imageName) continue
      if (await mountShotFrame(shot, shot.imageId)) fixed += 1
      else remaining += 1
    }
    return { fixed, remaining }
  }

  async function importShotsFromDrawing(): Promise<ShotImportOutcome | null> {
    // 先窥视不消费：全部处理完才一次性取走，中途离开/异常不丢待办（F4）。
    const list = [...videoStore.pendingShotCtxs]
    if (!list.length) return null

    // 1. 参考卡按「角色 + 服装」对去重保序（同一角色多服装各占一卡槽，F3）；
    //    已有匹配卡（草稿恢复/此前装配）直接复用，不重复装配。
    const pairs: Array<{ characterId: string; outfitId: string }> = []
    for (const ctx of list) {
      if (!ctx.characterId) continue
      const outfitId = ctx.outfitId ?? ''
      if (!pairs.some(pair => pair.characterId === ctx.characterId && pair.outfitId === outfitId)) {
        pairs.push({ characterId: ctx.characterId, outfitId })
      }
    }
    const pairCardIndex = new Map<string, number>()
    const pairKey = (characterId: string, outfitId: string) => `${characterId}::${outfitId}`
    const assembly: Array<{ charId: string; cardIndex: number; outfitId: string }> = []
    for (const pair of pairs.slice(0, 4)) {
      const existing = referenceCards.value.findIndex(
        card => card.characterId === pair.characterId && (card.outfitId || '') === pair.outfitId && card.images.length > 0,
      )
      if (existing >= 0) { pairCardIndex.set(pairKey(pair.characterId, pair.outfitId), existing); continue }
      let cardIndex = referenceCards.value.findIndex(card => !card.characterId && !card.images.length && !card.label)
      if (cardIndex < 0 && referenceCards.value.length < 4) {
        referenceCards.value.push({ label: '', images: [] })
        cardIndex = referenceCards.value.length - 1
      }
      if (cardIndex < 0) continue
      // 异步装配之前占住卡槽，避免多个角色都选择同一张空卡。
      referenceCards.value[cardIndex].characterId = pair.characterId
      referenceCards.value[cardIndex].outfitId = pair.outfitId
      pairCardIndex.set(pairKey(pair.characterId, pair.outfitId), cardIndex)
      assembly.push({ charId: pair.characterId, cardIndex, outfitId: pair.outfitId })
    }

    // 2. 并行装配参考卡（携带服装参数），逐卡记成败。
    const assembled = await Promise.all(assembly.map(async item => {
      try {
        const count = await deps.autoLoadCharacterReferences(item.charId, item.cardIndex, item.outfitId || undefined)
        return count > 0
      } catch { return false }
    }))
    const refCardsAssembled = assembled.filter(Boolean).length
    const refCardsFailed = assembled.length - refCardsAssembled
    if (disposed) return null

    // 3. 身份锚点：首位出场角色的标准人设（不覆盖用户已写内容）。
    if (!identityCard.value && pairs.length > 0) {
      const first = pairs[0]
      const stdProfile = getCharacterReferences(first.characterId)
      identityCard.value = stdProfile?.identityProse || deps.popularIdentityProse(first.characterId) || identityCard.value
    }

    // 4. 逐镜建草稿并单独确认首帧：失败的镜头照常带入（文本不丢），
    //    imageId 留在草稿上，供「重试首帧」精确补救。
    let framesReady = 0
    let framesPending = 0
    for (const ctx of list) {
      const inferred = inferShotParams(ctx.prompt || '')
      const key = ctx.characterId ? pairKey(ctx.characterId, ctx.outfitId ?? '') : ''
      const cardIndex = key ? pairCardIndex.get(key) : undefined
      const draft: ShotDraft = {
        prompt: ctx.prompt || '',
        dialogue: '',
        shotSize: inferred.shotSize,
        camera: inferred.camera,
        motion: inferred.motion,
        duration: 5,
        seedText: '',
        imageName: '',
        imageUrl: '',
        cast: (cardIndex !== undefined ? String(cardIndex + 1) : '') as ShotDraft['cast'],
        imageId: ctx.imageId,
      }
      if (await mountShotFrame(draft, ctx.imageId)) framesReady += 1
      else framesPending += 1
      if (disposed) return null
      shots.value.push(draft)
    }

    // 5. 全部落位后才消费待办（一次性语义保持不变，但不再有「先清后败」）。
    videoStore.stageShotCtxs(videoStore.pendingShotCtxs.filter(ctx => !list.includes(ctx)))
    return { imported: list.length, framesReady, framesPending, refCardsAssembled, refCardsFailed }
  }

  return { importShotsFromDrawing, retryPendingFrames, mountShotFrame }
}

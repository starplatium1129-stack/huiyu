import type { VideoCtxPayload, VideoDraftPayload, StagedScenarioAct, ShotsDraftPayload, ShotsDraftShot } from '@/stores/videoStore'
import { readFirstFrameRequest, type FirstFrameRequest } from '@/types/firstFrameRequest'
import { readStoryOrigin } from '@/types/storyOrigin'

type RecordValue = Record<string, unknown>
function object(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('记录结构无效')
  return value as RecordValue
}
function text(value: unknown, fallback = ''): string {
  if (value === undefined) return fallback
  if (typeof value !== 'string') throw new Error('文字字段无效')
  return value
}
function number(value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('时间字段无效')
  return value
}
function choice<T extends string | number>(value: unknown, values: readonly T[], fallback: T): T {
  if (value === undefined) return fallback
  if (!values.includes(value as T)) throw new Error('选项已无法识别')
  return value as T
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('列表结构无效')
  return value
}
function origin(value: unknown) {
  if (value !== undefined) {
    const v = object(value)
    for (const [key, limit] of [['outfitId', 200], ['outfitProse', 2000]] as const) {
      if (v[key] !== undefined && (typeof v[key] !== 'string' || v[key].length > limit)) throw new Error('剧本服装来源无效')
    }
  }
  const result = readStoryOrigin(value)
  if (value !== undefined && !result) throw new Error('剧本来源无效')
  return result
}
function identity(value: unknown): string {
  const id = text(value)
  if (!id) throw new Error('请求或来源编号缺失')
  return id
}
const nullableText = (value: unknown) => value == null ? null : text(value)
const cameras = ['still', 'push', 'pull', 'pan', 'orbit'] as const
const motions = ['subtle', 'natural', 'expressive'] as const
const durations = [3, 5, 10, 15] as const
function dimensions(v: RecordValue) {
  return { aspectRatio: choice(v.aspectRatio, ['landscape', 'portrait', 'square', 'original'], 'landscape'),
    quality: choice(v.quality, ['fast', 'standard', 'fine'], 'standard'), steps: choice(v.steps, [4, 8], 8),
    updatedAt: number(v.updatedAt, 0) }
}
function shot(value: unknown): ShotsDraftShot {
  const v = object(value)
  const submission = v.submission === undefined ? undefined : object(v.submission)
  if (submission && (!text(submission.batchId) || !Number.isSafeInteger(submission.shotIndex) || Number(submission.shotIndex) < 0)) throw new Error('镜头任务编号无效')
  return {
    prompt: text(v.prompt), dialogue: text(v.dialogue), shotSize: choice(v.shotSize, ['', 'wide', 'medium', 'closeup'], ''),
    camera: choice(v.camera, cameras, 'still'), motion: choice(v.motion, motions, 'subtle'),
    duration: choice(v.duration, durations, 5), seedText: text(v.seedText), cast: text(v.cast), imageId: text(v.imageId),
    storyOrigin: origin(v.storyOrigin),
    ...(v.firstFramePrompt === undefined ? {} : { firstFramePrompt: text(v.firstFramePrompt) }),
    ...(v.firstFrameRequest === undefined ? {} : { firstFrameRequest: readFirstFrameRequest(v.firstFrameRequest as FirstFrameRequest) }),
    ...(submission ? { submission: { batchId: text(submission.batchId), shotIndex: Number(submission.shotIndex) } } : {}),
    ...Object.fromEntries(['submissionToken', 'importSourceImageId', 'importSourceActId'].flatMap(key => v[key] === undefined ? [] : [[key, identity(v[key])]])),
  }
}
export const videoDraftCodec = {
  context(value: unknown): VideoCtxPayload {
    const v = object(value), imageId = text(v.imageId)
    if (!imageId) throw new Error('原图编号缺失')
    return { imageId, prompt: text(v.prompt), story: text(v.story), characterId: text(v.characterId),
      blueprintId: nullableText(v.blueprintId), outfitId: nullableText(v.outfitId), sceneId: nullableText(v.sceneId), storyOrigin: origin(v.storyOrigin) }
  },
  contexts(value: unknown): VideoCtxPayload[] { return list(value).map(videoDraftCodec.context) },
  acts(value: unknown): StagedScenarioAct[] {
    return list(value).map(value => {
      const v = object(value)
      if (!text(v.characterId)) throw new Error('角色编号缺失')
      return { prompt: text(v.prompt), characterId: text(v.characterId), dialogue: text(v.dialogue),
        shotSize: choice(v.shotSize, ['wide', 'medium', 'closeup'], 'medium'),
        camera: choice(v.camera, cameras, 'still'), motion: choice(v.motion, motions, 'subtle'),
        duration: choice(v.duration, durations, 3), storyOrigin: origin(v.storyOrigin),
        ...(v.importId === undefined ? {} : { importId: identity(v.importId) }) }
    })
  },
  video(value: unknown): VideoDraftPayload {
    const v = object(value)
    if (typeof v.mode !== 'string' || typeof v.prompt !== 'string') throw new Error('视频草稿缺少模式或画面描述')
    return { ...dimensions(v), mode: choice(v.mode, ['text', 'image', 'first-last-frame', 'shots'], 'text'),
      prompt: text(v.prompt), negative: text(v.negative), modelId: text(v.modelId),
      camera: choice(v.camera, cameras, 'still'), motion: choice(v.motion, motions, 'subtle'),
      duration: choice(v.duration, durations, 5), seedText: text(v.seedText), videoImageId: text(v.videoImageId), lastFrameImageId: text(v.lastFrameImageId),
      ...(v.importSourceImageId === undefined ? {} : { importSourceImageId: identity(v.importSourceImageId) }) }
  },
  shots(value: unknown): ShotsDraftPayload {
    const v = object(value)
    if (v.linkLastFrame !== undefined && typeof v.linkLastFrame !== 'boolean') throw new Error('尾帧衔接选项无效')
    return { ...dimensions(v), linkLastFrame: v.linkLastFrame !== false, identityCard: text(v.identityCard),
      cards: list(v.cards).map(value => { const card = object(value); return { label: text(card.label), characterId: text(card.characterId), outfitId: text(card.outfitId),
        ...(card.outfitProseOverride === undefined ? {} : { outfitProseOverride: text(card.outfitProseOverride) }) } }),
      shots: list(v.shots).map(shot),
      ...(v.scenarioImportReceipts === undefined ? {} : { scenarioImportReceipts: list(v.scenarioImportReceipts).map(identity) }) }
  },
}
/** Keep media-reference fields at the root for backup/cleanup readers. */
export function decodeVideoDraft<T>(raw: string, decode: (value: unknown) => T): T {
  const value: unknown = JSON.parse(raw)
  if (value && typeof value === 'object' && !Array.isArray(value) && '_videoDraftVersion' in value) {
    if (value._videoDraftVersion !== 1) throw new Error('草稿版本较新，请更新应用')
  }
  return decode(value)
}

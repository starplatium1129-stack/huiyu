import { runtimeFetch } from '../../platform/runtimeUrl.ts'
import type { Ref } from 'vue'
import type { HistoryEntry } from '../../stores/promptBuilderStore'
import type { AnimaResult, AnimaResultContext } from '../../types/anima'
import type { SDQueueJob } from '../generation/useSDQueue'
import type { TempResultRecord } from '../../utils/tempResult'
import type { TempResultDeps } from './useTempResult'

interface ResultActionOwner {
  pb: TempResultDeps['pb']
  displayedResultHistoryId: Ref<string | number | null>
  captureTemp(partial: Omit<TempResultRecord, 'imageId' | 'savedAt'>, blob: Blob, url: string, current: () => boolean): Promise<void>
  releaseTemp(): void
}
interface AnimaAutomaticInput {
  result: AnimaResult
  context: AnimaResultContext | null
  current: () => boolean
  history: Partial<HistoryEntry>
  story: string
  scene: TempResultDeps['pb']['sceneId']
  autoSave: boolean
  runtimeTaskId?: string
}
interface SdAutomaticInput {
  job: Omit<SDQueueJob, 'id'>
  url: string
  seed: number | null
  context: AnimaResultContext | null
  current: () => boolean
  autoSave: boolean
  save: Promise<HistoryEntry | null> | null
}

/** Automatic completion actions load only after a result arrives. */
export async function handleAnimaResultAction(input: AnimaAutomaticInput, owner: ResultActionOwner) {
  const { result, current, context: frozen, history, story, scene, autoSave, runtimeTaskId } = input
  const { pb, displayedResultHistoryId, captureTemp, releaseTemp } = owner
  if (!autoSave) {
    if (current()) displayedResultHistoryId.value = null
    await captureTemp({
      engine: result.metadata.engine,
      prompt: result.metadata.prompt,
      negative: result.metadata.negative,
      seed: result.metadata.seed,
      size: `${result.metadata.width}x${result.metadata.height}`,
      animaMetadata: result.metadata,
      context: frozen,
    }, result.blob, result.url, current)
    return
  }
  try {
    if (!result.blob.size) throw new Error('成片数据为空')
    // initImage 非空即 inpaint 重绘：parent_id 回指来源条目，作品册对比才有
    // 「重绘前 vs 重绘后」的真实语义（P1-14）。
    const isInpaint = Boolean(result.metadata.initImage)
    const saved = await pb.commitHistoryEntry({
      taskId: runtimeTaskId,
      context: frozen,
      blob: result.blob,
      seed: result.metadata.seed,
      negative: result.metadata.negative ?? '',
      prompt: result.metadata.prompt,
      ...history,
      // F3：入册字段跟随出图时的冻结上下文，不随生成期间的表单改动漂移。
      story: frozen?.story ?? story,
      scene: frozen ? (frozen.sceneId ?? null) : scene,
      hiresFix: result.metadata.hiresFix === true,
      hiresScale: typeof result.metadata.hiresScale === 'number' ? result.metadata.hiresScale : undefined,
      hiresDenoise: typeof result.metadata.hiresDenoise === 'number' ? result.metadata.hiresDenoise : undefined,
      parentId: isInpaint ? frozen?.parentId : undefined,
    })
    if (!saved) throw new Error('作品册写入失败')
    if (current()) {
      displayedResultHistoryId.value = saved.id
      releaseTemp()
      pb.flash('已自动存入作品册')
    }
  } catch (e) {
    console.warn('anima direct autosave failed', e)
    if (!current()) return
    pb.flash('自动入册失败：成片已保留在临时缓冲，可手动点「存入作品册」')
    await captureTemp({
      engine: result.metadata.engine,
      prompt: result.metadata.prompt,
      negative: result.metadata.negative,
      seed: result.metadata.seed,
      size: `${result.metadata.width}x${result.metadata.height}`,
      animaMetadata: result.metadata,
      context: frozen,
    }, result.blob, result.url, current)
  }
}


export async function handleSdResultAction(input: SdAutomaticInput, owner: ResultActionOwner) {
  const { job, url, current, seed, context, autoSave, save } = input
  const { pb, displayedResultHistoryId, captureTemp, releaseTemp } = owner
  if (!autoSave) {
    if (current()) displayedResultHistoryId.value = null
    try {
      const blob = await (await runtimeFetch(url, { cache: 'no-store' })).blob()
      if (blob.size) {
        await captureTemp({
          engine: 'sd',
          prompt: job.prompt,
          negative: job.negative,
          seed,
          size: job.size,
          animaMetadata: null,
          context,
        }, blob, url, current)
      }
    } catch (error) {
      console.warn('[temp-result] sd capture failed', error)
    }
    return
  }
  try {
    const saved = await save
    if (!saved) throw new Error('作品册写入失败')
    if (current()) {
      displayedResultHistoryId.value = saved.id
      releaseTemp()
      pb.flash('已自动存入作品册')
    }
  } catch (e) {
    console.warn('direct autosave failed', e)
    if (!current()) return
    pb.flash('自动入册失败，可手动点「存入作品册」')
    try {
      const blob = await (await runtimeFetch(url)).blob()
      await captureTemp({ engine: 'sd', prompt: job.prompt, negative: job.negative,
        seed, size: job.size, context }, blob, url, current)
    } catch { if (current()) pb.flash('临时保存也未成功，请下载当前原图') }
  }
}

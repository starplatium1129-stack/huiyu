import { ref, watch, type ComputedRef, type Ref } from 'vue'
import { usePromptBuilderStore, type HistoryEntry } from '@/stores/promptBuilderStore'
import type { DrawEngine } from '@/storage/settingsRepository'
import type { SdResultSnapshot } from './sdResultActions'
import { SD_QUEUE_SNAPSHOT_KEY } from '@/utils/storageKeys'
import { classifySDError, type SDErrorReport } from '@/utils/sdError'
import type { useAnimaSession } from '@/composables/generation/useAnimaSession'
import type { useSDGenerate } from '@/composables/generation/useSDGenerate'
import type { usePromptAssembly } from '@/composables/prompt/usePromptAssembly'
import { useSDQueue, type SDQueueJob } from '@/composables/generation/useSDQueue'
import type { AnimaResultContext } from '@/types/anima'
import { captureResultContext } from '@/utils/resultContext'
import { hasRuntimeTasks } from '@/api/runtimeTaskAuthority'
import { profileLocalStorage as localStorage } from '@/platform/web/profileStorage'

type PromptBuilderStore = ReturnType<typeof usePromptBuilderStore>
type AnimaSession = ReturnType<typeof useAnimaSession>
type PromptAssembly = ReturnType<typeof usePromptAssembly>

export interface PromptSdQueueDeps {
  pb: PromptBuilderStore
  sd: ReturnType<typeof useSDGenerate>
  sdSize: Ref<string>
  drawEngine: Ref<DrawEngine>
  /** 面板实时组装的提示词（studio 路径；批量/热门另有组装）。 */
  livePrompt: ComputedRef<string>
  negativePrompt: PromptAssembly['negativePrompt']
  effectiveScene: PromptAssembly['effectiveScene']
  loraSpecs: PromptAssembly['loraSpecs']
  modelProfile: PromptAssembly['modelProfile']
  animaState: AnimaSession['state']
  displayResultSeed: ComputedRef<number | null>
  /**
   * SD 直出/队列成功时写入冻结上下文（2026-09-06 体验报告 F3）：
   * captureJob 快照的场景与故事跟随成片，跨页交接不读当前表单。
   */
  setResultContext?: (ctx: AnimaResultContext | null) => void
}

/**
 * 绘图页「SD 出图任务执行 + 队列」簇（2026-08-22 自 PromptBuilderView 下沉）。
 *
 * 一条执行路径三处消费：直出（callGenerate）、队列（useSDQueue 串行）、
 * 批量（usePromptBatchRunners 注入 runJob）。含：面板状态 → 任务快照
 * （captureJob）、直出高分自动挂双 ADetailer（runJob）、队列产出自动入册
 * 历史、错误分类报告（sdErrorReport）与 3-Seed 候选变体入队。
 * Anima/Krea 直出与错误恢复动作（runRecovery）仍归宿主视图。
 */
export function usePromptSdQueue(deps: PromptSdQueueDeps) {
  const { pb, sd, sdSize, drawEngine, livePrompt, negativePrompt, effectiveScene, loraSpecs, modelProfile, animaState } = deps

  const sdErrorReport = ref<SDErrorReport | null>(null)
  function dismissError() { sdErrorReport.value = null }

  /**
   * 队列快照持久化（2026-08-30 UX 审计 P0-5）。
   *
   * 队列此前只活在 PromptBuilderView 作用域：离开页面（onUnmounted→dispose→
   * cancel）或刷新，pending 队列整组蒸发且无任何解释。现在 pending 任务实时
   * 落 localStorage，回到绘图页时恢复（置暂停，不自动开跑）；在途任务不保
   * 留——它已被真实取消，恢复一个早已死掉的 jobId 只会误导。
   */
  function readQueueSnapshot(): SDQueueJob[] {
    if (hasRuntimeTasks()) return []
    try {
      const raw = localStorage.getItem(SD_QUEUE_SNAPSHOT_KEY)
      if (!raw) return []
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed.filter((job): job is SDQueueJob =>
        Boolean(job) && typeof job === 'object' && typeof (job as SDQueueJob).id === 'string')
    } catch { return [] }
  }

  function persistQueueSnapshot(jobs: readonly SDQueueJob[]) {
    if (hasRuntimeTasks()) return
    try {
      if (!jobs.length) { localStorage.removeItem(SD_QUEUE_SNAPSHOT_KEY); return }
      localStorage.setItem(SD_QUEUE_SNAPSHOT_KEY, JSON.stringify(jobs))
    } catch { /* 快照写失败不阻断出图主链路 */ }
  }

  // 注意：watch 的 getter 在建立依赖时就会被立即执行一次，restore 也是同步调用
  // ——两者都读 sdQueue，而 sdQueue 是下方 useSDQueue(...) 的 const 声明，必须
  // 等它初始化之后才能挂（否则命中 TDZ，整个导演台在 setup 阶段就抛错）。
  // 因此这两个调用放在文件末尾的「队列接线」处，不要因为读起来更顺就往上挪。

  /** 把当前导演台状态快照成一个队列任务 */
  function captureJob(): Omit<SDQueueJob, 'id'> | null {
    if (!livePrompt.value) return null
    const params = pb.sdParams
    const scene = effectiveScene.value
    const story = String(pb.story || '').trim()
    const context = captureResultContext(pb)
    context.history = { ...context.history, profile: modelProfile.value?.id || '' }
    return {
      context,
      title: scene?.title || (story ? story.slice(0, 28) : (pb.char === 'natsume' ? '夏目构图' : '宁宁构图')),
      prompt: livePrompt.value,
      negative: negativePrompt.value,
      sceneId: pb.sceneId,
      sceneTitle: scene?.title || '',
      char: pb.char,
      story,
      size: sdSize.value,
      seed: params.seedLock && params.seed >= 0 ? params.seed : -1,
      cfg: params.cfg,
      steps: params.steps,
      sampler: params.sampler,
      scheduler: params.scheduler || '',
      checkpoint: pb.sdModelName || sd.checkpoint.value || '',
      lora: loraSpecs.value.map(spec => `${spec.name}:${spec.weight}`).join(', '),
      hiresFix: params.hiresFix,
      hiresScale: params.hiresScale,
      hiresUpscaler: params.hiresUpscaler,
      hiresSteps: params.hiresSteps,
      denoisingStrength: params.hiresDenoise,
      faceDetailer: params.faceDetailer,
    }
  }

  function historyGenerationFields(): Partial<HistoryEntry> {
    if (drawEngine.value !== 'sd') {
      const meta = animaState.value.result?.metadata || animaState.value.job
      if (!meta) return {}
      return {
        engine: meta.engine,
        profile: meta.profileId,
        model: meta.modelId,
        lora: meta.loraId,
        loraId: meta.loraId,
        loraStrength: meta.loraStrength,
        loras: meta.loras,
        styleLoraId: meta.styleLoraId ?? null,
        preview: meta.preview === true,
        cfg: meta.cfg,
        steps: meta.steps,
        sampler: meta.sampler,
        scheduler: meta.scheduler,
        size: `${meta.width}x${meta.height}`,
        // 2026-08-29：Anima/Krea 的 hires 实参回显（元数据仅有 fix/scale/denoise；
        // 无则显式 false，避免兜底到 SD 面板值）。
        hiresFix: meta.hiresFix === true,
        hiresScale: typeof meta.hiresScale === 'number' ? meta.hiresScale : undefined,
        hiresDenoise: typeof meta.hiresDenoise === 'number' ? meta.hiresDenoise : undefined,
      }
    }
    const params = pb.sdParams
    const model = pb.sdModelName || sd.checkpoint.value || ''
    const loras = sd.lastLoras.value
    return {
      engine: 'sd',
      provider: sd.provider.value || 'webui',
      profile: modelProfile.value?.id || '',
      model,
      loraId: loras[0]?.id || null,
      loraStrength: loras[0]?.strength ?? null,
      loras,
      cfg: params.cfg,
      steps: params.steps,
      sampler: params.sampler,
      scheduler: params.scheduler,
      size: sdSize.value,
      // 2026-08-29：SD 高清修复/脸部修复实参落库（作品册回显 hires 开关）。
      hiresFix: params.hiresFix,
      hiresScale: params.hiresScale,
      hiresUpscaler: params.hiresUpscaler,
      hiresSteps: params.hiresSteps,
      hiresDenoise: params.hiresDenoise,
      faceDetailer: params.faceDetailer,
    }
  }

  function buildSingleDetailerScripts(): Record<string, unknown> {
    const passes: Array<[string, string, string, number, number]> = [
      ['face_yolov8s.pt', 'detailed eyes, clean face, character-accurate facial features',
        'deformed face, asymmetrical eyes, cross-eyed', 0.35, 0.18],
      ['hand_yolov8n.pt', 'detailed hands, five fingers, natural fingers',
        'extra fingers, missing fingers, fused fingers, malformed hands', 0.3, 0.16],
    ]
    return { ADetailer: { args: [true, false, ...passes.map(([model, prompt, negative, confidence, denoise]) => ({
      ad_model: model, ad_prompt: prompt, ad_negative_prompt: negative,
      ad_confidence: confidence, ad_denoising_strength: denoise,
      ad_inpaint_only_masked: true, ad_inpaint_only_masked_padding: 32,
      ad_use_inpaint_width_height: true, ad_inpaint_width: 768, ad_inpaint_height: 768, is_api: true,
    }))] } }
  }

  // Preserve result facts independently of the current form and later results.
  const completedJobs = new WeakMap<Omit<SDQueueJob, 'id'>, SdResultSnapshot>()
  function jobResultContext(job: Omit<SDQueueJob, 'id'>): AnimaResultContext {
    return {
      ...job.context, characterId: '', outfitId: null, blueprintId: null,
      sceneId: job.sceneId ?? null, story: job.story, char: job.char,
      history: {
        ...job.context?.history, sceneTitle: job.sceneTitle || null,
        engine: 'sd', model: job.checkpoint, cfg: job.cfg, steps: job.steps,
        sampler: job.sampler, scheduler: job.scheduler, size: job.size,
        lora: job.lora || null,
        negative: job.negative, hiresFix: job.hiresFix, hiresScale: job.hiresScale,
        hiresUpscaler: job.hiresUpscaler, hiresSteps: job.hiresSteps,
        hiresDenoise: job.denoisingStrength, faceDetailer: job.faceDetailer,
      },
    }
  }

  /** 执行一个任务（队列与直接出图共用同一条路径） */
  async function runJob(job: Omit<SDQueueJob, 'id'>, opts: { disableLora?: boolean } = {}) {
    // Recovery edits and later form/queue mutations must not rewrite result facts.
    const submitted = JSON.parse(JSON.stringify(job)) as Omit<SDQueueJob, 'id'>
    if (opts.disableLora) {
      submitted.prompt = submitted.prompt.replace(/<lora:[^>]+>\s*,?\s*/gi, '').trim().replace(/,\s*$/, '')
      submitted.lora = undefined
    }
    const context = jobResultContext(submitted)
    const [w, h] = String(submitted.size).split('x').map(Number)
    const directHighResolution = !submitted.hiresFix && (w || 832) * (h || 1216) > 1_500_000
    const alwaysonScripts = submitted.faceDetailer && submitted.char !== 'triad' && directHighResolution
      ? buildSingleDetailerScripts()
      : undefined

    const url = await sd.generate({
      runtimeContext: context as Record<string, unknown>,
      prompt: submitted.prompt,
      negative_prompt: submitted.negative,
      width: w || 832,
      height: h || 1216,
      cfg_scale: submitted.cfg,
      steps: submitted.steps,
      sampler_name: submitted.sampler,
      scheduler: submitted.scheduler || undefined,
      hr_fix: submitted.hiresFix,
      hr_scale: submitted.hiresScale,
      hr_upscaler: submitted.hiresUpscaler,
      hr_second_pass_steps: submitted.hiresSteps,
      denoising_strength: submitted.denoisingStrength,
      seed: submitted.seed,
      model: submitted.checkpoint || undefined,
      lora: submitted.lora,
      alwayson_scripts: alwaysonScripts,
    })

    if (url) {
      // Zero is a valid seed; failed attempts must not reuse an old display seed.
      if (sd.resultSeed.value !== null) pb.sdParams.seed = sd.resultSeed.value
      const loras = sd.lastLoras.value.map(lora => ({ ...lora }))
      context.history = { ...context.history, seed: sd.resultSeed.value ?? undefined,
        loras, loraId: loras[0]?.id ?? null, loraStrength: loras[0]?.strength ?? null }
      const completedJob: SdResultSnapshot = { ...submitted, context, seed: sd.resultSeed.value ?? -1, taskId: sd.resultTaskId?.value || undefined }
      // The view receives its own context; its edits cannot mutate archive input.
      completedJobs.set(job, JSON.parse(JSON.stringify(completedJob)) as SdResultSnapshot)
      deps.setResultContext?.(context)
      // Best-effort recent settings must not turn a successful image into a failure.
      void import('./sdResultActions').then(({ rememberSdResult }) => rememberSdResult(completedJob)).catch(() => {})
    }
    return url
  }

  /**
   * 成片入册（直出 / 队列共用同一实现，2026-08-30 UX 审计 P0-8）。
   *
   * 此前只有队列与批量路径自动入册，直出成片要手点「保存快照」，忘点后
   * 切页即丢。抽出来后直出路径同样自动写历史，三条路径行为一致。
   */
  async function commitJobResult(job: Omit<SDQueueJob, 'id'>, url: string): Promise<HistoryEntry | null> {
    const completed = completedJobs.get(job)
    const context = completed?.context ?? jobResultContext(job)
    const seed = completed ? completed.seed : context.history?.seed ?? sd.resultSeed.value ?? -1
    const snapshot: SdResultSnapshot = { ...(completed ?? job), context, seed }
    const { archiveSdResult } = await import('./sdResultActions')
    return archiveSdResult(snapshot, url, pb.commitHistoryEntry)
  }

  const sdQueue = useSDQueue({
    isBusy: () => sd.generating.value,
    onFlash: (m) => pb.flash(m),
    run: async (job) => {
      const url = await runJob(job)
      if (url) {
        sdErrorReport.value = null
        // 队列产出自动入册，避免跑完一批还要手点保存
        try {
          const saved = await commitJobResult(job, url)
          if (!saved) {
            return { status: 'success-with-warning' as const, error: '生成完成，但成片未能入册；请从当前结果保存或重试。' }
          }
        } catch {
          return { status: 'success-with-warning' as const, error: '生成完成，但成片入册失败；请从当前结果保存或重试。' }
        }
        return { status: 'success' as const }
      }
      const err = sd.errorMsg.value
      if (!err) return { status: 'cancelled' as const }
      sdErrorReport.value = classifySDError({ message: err })
      return { status: 'failure' as const, error: err }
    },
  })

  // ── 队列快照接线（声明顺序见上方 readQueueSnapshot 处的说明）──────────
  // 队列变化实时落盘；挂载时把上次离开/刷新残留的 pending 任务灌回队列并置
  // 暂停，让用户确认面板状态后再手动「继续」。
  watch(() => sdQueue.queue.value, jobs => persistQueueSnapshot(jobs), { deep: true })

  /**
   * 本次挂载从快照恢复的任务数（P0-5）。对外暴露是为了让队列面板能解释
   * 「为什么一进来就是暂停」——否则用户看到一个暂停着的队列，既不知道这批
   * 任务是哪来的，也不知道该不该直接点继续。
   */
  const restoredCount = sdQueue.restore(readQueueSnapshot())
  if (restoredCount > 0) {
    pb.flash(`已恢复 ${restoredCount} 个排队任务（已暂停，点「继续」逐张生成）`)
  }

  function enqueueCurrent() {
    if (drawEngine.value !== 'sd') { pb.flash(`${drawEngine.value === 'krea2' ? 'Krea 2' : 'Anima'} 引擎暂不支持队列，直接点击生成即可`); return }
    const job = captureJob()
    if (!job) { pb.flash('请先选择场景或填写故事'); return }
    sdQueue.enqueue(job)
  }

  /** 一键发起 3 个不同 Seed 的候选变体入队（Midjourney / Forge 候选挑优机制） */
  function enqueue3Variants() {
    if (drawEngine.value !== 'sd') { pb.flash(`${drawEngine.value === 'krea2' ? 'Krea 2' : 'Anima'} 引擎暂不支持批量队列`); return }
    const baseJob = captureJob()
    if (!baseJob) { pb.flash('请先选择场景或填写故事'); return }
    const baseSeed = baseJob.seed >= 0 ? baseJob.seed : Math.floor(Math.random() * 900000000)
    let admitted = 0
    for (let i = 0; i < 3; i++) {
      const jobVariant = {
        ...baseJob,
        title: `${baseJob.title} (候选 ${i + 1}/3)`,
        seed: baseSeed + i * 1000 + (i > 0 ? Math.floor(Math.random() * 100) : 0),
      }
      if (!sdQueue.enqueue(jobVariant)) break
      admitted += 1
    }
    if (admitted > 0) {
      pb.flash(`已将 ${admitted} 组不同 Seed 候选加入出图队列${admitted < 3 ? '（队列剩余容量不足）' : ''}`)
    }
  }

  return {
    sdErrorReport,
    dismissError,
    captureJob,
    historyGenerationFields,
    runJob,
    commitJobResult,
    sdQueue,
    restoredCount,
    enqueueCurrent,
    enqueue3Variants,
  }
}

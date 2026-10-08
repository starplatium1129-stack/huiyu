import type { ActiveDrawEngine } from '@/storage/settingsRepository'
import type { Ref } from 'vue'
import type { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import type { useDirectorEngine } from '@/composables/scene/useDirectorEngine'
import type { useDirectorPopular } from '@/composables/scene/useDirectorPopular'
import type { useAnimaSession } from '@/composables/generation/useAnimaSession'
export interface PromptGenerationContext extends
  Pick<ReturnType<typeof useDirectorEngine>, 'currentCapabilities' | 'generationBusy'>,
  Pick<ReturnType<typeof useDirectorPopular>, 'applyManagedRoute'> {
  pb: ReturnType<typeof usePromptBuilderStore>
  livePrompt: Readonly<Ref<string>>
  engine: ActiveDrawEngine
  generateAnima: ReturnType<typeof useAnimaSession>['generate']
}
type Context = PromptGenerationContext
export interface HiresSource {
  engine: ActiveDrawEngine
  anima: ReturnType<ReturnType<typeof useAnimaSession>['resultSubmission']>
}
export async function callGenerateAction(ctx: Context): Promise<void> {
  if (ctx.generationBusy.value) return
  if (ctx.pb.directorMode === 'basic') await ctx.applyManagedRoute({ silent: true })
  if (!ctx.livePrompt.value) { ctx.pb.flash('请先选择场景或填写故事'); return }
  await ctx.generateAnima()
}
export async function upscaleCurrentResultAction(ctx: Context, source: HiresSource): Promise<void> {
    const { pb, generateAnima } = ctx;
    if (ctx.generationBusy.value || ctx.engine !== source.engine) return;
    if (ctx.engine === 'anima') {
        const submission = source.anima;
        const request = submission?.request;
        if (!request || submission.family !== 'anima' || !request.prompt || !request.modelId
            || ![request.width, request.height, request.steps].every(value => Number.isSafeInteger(value) && value > 0)
            || !Number.isFinite(request.cfg) || request.cfg < 0 || !Number.isSafeInteger(request.seed) || request.seed! < 0) {
            pb.flash('原成片的完整提交配方或 Seed 未知，无法按原配方高清重绘；请先重新生成');
            return;
        }
        if (request.initImage || request.maskImage || request.maskPrompt) {
            pb.flash('这幅成片含局部重绘输入，原输入无法确认仍可复用；暂不能按完整原配方高清重绘');
            return;
        }
        pb.flash('正在按原成片的配方和 Seed 执行 2x 高清重绘…');
        await generateAnima({ hiresFix: true, hiresScale: 2.0, hiresDenoise: 0.35 }, submission);
        return;
    }
}

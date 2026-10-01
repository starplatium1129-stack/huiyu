
import { confirmAction } from '@/composables/useConfirm';
import { scrollBehavior } from '@/utils/motionPreference';
import { classifySDError,LIGHT_LOAD,SAFE_SAMPLING,type SDRecoveryId } from '@/utils/sdError';
import type { PromptSdQueueDeps, usePromptSdQueue } from './usePromptSdQueue';
import type { useDirectorEngine } from '@/composables/scene/useDirectorEngine';
import type { useDirectorPopular } from '@/composables/scene/useDirectorPopular';
import type { useAnimaSession } from '@/composables/generation/useAnimaSession';
import type { useTempResult } from './useTempResult';
export interface PromptGenerationContext extends
    Pick<PromptSdQueueDeps, 'pb' | 'drawEngine' | 'sd' | 'livePrompt' | 'sdSize'>,
    Pick<ReturnType<typeof usePromptSdQueue>, 'sdErrorReport' | 'captureJob' | 'runJob'>,
    Pick<ReturnType<typeof useDirectorEngine>, 'currentCapabilities' | 'generationBusy'>,
    Pick<ReturnType<typeof useDirectorPopular>, 'applyManagedRoute' | 'resetBlueprintRotation'> {
    generateAnima: ReturnType<typeof useAnimaSession>['generate'];
    tempResultTools: Pick<ReturnType<typeof useTempResult>, 'handleSdResult'>;
}
type Context = PromptGenerationContext;
export interface HiresSource {
    engine: Context['drawEngine']['value'];
    anima: ReturnType<ReturnType<typeof useAnimaSession>['resultSubmission']>;
    sd: ReturnType<ReturnType<typeof usePromptSdQueue>['resultJob']>;
}
export async function callGenerateAction(ctx: Context, opts: {
    disableLora?: boolean;
} = {}): Promise<void> {
    if (ctx.generationBusy.value) return;
    const { pb, applyManagedRoute, drawEngine, sd, livePrompt, currentCapabilities, generateAnima, sdErrorReport, captureJob, runJob, tempResultTools } = ctx;
    if (pb.directorMode === 'basic') {
        await applyManagedRoute({ silent: true });
    }
    if (pb.isPopular && drawEngine.value === 'sd') {
        pb.flash('热门角色仅支持 Anima 无 LoRA 或 Krea 2');
        return;
    }
    if (!livePrompt.value) {
        pb.flash('请先选择场景或填写故事');
        return;
    }
    if (drawEngine.value !== 'sd') {
        if (opts.disableLora && currentCapabilities.value.lora && currentCapabilities.value.characterIdentity && !pb.isPopular) {
            pb.flash('Anima 引擎固定使用角色 LoRA，无法跳过');
        }
        await generateAnima();
        return;
    }
    sdErrorReport.value = null;
    const job = captureJob();
    if (!job)
        return;
    const url = await runJob(job, opts);
    if (!url && sd.errorMsg.value) {
        sdErrorReport.value = classifySDError({ message: sd.errorMsg.value });
        return;
    }
    // 直出结果处置（自动入册 vs 临时缓冲，F2/F3）已下沉 useTempResult.handleSdResult。
    if (url)
        void tempResultTools.handleSdResult(job, url);
}
export async function runRecoveryAction(ctx: Context, id: SDRecoveryId): Promise<void> {
    const { pb, sd, sdErrorReport, sdSize } = ctx;
    sdErrorReport.value = null;
    if (id === 'retry_light') {
        sdSize.value = LIGHT_LOAD.size;
        pb.sdParams.hiresFix = LIGHT_LOAD.hiresFix;
        pb.markParamTouched('size');
        pb.flash('已降到 832×1216 并关闭 hires.fix，正在重试');
        await callGenerateAction(ctx);
        return;
    }
    if (id === 'retry_without_lora') {
        pb.flash('本次临时跳过角色 LoRA');
        await callGenerateAction(ctx, { disableLora: true });
        return;
    }
    if (id === 'retry_current_model') {
        pb.sdModelName = '';
        pb.flash('已改用 WebUI 当前模型，正在重试');
        await callGenerateAction(ctx);
        return;
    }
    if (id === 'retry_safe_sampler') {
        pb.sdParams.sampler = SAFE_SAMPLING.sampler;
        pb.sdParams.scheduler = SAFE_SAMPLING.scheduler;
        pb.markParamTouched('sampler');
        pb.markParamTouched('scheduler');
        pb.flash('已恢复稳定采样器，正在重试');
        await callGenerateAction(ctx);
        return;
    }
    if (id === 'recheck_connection') {
        const ok = await sd.checkStatus();
        pb.flash(ok ? 'SD WebUI 已连接' : 'SD WebUI 仍未响应');
        return;
    }
    if (id === 'open_settings') {
        const el = document.querySelector('details.generation-settings') as HTMLDetailsElement | null;
        if (el) {
            el.open = true;
            el.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
        }
    }
}
export async function upscaleCurrentResultAction(ctx: Context, source: HiresSource): Promise<void> {
    const { pb, drawEngine, generateAnima } = ctx;
    if (ctx.generationBusy.value || drawEngine.value !== source.engine) return;
    if (drawEngine.value === 'anima') {
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
    if (drawEngine.value === 'sd') {
        const original = source.sd;
        if (!original || !original.prompt || !original.checkpoint || !original.sampler
            || !/^\d+x\d+$/.test(original.size) || original.size.split('x').some(value => Number(value) <= 0)
            || !Number.isSafeInteger(original.seed) || original.seed < 0 || !Number.isFinite(original.cfg)
            || !Number.isSafeInteger(original.steps) || original.steps <= 0) {
            pb.flash('原成片的完整提交配方或 Seed 未知，无法按原配方高清重绘；请先重新生成');
            return;
        }
        const job = { ...original, hiresFix: true, hiresScale: 2.0, denoisingStrength: 0.35 };
        ctx.sdErrorReport.value = null;
        pb.flash('正在按原成片的配方和 Seed 执行 SD 2x 高清重绘…');
        const url = await ctx.runJob(job);
        if (!url && ctx.sd.errorMsg.value) ctx.sdErrorReport.value = classifySDError({ message: ctx.sd.errorMsg.value });
        if (url) void ctx.tempResultTools.handleSdResult(job, url);
    }
}
export async function resetAllAction(ctx: Context): Promise<void> {
    const { pb, resetBlueprintRotation } = ctx;
    const confirmed = await confirmAction({
        title: '重置当前画面配置？',
        message: '将清空当前的故事、场景与全部自定义词条，重新开始创作。此操作不可撤销。',
        confirmLabel: '清空重置',
        danger: true,
    });
    if (!confirmed)
        return;
    if (pb.isPopular) {
        pb.setStudioSubject();
        pb.manualTags = new Set();
    }
    pb.setArtistStyleIds([]);
    pb.clearScene();
    resetBlueprintRotation();
    pb.flash('已清空，可以开始新的一幅');
}

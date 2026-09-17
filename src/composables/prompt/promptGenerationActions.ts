
import { confirmAction } from '@/composables/useConfirm';
import { scrollBehavior } from '@/utils/motionPreference';
import { classifySDError,LIGHT_LOAD,SAFE_SAMPLING,type SDRecoveryId } from '@/utils/sdError';
import type { PromptSdQueueDeps, usePromptSdQueue } from './usePromptSdQueue';
import type { useDirectorEngine } from '@/composables/scene/useDirectorEngine';
import type { useDirectorPopular } from '@/composables/scene/useDirectorPopular';
import type { useAnimaSession } from '@/composables/generation/useAnimaSession';
import type { useTempResult } from './useTempResult';
export interface PromptGenerationContext extends
    Pick<PromptSdQueueDeps, 'pb' | 'drawEngine' | 'sd' | 'livePrompt' | 'sdSize' | 'animaState' | 'displayResultSeed'>,
    Pick<ReturnType<typeof usePromptSdQueue>, 'sdErrorReport' | 'captureJob' | 'runJob'>,
    Pick<ReturnType<typeof useDirectorEngine>, 'currentCapabilities'>,
    Pick<ReturnType<typeof useDirectorPopular>, 'applyManagedRoute' | 'resetBlueprintRotation'> {
    generateAnima: ReturnType<typeof useAnimaSession>['generate'];
    patchAnimaState: ReturnType<typeof useAnimaSession>['patchState'];
    tempResultTools: Pick<ReturnType<typeof useTempResult>, 'handleSdResult'>;
}
type Context = PromptGenerationContext;
export async function callGenerateAction(ctx: Context, opts: {
    disableLora?: boolean;
} = {}): Promise<void> {
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
export async function upscaleCurrentResultAction(ctx: Context): Promise<void> {
    const { pb, drawEngine, generateAnima, animaState, patchAnimaState, displayResultSeed } = ctx;
    if (drawEngine.value === 'anima') {
        const currentResult = animaState.value.result;
        const baseSeed = currentResult?.metadata?.seed ?? animaState.value.seed;
        if (baseSeed == null || baseSeed < 0) {
            pb.flash('当前图片缺少 Seed 信息，无法执行精准超分');
            return;
        }
        // 锁定当前图的 seed 进行 2.0x 潜空间重绘放大
        patchAnimaState({ seed: baseSeed });
        pb.flash('正在使用当前 Seed 执行 2x 高清超分精修…');
        await generateAnima({ hiresFix: true, hiresScale: 2.0, hiresDenoise: 0.35 });
        return;
    }
    if (drawEngine.value === 'sd') {
        const seed = displayResultSeed.value ?? pb.lastSeed;
        if (seed != null && seed >= 0) {
            pb.sdParams.seed = seed;
            pb.sdParams.seedLock = true;
        }
        pb.sdParams.hiresFix = true;
        pb.sdParams.hiresScale = 2.0;
        pb.sdParams.hiresDenoise = 0.35;
        pb.markParamTouched('hiresFix');
        pb.markParamTouched('hiresScale');
        pb.markParamTouched('hiresDenoise');
        pb.flash('正在使用当前 Seed 执行 SD 2x 高清修复…');
        await callGenerateAction(ctx);
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

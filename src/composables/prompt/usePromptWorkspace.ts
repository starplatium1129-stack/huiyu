import { usePromptRenderControls } from './usePromptRenderControls';
import { useGeneratedSceneCapture } from './useGeneratedSceneCapture';
import { snapshotResult, type ResultSnapshot } from './promptResultSnapshot';
import { createPromptWorkspaceBindings } from './promptWorkspaceBindings';
import { usePromptWorkspaceActions } from './usePromptWorkspaceActions';

import { useAnimaInpaint } from '@/composables/generation/useAnimaInpaint';
import { useAnimaSession } from '@/composables/generation/useAnimaSession';
import { readDrawingSettings } from '@/storage/drawingSettings';
import { useLegacySdTasks } from '@/composables/generation/useLegacySdTasks';
import { usePromptDeepLink } from '@/composables/prompt/usePromptDeepLink';
import { usePromptDraftRecovery } from './usePromptDraftRecovery';
import { useResultRestoreOwner } from './useResultRestoreOwner';
import { usePromptSdQueue } from '@/composables/prompt/usePromptSdQueue';
import { legacySdHistoryFields } from '@/utils/legacySdResult';

import { usePromptVideoBridge } from '@/composables/prompt/usePromptVideoBridge';
import { useTempResult } from '@/composables/prompt/useTempResult';

import { usePromptMaterials } from './usePromptMaterials';
import { usePromptLifecycle } from './usePromptLifecycle';
import { usePromptWorkspaceUi } from './usePromptWorkspaceUi';
import { usePromptHistoryReuse } from './usePromptHistoryReuse';
import { useDrawingNavigation } from './useDrawingNavigation';
import type { ArtworkRecord } from '@/types/artwork';
import { useGenerationPresentation } from './useGenerationPresentation';
import { useDirectorEngine } from '@/composables/scene/useDirectorEngine';
import { useCompareSnapshots } from '@/composables/useCompareSnapshots';
import { useUnifiedPromptAssembly } from '@/composables/useUnifiedPromptAssembly';
import { usePromptBuilderStore } from '@/stores/promptBuilderStore';
import { useSceneStore } from '@/stores/sceneStore';
import type { AnimaResult, AnimaResultContext } from '@/types/anima';
import { captureResultContext as snapshotResultContext } from '@/utils/resultContext';
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { DRAW_ENGINE_SETTING, STARTER_MODEL_SETTING, settingsRepository, type DrawEngine } from '@/storage/settingsRepository';
import { useCharacterAtmosphere } from '@/composables/useCharacterAtmosphere';

/** Owns workspace state and lifecycle; the view only binds presentation. */
export function usePromptWorkspace() {
    const router = useRouter();
    const route = useRoute();
    const pb = usePromptBuilderStore();
    const draftRecovery = usePromptDraftRecovery(pb);
    const sceneStore = useSceneStore();
    const sd = useLegacySdTasks();
    const { inspector, materialDrawer, voiceStudioRef, batchOpen, batchRunning, autoSaveToGallery } = usePromptWorkspaceUi(route);
    const currentCharacterId = computed(() => pb.subject.kind === 'popular' ? pb.subject.characterId : pb.char);
    const currentCharacterThemeStyle = useCharacterAtmosphere(() => currentCharacterId.value, () => sceneStore.drawingProfiles);

    // ── UI state ──────────────────────────────────────────────────────────────
    const sdSize = ref('832x1216');
    // Ephemeral success signal; restored/history images never acquire it.
    const resultRevealUrl = ref('');
    const inpaintPreparing = ref(false);
    const hiresPreparing = ref(false);
    const compositionPreparing = ref(false), cancelCompositionPreparation = ref<(() => void) | null>(null);
    const restore = useResultRestoreOwner(route);
    const { getRestoreOwner } = restore;
    const DIRECTOR_MODE_KEY = 'aics_pb_director_mode';
    const storedDrawEngine = settingsRepository.get(DRAW_ENGINE_SETTING);
    const drawEngine = ref<DrawEngine>(storedDrawEngine === 'krea2' ? 'krea2' : 'anima');
    /**
     * 当前显示结果的冻结上下文（2026-09-06 体验报告 F3）。
     * Anima/Krea 由会话在提交时采样（state.resultContext）；SD 由 usePromptSdQueue
     * 在 runJob 成功时写入本 ref。跨页交接与入册一律读它，不读实时表单。
     */
    const resultContext = ref<AnimaResultContext | null>(null);
    function captureResultContext(): AnimaResultContext {
        return snapshotResultContext(pb, drawEngine.value === 'krea2' ? animaState.value.kreaStyleRecipeId : undefined);
    }
    const animaCastActive = computed(() => drawEngine.value === 'anima' && pb.castRequiresNoLora);
    const animaSession = useAnimaSession({
        getCharacter: () => animaCastActive.value ? 'none' : pb.char,
        isPopular: () => !animaCastActive.value && pb.isPopular,
        getPopularCharacterId: () => !animaCastActive.value && pb.subject.kind === 'popular' ? pb.subject.characterId : null,
        getFamily: () => drawEngine.value === 'krea2' ? 'krea2' : 'anima',
        getRequest: () => buildAnimaRequest(),
        getSubmitContext: captureResultContext,
        onResult: result => onAnimaResult(result),
        getRestoreOwner,
        restoreResult: owner => tempResultTools.restoreTempResult(owner),
        activateResult: family => engine.setDrawEngine(family, { restoreExistingResult: true, silent: true }),
        flash: message => pb.flash(message),
        preferredSize: () => pb.lastRecommendedSize,
    });
    const { state: animaState, patchState: patchAnimaState, modelId: animaModelId, refreshBackend: refreshAnimaBackend, syncCharacter: syncAnimaCharacter, applyModel, generate: generateAnima, cancel: cancelAnimaJob, clearResult: clearAnimaResult } = animaSession;
    const starterModel = settingsRepository.get(STARTER_MODEL_SETTING);
    if (starterModel && drawEngine.value === 'anima' && !readDrawingSettings('anima')) patchAnimaState({ modelId: starterModel });
    // Anima 会话先于引擎协调层创建：请求装配与结果协调经桥接函数转发到
    // useDirectorEngine（生成/结果事件均在 setup 完成后才触发，沿用提升函数模式）。
    function buildAnimaRequest() {
        return engine.buildAnimaRequest();
    }
    // Anima/Krea 结果编排（自动入册 vs 临时缓冲）已下沉 useTempResult.handleAnimaResult。
    async function onAnimaResult(result: AnimaResult) {
        resultRevealUrl.value = result.url;
        engine.onAnimaResult(result);
        await tempResultTools.handleAnimaResult(result);
    }
    // ── Prompt 组装（统一出口，消除视图三元分发）──────────────────────
    watch(animaCastActive, () => {
        syncAnimaCharacter();
        void refreshAnimaBackend();
    });
    const unified = useUnifiedPromptAssembly(pb, sd.checkpoint, drawEngine, animaModelId, computed(() => animaCastActive.value
        || !pb.isPopular && animaState.value.characterLoraEnabled === false ? '' : animaState.value.loraId), computed(() => animaState.value.kreaStyleRecipeId));
    const { currentTraits, modelProfile } = unified.studio;
    const livePrompt = unified.positivePrompt;
    const effectiveNegative = unified.negativePrompt;
    const previewPromptView = unified.previewPrompt;
    const modelProfileView = unified.modelProfile;
    const popular = unified.popular;
    // ── 反推服装顶替（2026-08-29）────────────────────────────────────────────
    const outfitOverridden = computed(() => Boolean(pb.outfitOverride?.tokens.length
        && (!pb.castRequiresNoLora || pb.outfitOverride.presetId)));
    // ── 引擎协调层（2026-08-28 编排下沉）──────────────────────────────────────
    const engine = useDirectorEngine({
        pb,
        sd,
        sdSize,
        drawEngine,
        animaState,
        patchAnimaState,
        refreshAnimaBackend,
        syncAnimaCharacter,
        applyModel,
        cancelAnimaJob,
        clearAnimaResult,
        livePrompt,
        effectiveNegative,
        modelProfile,
        modelProfileView,
        popularProfile: popular.profile,
        flash: message => pb.flash(message),
    });
    const { setDrawEngine, applyRecommendedSize, displayResultUrl, displayResultSeed, drawEngineLabel, generationStatusText, engineOnline, generationBusy: engineGenerationBusy, generationProgress, generationError, generationStopped, engineStatusText, recheckEngineConnection, generationPresetSummary, updateAnimaPromptState } = engine;
    const generationBusy = computed(() => engineGenerationBusy.value || inpaintPreparing.value || hiresPreparing.value || compositionPreparing.value);
    const generationPresentation = useGenerationPresentation(engine, () => inpaintPreparing.value ? '正在准备换装…' : hiresPreparing.value ? '正在准备放大原图…' : compositionPreparing.value ? '正在准备构图…' : '',
        () => Boolean(displayResultUrl.value && resultRevealUrl.value === displayResultUrl.value),
        () => { void animaSession.recover(); });
    const { genBarSize, animaBarSizes, resetSdParams, engineTitle, generateBlockReason } =
        usePromptRenderControls({ pb, sdSize, drawEngine, animaState, livePrompt }, engine, generationBusy);
    // ── 热门角色编排层（2026-08-28 编排下沉）──────────────────────────────────
    const materials = usePromptMaterials({
        preparedModelId: starterModel, getAnimaSettingsRevision: animaSession.getSettingsRevision,
        voiceStudioRef,
        pb,
        sd,
        drawEngine,
        setDrawEngine,
        applyRecommendedSize,
        generationBusy,
        animaState,
        patchAnimaState,
        refreshAnimaBackend,
        applyModel,
        sdSize,
        flash: message => pb.flash(message),
    });
    const { popularCategory, showAllBlueprints, refreshManagedRoute, popularBlueprintPool, blueprintCategories, resetBlueprintRotation, applyRecommendedEngine, selectPopularSource, selectPopularCharacter, selectPopularOutfit, selectBlueprint, applyManagedRoute, applyPreparedModel, syncManagedRoute, restorePopularDraft } = materials.popular;
    const { sceneLimit, sceneCollection, setDirectorMode, selectScene, currentBlueprintData, handleLoadBlueprint } = materials;
    // ── 出图对比（URL 克隆保活归 useCompareSnapshots）────────────────────────
    const compare = useCompareSnapshots<ResultSnapshot>({
        build: (url) => buildResultSnapshot(url),
    });
    const { prevResult, compareOpen } = compare;
    /** 克隆 URL 前冻结当前成片元数据，异步期间的表单变化不影响快照。 */
    function buildResultSnapshot(persistentUrl: string): ResultSnapshot { return snapshotResult({ animaState, drawEngine, displayResultSeed, pb, sdSize, sd }, persistentUrl); }
    watch(displayResultUrl, (url, oldUrl) => {
        if (!url || url === oldUrl) return;
        compare.rotate(url);
    });
    // ── SD 出图任务执行 + 队列（已下沉 usePromptSdQueue）──────────────────────
    const { sdErrorReport, runJob, sdQueue, restoredCount } = usePromptSdQueue({
        pb,
        sd,
        setResultContext: (ctx) => { resultContext.value = ctx; },
        onGenerated: url => { resultRevealUrl.value = url; },
    });
    // ── 未入册成片临时缓冲（F2）+ 舞台↔作品册锚点 + 手动入册 ──────────────────
    const tempResultTools = useTempResult({
        onResultRetained: animaSession.acknowledgeResult,
        onResultDiscarded: animaSession.discardResult,
        pb,
        sd,
        drawEngine,
        animaState,
        patchAnimaState,
        displayResultUrl,
        displayResultSeed,
        generationBusy,
        livePrompt,
        negativePrompt: effectiveNegative,
        legacyResultFields: () => legacySdHistoryFields({
            params: pb.sdParams, model: pb.sdModelName || sd.checkpoint.value || '', profile: modelProfile.value?.id || '',
            size: sdSize.value, provider: sd.provider.value || 'webui', loras: sd.lastLoras.value,
        }),
        resultContext,
        autoSaveToGallery,
        setDrawEngine,
    });
    const { displayedResultHistoryId, resultArchived, savingResult, resultTemporary, saveCurrentResult, restoreTempResult, discardTemp } = tempResultTools;
    const { capturedScene, capturingScene, captureScene, closeSceneCapture } = useGeneratedSceneCapture({
        engine: drawEngine, url: displayResultUrl, busy: generationBusy, anima: animaState,
        sdContext: resultContext, sdPrompt: sd.resultPrompt, flash: message => pb.flash(message),
    });
    // ── 出视频 / 分镜短片（编排已下沉 usePromptVideoBridge）──────────────────
    const { goToVideo: goVideoBridge, shotsPending, transferBusy, refreshShotsPending, addToShots, goToShots: goShotsNav, handleHistoryToShots, handleHistoryToShotsBatch } = usePromptVideoBridge({
        getRestoreOwner,
        displayResultUrl,
        drawEngine,
        livePrompt,
        sdResultPrompt: sd.resultPrompt,
        animaState,
        story: () => pb.story,
        sceneId: () => pb.sceneId,
        subject: () => pb.subject,
        resultContext: () => drawEngine.value !== 'sd' ? (animaState.value.resultContext ?? null) : resultContext.value,
        flash: message => pb.flash(message),
    });
    async function goToVideo() { await goVideoBridge(path => router.push(path)); }
    async function goToShots() { await goShotsNav(path => router.push(path)); }
    function saveResult() { return saveCurrentResult(); }
    // ── Anima 智能局部换装（编排已下沉 useAnimaInpaint）───────────────────────
    const inpaintPopularTokens = computed(() => {
        const subject = pb.subject;
        if (subject.kind !== 'popular') return [];
        const match = sceneStore.popularCharacters.find(c => c.id === subject.characterId);
        if (!match) return [];
        return [...(match.exactTokens ?? []), ...(match.identityTokens ?? [])];
    });
    const inpaint = useAnimaInpaint({
        pb,
        drawEngine,
        animaState,
        generateAnima,
        captureAnimaSubmission: animaSession.captureSubmission,
        preparing: inpaintPreparing,
        isPopular: computed(() => pb.isPopular),
        popularIdentityTokens: inpaintPopularTokens,
    });
    const { inpaintOpen, inpaintOriginalUrl, inpaintCompareActive, cancelInpaintPreparation, clearInpaintOriginal } = inpaint;
    const {
        handleInterrogateResult, handleInterrogateError, copyPrompt, cancelGeneration,
        onArtistLimitReached, queuePausedReason, retryAnima, hasStashedResult,
        onRestoreStashed, onClearResult, reuseLastSeed, callGenerate, upscaleCurrentResult,
    } = usePromptWorkspaceActions({
        pb, route, restore, drawEngine, animaSession, engine, livePrompt, previewPromptView,
        generationBusy, resultRevealUrl, hiresPreparing, compositionPreparing, cancelCompositionPreparation,
        cancelInpaintPreparation, clearInpaintOriginal, discardTemp, applyManagedRoute,
        sdQueue, sdErrorReport, restoredCount,
    });
    const drawingNavigation = useDrawingNavigation();
    const nativeHistoryRecipe = ref<ArtworkRecord | null>(null);
    const historyReuse = usePromptHistoryReuse({ pb, animaState, patchAnimaState: animaSession.restoreSettings,
        clearAnimaResult, refreshAnimaBackend, setDrawEngine, resetBlueprintRotation, sdSize, drawEngine, generationBusy,
        onApplied: (record, selection) => {
            setDirectorMode('pro');
            if (selection !== 'full' || record.engine !== 'moss-image') return;
            nativeHistoryRecipe.value = record;
            if (drawingNavigation.mode.value === 'moss') return;
            if (!draftRecovery.initialized && route.query.regen === String(record.id)) {
                // Cold history links must survive the model switch so initialization can replay the same recipe.
                void router.replace({ path: route.path, query: { ...route.query, engine: 'moss' }, hash: route.hash });
            } else void drawingNavigation.selectEngine('moss');
        } });
    const { applyHistory, resumeHistory, duplicateHistory, deleteHistory, reuseSuccessfulRecipe } = historyReuse;
    watch(() => route.fullPath, () => historyReuse.cancelReuse());
    // ── 深链参数应用（已下沉 usePromptDeepLink）───────────────────────────────
    const { applyDeepLink, deepLinkNeeded, deepLinkError, retryingDeepLink, retryDeepLink, hasFailedDeepLink } = usePromptDeepLink({
        pb, route, getSettingsRevision: animaSession.getSettingsRevision,
        draftRecovery,
        generationBusy,
        sdSize: computed({ get: () => sdSize.value, set: applyRecommendedSize }),
        patchAnimaState,
        showAllBlueprints,
        selectPopularSource,
        selectBlueprint,
        selectScene,
        applyRecommendedEngine,
        applyHistory,
    });
    // 组件复用 / 后退恢复（bfcache）时 onMounted 不重跑：按「状态与 URL 不一致」重放深链。
    watch(() => route.query, async (q) => {
        if (route.path !== '/prompt-builder' || !deepLinkNeeded(q)) return;
        if (await applyDeepLink(q) && !generationBusy.value) {
            if (pb.directorMode === 'basic' && !['remix', 'regen', 'variant'].some(key => typeof q[key] === 'string'))
                void applyManagedRoute({ silent: true });
            else
                void refreshManagedRoute();
        }
    });
    const {
        compositionBindings, materialBindings, renderBindings, styleBindings,
        healthBindings, deliveryBindings, dialogBindings,
    } = createPromptWorkspaceBindings({
        pb, sceneStore, sd, drawEngine, currentCharacterId, animaSession, engine,
        generationBusy, generationPresentation, unified, materials, sdQueue, runJob,
        inpaint, compare, displayedResultHistoryId, inpaintPreparing, compositionPreparing,
        cancelCompositionPreparation, voiceStudioRef, autoSaveToGallery, batchRunning, batchOpen,
        engineTitle, resetSdParams, reuseSuccessfulRecipe, reuseLastSeed, retryAnima,
        onArtistLimitReached, copyPrompt, queuePausedReason,
        retryInitialization: () => retryInitialization(),
    });
    const retryInitialization = usePromptLifecycle({
        draftRecovery, getRestoreOwner,
        router, generationBusy, applyPreparedModel, refreshShotsPending, refreshAnimaBackend, drawEngine, sd, DIRECTOR_MODE_KEY,
        pb, sceneCollection, applyDeepLink, hasFailedDeepLink, route, displayResultUrl, restoreTempResult, sdSize,
        applyManagedRoute, refreshManagedRoute, restorePopularDraft,
        animaState, patchAnimaState, engineOnline, livePrompt, callGenerate, effectiveNegative,
        updateAnimaPromptState, setDrawEngine, syncManagedRoute, popularBlueprintPool, blueprintCategories,
        popularCategory, syncAnimaCharacter, sceneLimit, applyRecommendedSize, animaSession,
    });
    return {
        capturedScene, capturingScene, captureScene, closeSceneCapture, historyReuse, deepLinkError, retryingDeepLink, retryDeepLink,
        pb, displayResultUrl, resultRevealUrl, currentCharacterThemeStyle, sd,
        animaSession, setDirectorMode, engineOnline, engineStatusText,
        recheckEngineConnection, drawEngineLabel, currentBlueprintData, handleLoadBlueprint, route, currentTraits,
        selectPopularSource, selectPopularCharacter, selectPopularOutfit, resumeHistory, duplicateHistory, deleteHistory,
        handleHistoryToShots, handleHistoryToShotsBatch, generationBusy, generationError, generationStopped, generationStatusText,
        generationProgress, generationPresentation, animaState, drawEngine, inpaintOriginalUrl, inpaintCompareActive,
        shotsPending, transferBusy, prevResult, resultArchived, savingResult, resultTemporary, hasStashedResult,
        callGenerate, inpaintOpen, inspector, materialDrawer, upscaleCurrentResult, goToVideo,
        addToShots, goToShots, saveResult, compareOpen, onClearResult, onRestoreStashed,
        handleInterrogateResult, handleInterrogateError, genBarSize, animaBarSizes, generationPresetSummary, generateBlockReason,
        cancelGeneration, outfitOverridden, sdQueue,
        materialBindings, renderBindings, styleBindings, healthBindings, deliveryBindings, dialogBindings, compositionBindings, mossPlan: unified.mossPlan,
        nativeHistoryRecipe, draftReady: computed(() => draftRecovery.initialized),
        recipePreviewContext: { engine: drawEngine, kreaStyleRecipeId: () => animaState.value.kreaStyleRecipeId, animaRequest: () => engine.buildAnimaRequest(true) },
    };
}

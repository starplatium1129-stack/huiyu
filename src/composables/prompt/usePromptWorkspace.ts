import type { ArtworkRecord } from '@/types/artwork'
import { snapshotResult,type ResultSnapshot } from './promptResultSnapshot';

import { useAnimaInpaint } from '@/composables/generation/useAnimaInpaint';
import { useAnimaSession } from '@/composables/generation/useAnimaSession';
import { useSDGenerate } from '@/composables/generation/useSDGenerate';
import { usePromptDeepLink } from '@/composables/prompt/usePromptDeepLink';
import { usePromptSdQueue } from '@/composables/prompt/usePromptSdQueue';

import { usePromptVideoBridge } from '@/composables/prompt/usePromptVideoBridge';
import { useTempResult } from '@/composables/prompt/useTempResult';

import { usePromptMaterials } from './usePromptMaterials';
import { usePromptLifecycle } from './usePromptLifecycle';
import { usePromptWorkspaceUi } from './usePromptWorkspaceUi';
import type { PromptMaterialBindings, PromptRenderBindings, PromptStyleBindings, PromptHealthBindings, PromptDeliveryBindings, PromptDialogBindings } from './promptPanelBindings';
import { useDirectorEngine } from '@/composables/scene/useDirectorEngine';
import { useCompareSnapshots } from '@/composables/useCompareSnapshots';
import { useUnifiedPromptAssembly } from '@/composables/useUnifiedPromptAssembly';
import { usePromptBuilderStore } from '@/stores/promptBuilderStore';
import { useSceneStore } from '@/stores/sceneStore';
import type { AnimaResult,AnimaResultContext } from '@/types/anima';
import { captureResultContext as snapshotResultContext } from '@/utils/resultContext';
import { type SDRecoveryId } from '@/utils/sdError';
import { computed, onActivated, onDeactivated, onUnmounted, reactive, ref, toRef, watch } from 'vue';
import { useRoute,useRouter } from 'vue-router';
import { DRAW_ENGINE_SETTING,settingsRepository,type DrawEngine,} from '@/storage/settingsRepository';
import { applyCharacterAtmosphere, characterThemeStyle, clearCharacterAtmosphere } from '@/utils/characterTheme';
/** Owns workspace state and lifecycle; the view only binds presentation. */
export function usePromptWorkspace() {
    const router = useRouter();
    const route = useRoute();
    const pb = usePromptBuilderStore();
    const sceneStore = useSceneStore();
    const sd = useSDGenerate();
    const { inspector, materialDrawer, voiceStudioRef, batchOpen, batchRunning, autoSaveToGallery, characterShifting } = usePromptWorkspaceUi(pb, route);
    const currentCharacterId = computed(() => pb.subject.kind === 'popular' ? pb.subject.characterId : pb.char);
    const currentCharacterThemeStyle = computed(() => (characterThemeStyle(currentCharacterId.value, sceneStore.characters)));
    const syncCharacterAtmosphere = () => applyCharacterAtmosphere(currentCharacterId.value, sceneStore.characters);
    // The director page is kept alive. Scope the document-level atmosphere to its
    // active lifetime so a hidden workbench cannot tint unrelated routes.
    watch([currentCharacterId, () => sceneStore.characters], syncCharacterAtmosphere, { immediate: true });
    onActivated(syncCharacterAtmosphere);
    onDeactivated(clearCharacterAtmosphere);
    onUnmounted(clearCharacterAtmosphere);

    // ── UI state ──────────────────────────────────────────────────────────────
    const sdSize = ref('832x1216');
    const DIRECTOR_MODE_KEY = 'aics_pb_director_mode';
    const storedDrawEngine = settingsRepository.get(DRAW_ENGINE_SETTING);
    const drawEngine = ref<DrawEngine>(storedDrawEngine ?? 'sd');
    /**
     * 当前显示结果的冻结上下文（2026-09-06 体验报告 F3）。
     * Anima/Krea 由会话在提交时采样（state.resultContext）；SD 由 usePromptSdQueue
     * 在 runJob 成功时写入本 ref。跨页交接与入册一律读它，不读实时表单。
     */
    const resultContext = ref<AnimaResultContext | null>(null);
    function captureResultContext(): AnimaResultContext {
        return snapshotResultContext(pb);
    }
    const animaSession = useAnimaSession({
        getCharacter: () => pb.char,
        isPopular: () => pb.isPopular,
        getFamily: () => drawEngine.value === 'krea2' ? 'krea2' : 'anima',
        getRequest: () => buildAnimaRequest(),
        getSubmitContext: () => ({ ...captureResultContext(), parentId: inpaintSourceHistoryId.value }),
        onResult: result => onAnimaResult(result),
        flash: message => pb.flash(message),
        preferredSize: () => pb.lastRecommendedSize,
    });
    const { state: animaState, patchState: patchAnimaState, modelId: animaModelId, refreshBackend: refreshAnimaBackend, syncCharacter: syncAnimaCharacter, applyModel, generate: generateAnima, cancel: cancelAnimaJob, clearResult: clearAnimaResult, startStatusPolling } = animaSession;
    // Anima 会话先于引擎协调层创建：请求装配与结果协调经桥接函数转发到
    // useDirectorEngine（生成/结果事件均在 setup 完成后才触发，沿用提升函数模式）。
    function buildAnimaRequest() {
        return engine.buildAnimaRequest();
    }
    // Anima/Krea 结果编排（自动入册 vs 临时缓冲）已下沉 useTempResult.handleAnimaResult。
    function onAnimaResult(result: AnimaResult) {
        engine.onAnimaResult(result);
        void tempResultTools.handleAnimaResult(result, inpaintSourceHistoryId.value);
    }
    // ── Prompt 组装（统一出口，消除视图三元分发）──────────────────────
    const unified = useUnifiedPromptAssembly(pb, sd.checkpoint, drawEngine, animaModelId, computed(() => animaState.value.loraId));
    const { currentTraits, modelProfile, effectiveScene, loraSpecs, negativePrompt } = unified.studio;
    const livePrompt = unified.positivePrompt;
    const effectiveNegative = unified.negativePrompt;
    const previewPromptView = unified.previewPrompt;
    const modelProfileView = unified.modelProfile;
    const reportView = unified.promptReport;
    const artViolationsView = unified.artViolations;
    const popular = unified.popular;
    // ── 反推服装顶替（2026-08-29）────────────────────────────────────────────
    // 热门角色默认会注入 12 个服装 tag 加一整段 "She wears ..." 散文，参考图服装
    // 追加在末尾会被淹没。故反推出跨族服装时改为整体顶替，并给用户一键恢复的入口。
    const outfitOverridden = computed(() => pb.isPopular && Boolean(pb.outfitOverride?.tokens.length));
    const outfitOverrideTokens = computed(() => pb.outfitOverride?.tokens ?? []);
    const outfitReplacedLabel = computed(() => pb.outfitOverride?.replaced ?? '');
    // ── 引擎协调层（2026-08-28 编排下沉）：引擎切换守卫、能力表、在线/进度/错误
    // 聚合展示、Anima 请求装配与推荐尺寸收敛，照 useAnimaInpaint 的依赖注入样板。
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
    const { currentCapabilities, animaNoLoraMode, supportsDualCharacter, setDrawEngine, applyRecommendedSize, clearDisplayedResult, displayResultUrl, displayResultSeed, drawEngineLabel, generationStatusText, engineOnline, generationBusy, generationProgress, generationError, generationStopped, engineStatusText, recheckEngineConnection, generationPresetSummary, cancelGeneration, selectAnimaModel, updateAnimaPromptState } = engine;
    // ── 吸附出图条尺寸源：SD 直写 sdSize；Anima/Krea2 走 applyRecommendedSize，
    // 先收敛到当前底模白名单（closestSupportedSize）再同步双引擎，防服务端 400。
    const genBarSize = computed({
        get: () => drawEngine.value === 'sd'
            ? sdSize.value
            : `${animaState.value.width}x${animaState.value.height}`,
        set: (value: string) => {
            if (drawEngine.value === 'sd')
                sdSize.value = value;
            else
                applyRecommendedSize(value);
        },
    });
    /** 出图条候选尺寸：当前底模白名单；当前生效值不在列时兜底置顶，避免 select 空显。 */
    const animaBarSizes = computed<string[]>(() => {
        const activeModel = animaState.value.models.find(model => model.id === animaState.value.modelId);
        const sizes = activeModel?.sizes?.length ? [...activeModel.sizes] : ['832x1216', '1024x1024', '1216x832'];
        const current = `${animaState.value.width}x${animaState.value.height}`;
        if (!sizes.includes(current))
            sizes.unshift(current);
        return sizes;
    });
    // ── 热门角色编排层（2026-08-28 编排下沉）：subject/服装/蓝图选择与轮换、
    // 蓝图池过滤与推荐、受控绘图路线、热门草稿恢复。
    const materials = usePromptMaterials({
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
    const { popularCategory, showAllBlueprints, popularCharacter, archiveBarShape, managedRoute, refreshManagedRoute, popularBlueprintPool, filteredPopularBlueprints, blueprintCategories, recommendedBlueprints, resetBlueprintRotation, applyRecommendedEngine, selectPopularSource, selectPopularCharacter, selectPopularOutfit, selectBlueprint, rotateBlueprintSet, toggleBlueprintList, applyManagedRoute, syncManagedRoute, restorePopularDraft } = materials.popular;
    const { emotionSummary, shotSummary, lightingSummary, compositionSummary, moodSummary, personaCoreIds, availableScenes, visibleScenes, personaCoreCount, curatedCount, modeDescription, vramLevel, baseResolutionRisk, vramHint, baseResolutionHint, canUseFaceDetailer } = materials.derived;
    const { sceneLimit, sceneCollection, setDirectorMode, setSceneCollection, selectScene, currentBlueprintData, handleLoadBlueprint } = materials;
    // ── 出图对比：记住上一张结果，生成新图后可并排大图对比 ──────────────
    // URL 克隆保活/延迟释放/token 防乱序/焦点陷阱等生命周期归
    // useCompareSnapshots（2026-08-21 拆出）；这里只保留业务元数据组装。
    const compare = useCompareSnapshots<ResultSnapshot>({
        build: (url) => buildResultSnapshot(url),
    });
    // 模板沿用原名绑定
    const { prevResult, lastResult, compareOpen, compareEl, close: closeCompare } = compare;
    /** 快照业务字段：URL 已由 composable 克隆保活，这里只读引擎状态组装元数据。 */
    function buildResultSnapshot(persistentUrl: string): ResultSnapshot { return snapshotResult({ animaState, drawEngine, displayResultSeed, pb, sdSize, sd }, persistentUrl); }
    // ── Actions ───────────────────────────────────────────────────────────────
    async function handleInterrogateResult(result: unknown) {
        const { applyInterrogateResult } = await import('@/composables/prompt/applyInterrogateResult');
        await applyInterrogateResult(pb, result);
    }
    function handleInterrogateError(message: string) {
        pb.flash('反推失败：' + message);
    }
    // 新一轮生成开始时结果会被清空，完成后再写入新值；
    // 因此只在"有值且与上一张不同"时轮转快照（SD 与 Anima 结果共用）。
    // 快照 blob 克隆保活与 token 防乱序在 useCompareSnapshots 内部处理。
    watch(displayResultUrl, (url, oldUrl) => {
        if (!url || url === oldUrl)
            return;
        compare.rotate(url);
    });
    /**
     * 舞台当前结果 ↔ 作品册条目锚点（P1-14 inpaint 对比语义）与「未入册成片」
     * 临时缓冲（F2）已一并下沉 useTempResult；displayedResultHistoryId 来自其返回。
     */
    /** 重绘来源条目：在换装弹窗打开的瞬间定格，弹窗期间舞台结果不变。 */
    const inpaintSourceHistoryId = ref<string | number | null>(null);
    // ── SD 出图任务执行 + 队列（已下沉 usePromptSdQueue）──────────────────────
    // 一条 runJob 路径三处消费：直出 callGenerate / 队列串行 / 批量 runners 注入。
    const { sdErrorReport, dismissError, captureJob, historyGenerationFields, runJob, commitJobResult, sdQueue, restoredCount, enqueueCurrent, enqueue3Variants } = usePromptSdQueue({
        pb,
        sd,
        sdSize,
        drawEngine,
        livePrompt,
        negativePrompt,
        effectiveScene,
        loraSpecs,
        modelProfile,
        animaState,
        displayResultSeed,
        setResultContext: (ctx) => { resultContext.value = ctx; },
    });
    // ── 未入册成片临时缓冲（F2）+ 舞台↔作品册锚点 + 手动入册（已下沉 useTempResult）──
    const tempResultTools = useTempResult({
        pb,
        sd,
        drawEngine,
        animaState,
        patchAnimaState,
        displayResultUrl,
        displayResultSeed,
        livePrompt,
        negativePrompt,
        historyGenerationFields,
        commitJobResult,
        resultContext,
        autoSaveToGallery,
        setDrawEngine,
    });
    const { displayedResultHistoryId, resultArchived, savingResult, resultTemporary, saveCurrentResult, restoreTempResult, discardTemp } = tempResultTools;
    // ── 多场景批量出图（编排由 BatchSceneDrawPanel 持有，宿主只注入依赖快照）──
    // 选 N 个场景蓝图 → 逐张串行出图（SD 走 runJob 同路径 / Anima 直接提交
    // ComfyUI 任务）→ 每张自动入册历史 → 面板内直接预览挑选。
    // ref/函数引用在 setup 期即稳定，面板内部用这份快照接线 usePromptBatchRunners。
    const batchPanelDeps = {
        pb,
        sd,
        sdSize,
        negativePrompt,
        loraSpecs,
        modelProfile,
        animaState,
        runJob,
        historyGenerationFields,
        sceneBlueprints: () => sceneStore.sceneBlueprints,
        popularCharacters: () => sceneStore.popularCharacters,
        currentLivePrompt: () => livePrompt.value,
    };
    // 普通跨页保留工作台任务；整页重载交由全局路由提示。
    /**
     * 出图前的可见校验（2026-08-30 UX 审计 P1）。
     *
     * 规则必须与 callGenerate 里的守卫保持一致：两处一旦漂移，结果就是「按钮亮着
     * 但点了才报错」，比没校验更让人困惑。callGenerate 的守卫保留作防御，这里
     * 负责让原因在点之前就看得见。
     */
    /**
     * 出图参数恢复底模推荐值（2026-08-30 UX 审计 P1）。
     *
     * 默认值按 checkpoint 匹配 profile，只有 store 知道，所以实际动作在 store 里；
     * 这里只负责如实反馈结果——套不上档位时也要说，不能点了没反应。
     */
    function resetSdParams() {
        if (pb.resetParamsToProfile())
            pb.flash('已恢复这套底模的推荐参数');
        else
            pb.flash('当前底模没有对应的推荐参数档位，未能恢复');
    }
    /**
     * 生成中禁用控件的统一说明（2026-08-30 UX 审计 P2）。
     *
     * 同样的文案在 DirectorStagePanel 里也有一份，改动时记得两边一起改。
     */
    const BUSY_HINT = '生成中，请稍候';
    /**
     * 引擎按钮的悬停说明：优先讲「为什么点不了」。
     *
     * 顺序是 生成中 > 该引擎不支持当前配置。原先这些按钮在生成中冒出来的仍是
     * 功能介绍，用户面对「点不动 + 一堆功能说明」只会以为软件坏了。
     */
    function engineTitle(engine: DrawEngine) {
        if (generationBusy.value)
            return BUSY_HINT;
        if (engine === 'sd')
            return pb.isPopular ? '热门角色仅支持 Anima 无 LoRA 或 Krea 2' : undefined;
        if (!pb.isPopular && pb.char === 'triad' && !supportsDualCharacter(engine)) {
            return '双人模式请使用 SD 引擎';
        }
        return undefined;
    }
    const generateBlockReason = computed(() => {
        if (!livePrompt.value)
            return '先选择场景或填写故事';
        if (pb.isPopular && drawEngine.value === 'sd')
            return '热门角色请切到 Anima 或 Krea 2';
        return '';
    });
    /** 分类恢复：对应旧版 runSDRecovery */
    async function copyPrompt() {
        try {
            await navigator.clipboard.writeText(previewPromptView.value);
            pb.flash('Prompt 已复制');
        }
        catch {
            pb.flash('复制失败，请手动选取');
        }
    }
    /** 手动「保存快照」：实现已下沉 useTempResult.saveCurrentResult（含入册后释放临时缓冲）。 */
    // ── 出视频 / 分镜短片（编排已下沉 usePromptVideoBridge）──────────────────
    const { goToVideo: goVideoBridge, shotsPending, refreshShotsPending, addToShots, goToShots: goShotsNav, handleHistoryToShots, handleHistoryToShotsBatch } = usePromptVideoBridge({
        displayResultUrl,
        drawEngine,
        livePrompt,
        sdResultPrompt: sd.resultPrompt,
        animaState,
        story: () => pb.story,
        sceneId: () => pb.sceneId,
        subject: () => pb.subject,
        // F3：交接归属以生成时冻结快照为准（Anima 在会话 state，SD 在视图 ref）。
        resultContext: () => drawEngine.value !== 'sd' ? (animaState.value.resultContext ?? null) : resultContext.value,
        flash: message => pb.flash(message),
    });
    async function goToVideo() { await goVideoBridge(path => router.push(path)); }
    async function goToShots() { await goShotsNav(path => router.push(path)); }
    function saveResult() { return saveCurrentResult(); }
    // ── Anima 智能局部换装（编排已下沉 useAnimaInpaint）───────────────────────
    // 热门角色换装：取出角色 Danbooru 身份标签（exactTokens + identityTokens），
    // 换装时拼入提示词锁定「衣服穿在谁身上」；studio 桌宠角色为空数组不影响。
    const inpaintPopularTokens = computed(() => {
        const subject = pb.subject;
        if (subject.kind !== 'popular')
            return [];
        const match = sceneStore.popularCharacters.find(c => c.id === subject.characterId);
        if (!match)
            return [];
        return [...(match.exactTokens ?? []), ...(match.identityTokens ?? [])];
    });
    const { inpaintOpen, inpaintOriginalUrl, inpaintCompareActive, inpaintCharacter, handleInpaintSubmit } = useAnimaInpaint({
        pb,
        drawEngine,
        animaState,
        displayResultUrl,
        generateAnima,
        isPopular: computed(() => pb.isPopular),
        popularIdentityTokens: inpaintPopularTokens,
    });
    // 弹窗一打开就定格来源：此时舞台上的正是要被重绘的那张图；等结果回来再取
    // 就已经是新图了（inpaint 是覆盖式提交，结果直接顶掉舞台）。
    watch(inpaintOpen, (open) => {
        if (open)
            inpaintSourceHistoryId.value = displayedResultHistoryId.value;
    });
    /**
     * 画师选满后再点（2026-08-30 UX 审计 P1）：面板内已有就地提示，这里补一条
     * toast——画师网格在折叠面板里，提示有可能被滚出视野。
     */
    function onArtistLimitReached(max: number) {
        pb.flash(`最多同时选 ${max} 位画师，先取消一位再选`);
    }
    /**
     * 队列为什么暂停（2026-08-30 UX 审计 P1）。
     *
     * 队列面板原本只写「已暂停」——用户不知道是任务失败了、还是自己按的暂停。
     * 失败时 sdErrorReport 里已有分类结论（中文标题 + 建议），直接引过来；快照
     * 恢复导致的暂停单独说明来源。手动暂停不需要解释，返回空串。
     */
    const queuePausedReason = computed(() => {
        if (!sdQueue.paused.value)
            return '';
        if (sdErrorReport.value)
            return `${sdErrorReport.value.title}：${sdErrorReport.value.message}`;
        if (restoredCount > 0)
            return '这些任务来自上次离开时的队列，确认参数后点「继续」';
        return '';
    });
    /**
     * Anima / Krea 2 失败后重试（2026-08-30 UX 审计）。
     *
     * 面板里的「重试」按当前面板配置原样重发一次——Comfy 侧最常命中 OOM 与模型
     * 未就绪，重发是确定有效的动作；SD 那套「切回 WebUI 当前模型」之类的恢复在
     * 这里并不适用，所以不复用 SDRecoveryPanel 的动作集。
     */
    function retryAnima() {
        if (generationBusy.value)
            return;
        void generateAnima();
    }
    // ── F2：上一张未入册成片的找回 / 显式丢弃 ─────────────────────────────
    /** 失败/取消后画布旁可「找回上一张」（Anima/Krea 暂存；SD 旧图从未离开画布）。 */
    const hasStashedResult = computed(() => Boolean(animaSession.stashedResult.value));
    function onRestoreStashed() {
        if (animaSession.restoreStashedResult())
            pb.flash('已恢复上一张未入册的成片，可存入作品册或继续新作');
    }
    /** 「清除」是显式丢弃：临时缓冲同步清掉，避免下次进页又被找回。 */
    function onClearResult() {
        discardTemp();
        animaSession.discardStashedResult();
        clearDisplayedResult();
    }
    function reuseLastSeed() {
        const seed = displayResultSeed.value ?? pb.lastSeed;
        if (seed == null || seed < 0) {
            pb.flash('还没有可复用的 seed');
            return;
        }
        pb.sdParams.seed = seed;
        pb.sdParams.seedLock = true;
        pb.flash(`已锁定 seed ${seed}`);
    }
    // ── 历史应用（恢复/复制/删除/复用配方）已下沉 usePromptHistoryApply ────────
    // 历史恢复与删除只在用户操作或历史深链时加载，普通出图首屏不下载这段代码。
    let historyTools: Promise<ReturnType<typeof import('@/composables/prompt/usePromptHistoryApply')['usePromptHistoryApply']>> | null = null;
    function getHistoryTools() {
        return historyTools ??= import('@/composables/prompt/usePromptHistoryApply').then(({ usePromptHistoryApply }) => usePromptHistoryApply({
            pb,
            animaState,
            patchAnimaState: animaSession.restoreSettings,
            clearAnimaResult,
            refreshAnimaBackend,
            setDrawEngine,
            resetBlueprintRotation,
            sdSize,
        }));
    }
    async function applyHistory(entry: ArtworkRecord, variant = false) {
        const tools = await getHistoryTools();
        if (generationBusy.value) { pb.flash('生成进行中，完成或停止后再载入配方'); return false; }
        return tools.applyHistory(entry, variant);
    }
    function resumeHistory(entry: ArtworkRecord) { return applyHistory(entry); }
    function duplicateHistory(entry: ArtworkRecord) { return applyHistory(entry, true); }
    async function deleteHistory(entry: ArtworkRecord) { await (await getHistoryTools()).deleteHistory(entry); }
    async function reuseSuccessfulRecipe(id: string | number) { const entry = pb.history.find(item => item.id === id); if (entry) await applyHistory(entry, true); }
    // ── 深链参数应用（已下沉 usePromptDeepLink）───────────────────────────────
    // onMounted 首放 + watch(route.query) 按 deepLinkNeeded 条件重放：
    // 组件复用 / 后退恢复（bfcache）时组件不会重挂载、onMounted 不重跑，
    // URL 变了状态却不更新——按「URL 与当前选中不一致」重放，保证
    // 「点场景卡片后提示词跟随新场景」。八类参数全部走视图注入的同一路径动作。
    const { applyDeepLink, deepLinkNeeded } = usePromptDeepLink({
        pb,
        sdSize: computed({ get: () => sdSize.value, set: applyRecommendedSize }),
        patchAnimaState,
        showAllBlueprints,
        selectPopularSource,
        selectBlueprint,
        selectScene,
        applyRecommendedEngine,
        setDirectorMode,
        applyHistory,
    });
    // 组件复用 / 后退恢复（bfcache）时 onMounted 不重跑：URL 场景参数变化但组件还是旧实例，
    // 这里按「状态与 URL 不一致」重放深链，让场景与提示词跟随新选择。
    watch(() => route.query, async (q) => {
        if (route.path !== '/prompt-builder' || !deepLinkNeeded(q))
            return;
        if (await applyDeepLink(q) && !generationBusy.value) {
            if (pb.directorMode === 'basic' && !['remix', 'regen', 'variant'].some(key => typeof q[key] === 'string'))
                void applyManagedRoute({ silent: true });
            else
                void refreshManagedRoute();
        }
    });
    const generationContext = { pb, applyManagedRoute, drawEngine, sd, livePrompt, currentCapabilities, generateAnima, sdErrorReport, captureJob, runJob, tempResultTools, sdSize, animaState, patchAnimaState, displayResultSeed, resetBlueprintRotation }
    function callGenerate(opts: {
        disableLora?: boolean;
    } = {}): Promise<void> { return import('./promptGenerationActions').then(({ callGenerateAction }) => callGenerateAction(generationContext, opts)); }
    function runRecovery(id: SDRecoveryId): Promise<void> { return import('./promptGenerationActions').then(({ runRecoveryAction }) => runRecoveryAction(generationContext, id)); }
    function upscaleCurrentResult(): Promise<void> { return import('./promptGenerationActions').then(({ upscaleCurrentResultAction }) => upscaleCurrentResultAction(generationContext)); }
    function resetAll(): Promise<void> { return import('./promptGenerationActions').then(({ resetAllAction }) => resetAllAction(generationContext)); }
    // Each lazy panel receives a stable, explicit capability surface. Store fields are
    // projected with toRef, so writes still reach the single existing state owner.
    const materialBindings: PromptMaterialBindings = {
        popularBlueprintPool, blueprintCategories, recommendedBlueprints, filteredPopularBlueprints,
        popularCategory, showAllBlueprints, availableScenes, visibleScenes, sceneCollection,
        personaCoreCount, curatedCount, personaCoreIds, sceneLimit, selectBlueprint,
        rotateBlueprintSet, toggleBlueprintList, setSceneCollection, selectScene,
    };
    const renderBindings: PromptRenderBindings = {
        pb: reactive({
            directorMode: toRef(pb, 'directorMode'), history: toRef(pb, 'history'),
            subject: toRef(pb, 'subject'), isPopular: toRef(pb, 'isPopular'), char: toRef(pb, 'char'),
            sdModelName: toRef(pb, 'sdModelName'), sdParams: toRef(pb, 'sdParams'), markParamTouched: pb.markParamTouched,
        }),
        sd: { models: sd.models, samplers: sd.samplers, schedulers: sd.schedulers },
        sdQueue: { canEnqueue: sdQueue.canEnqueue },
        displayResultUrl, generationBusy, animaState, drawEngine, upscaleCurrentResult,
        generationPresetSummary, managedRoute, applyManagedRoute, reuseSuccessfulRecipe,
        engineTitle, setDrawEngine, supportsDualCharacter, BUSY_HINT, selectAnimaModel,
        displayResultSeed, reuseLastSeed, resetSdParams, animaNoLoraMode, patchAnimaState,
        retryAnima, vramHint, vramLevel, baseResolutionRisk, baseResolutionHint,
        canUseFaceDetailer, enqueueCurrent, enqueue3Variants, resetAll,
    };
    const styleBindings: PromptStyleBindings = {
        pb: reactive({ directorMode: toRef(pb, 'directorMode'), artistStyleIds: toRef(pb, 'artistStyleIds'),
            currentCuratedArtistStyles: toRef(pb, 'currentCuratedArtistStyles'), setArtistStyleIds: pb.setArtistStyleIds }),
        drawEngine, emotionSummary, shotSummary, lightingSummary, compositionSummary, moodSummary, onArtistLimitReached,
    };
    const healthBindings: PromptHealthBindings = {
        pb: reactive({ directorMode: toRef(pb, 'directorMode'), isPopular: toRef(pb, 'isPopular') }),
        previewPromptView, modelProfileView, reportView, artViolationsView, loraSpecs, copyPrompt, saveCurrentResult,
    };
    const deliveryBindings: PromptDeliveryBindings = {
        pb: reactive({ char: toRef(pb, 'char'), activeScene: toRef(pb, 'activeScene'), story: toRef(pb, 'story') }),
        voiceStudioRef, sdOnline: sd.online, animaOnline: computed(() => animaState.value.online),
        scenes: toRef(sceneStore, 'sceneBlueprints'), generationBusy, generationProgress, drawEngine,
        shotsPending, goToShots,
        sdQueue: { total: sdQueue.total, done: sdQueue.done, paused: sdQueue.paused,
            activeJob: sdQueue.activeJob, queue: sdQueue.queue,
            pause: sdQueue.pause, resume: sdQueue.resume, clear: sdQueue.clear, remove: sdQueue.remove },
        BUSY_HINT, autoSaveToGallery, batchRunning, batchOpen, sdErrorReport, runRecovery,
        dismissError, queuePausedReason, batchPanelDeps,
    };
    const dialogBindings: PromptDialogBindings = {
        compareEl, adultEnabled: toRef(pb, 'showMatureScenes'), resultBlob: computed(() => animaState.value.result?.blob),
        displayResultUrl, generationBusy, prevResult, inpaintOpen, compareOpen, displayResultSeed,
        lastResult, closeCompare, livePrompt, negativePrompt, inpaintCharacter, handleInpaintSubmit,
    };
    usePromptLifecycle({
        refreshShotsPending, refreshAnimaBackend, drawEngine, sd, startStatusPolling, DIRECTOR_MODE_KEY,
        pb, sceneCollection, applyDeepLink, route, displayResultUrl, restoreTempResult, sdSize,
        applyManagedRoute, refreshManagedRoute, restorePopularDraft,
        animaState, patchAnimaState, engineOnline, livePrompt, callGenerate, effectiveNegative,
        updateAnimaPromptState, setDrawEngine, syncManagedRoute, popularBlueprintPool, blueprintCategories,
        popularCategory, syncAnimaCharacter, sceneLimit, applyRecommendedSize, animaSession,
    });
    return {
        pb, displayResultUrl, characterShifting, currentCharacterThemeStyle, popularCharacter, sd,
        animaSession, archiveBarShape, modeDescription, setDirectorMode, engineOnline, engineStatusText,
        recheckEngineConnection, drawEngineLabel, currentBlueprintData, handleLoadBlueprint, route, currentTraits,
        selectPopularSource, selectPopularCharacter, selectPopularOutfit, resumeHistory, duplicateHistory, deleteHistory,
        handleHistoryToShots, handleHistoryToShotsBatch, generationBusy, generationError, generationStopped, generationStatusText,
        generationProgress, animaState, drawEngine, inpaintOriginalUrl, inpaintCompareActive,
        shotsPending, prevResult, resultArchived, savingResult, resultTemporary, hasStashedResult,
        callGenerate, inpaintOpen, inspector, materialDrawer, upscaleCurrentResult, goToVideo,
        addToShots, goToShots, saveResult, compareOpen, onClearResult, onRestoreStashed,
        handleInterrogateResult, handleInterrogateError, genBarSize, animaBarSizes, generationPresetSummary, generateBlockReason,
        cancelGeneration, outfitOverridden, outfitReplacedLabel, outfitOverrideTokens, sdQueue,
        materialBindings, renderBindings, styleBindings, healthBindings, deliveryBindings, dialogBindings,
    };
}

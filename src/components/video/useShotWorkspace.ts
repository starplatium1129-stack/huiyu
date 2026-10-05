import { withArtworkStaging } from '@/storage/artworkSession'
import { createVideoStoryboard,uploadVideoImage,type VideoBatch,type VideoDefaults,type VideoQuality,type VideoStatusResponse,} from '@/api/videoApi';
import { confirmAction } from '@/composables/useConfirm';
import { artworkRepository } from '@/storage/artworkRepository'
import { useSceneStore } from '@/stores/sceneStore';
import { useVideoStore } from '@/stores/videoStore';
import { computed,onActivated,onBeforeUnmount,onDeactivated,onMounted,ref,watch } from 'vue';
import { useRoute,useRouter } from 'vue-router';
import type { ShotDraft } from './shotListTypes';
import { useReferenceCards, removeCastSlot } from './useReferenceCards';
import { useShotAiTools } from './useShotAiTools';
import { useShotBatchMachine } from './useShotBatchMachine';
import { useShotDraft } from './useShotDraft';
import { useShotFirstFrames } from './useShotFirstFrames';
import { inferShotParams,useShotImport } from './useShotImport';
/** Owns workspace state and lifecycle; the view only binds presentation. */
export function useShotWorkspace(props: {
    status: VideoStatusResponse | null;
}) {
    const route = useRoute(), router = useRouter();
    const videoStore = useVideoStore();
    const sceneStore = useSceneStore();
    const sceneBlueprints = computed(() => sceneStore.sceneBlueprints);
    const popularCharacters = computed(() => sceneStore.popularCharacters);
    const h3Ready = computed(() => props.status?.models.some((model) => model.id === 'minimax-h3' && model.available) === true);
    const aspectOptions: Array<{
        id: VideoBatch['aspectRatio'];
        label: string;
    }> = [
        { id: 'landscape', label: '横屏 16:9' },
        { id: 'portrait', label: '竖屏 9:16' },
        { id: 'square', label: '方形 1:1' },
    ];
    const cameraOptions: Array<{
        id: VideoDefaults['camera'];
        label: string;
    }> = [
        { id: 'still', label: '固定镜头 · 最稳' },
        { id: 'push', label: '缓慢推进' },
        { id: 'pull', label: '缓慢拉远' },
        { id: 'pan', label: '平稳横移' },
        { id: 'orbit', label: '轻微环绕' },
    ];
    const motionOptions: Array<{
        id: VideoDefaults['motion'];
        label: string;
    }> = [
        { id: 'subtle', label: '细微运动 · 最稳' },
        { id: 'natural', label: '自然动作' },
        { id: 'expressive', label: '表现动作' },
    ];
    const aspectRatio = ref<VideoBatch['aspectRatio']>('landscape');
    const quality = ref<VideoQuality>('standard');
    const steps = ref<4 | 8>(8);
    const linkLastFrame = ref(true);
    const identityCard = ref('');
    const sceneFillId = ref('');
    const shots = ref<ShotDraft[]>([]);
    const frameInputs = ref<HTMLInputElement[]>([]);
    const frameRequests = new Map<ShotDraft, AbortController>();
    const frameUploads = ref(0);
    function cancelFrameRequests() { for (const request of frameRequests.values()) request.abort(); }
    onDeactivated(cancelFrameRequests);
    watch(() => [...shots.value], next => {
        for (const [shot, request] of frameRequests) if (!next.includes(shot)) request.abort();
    });
    // ── 场景蓝图一键剧本（2026-08-23）：服务端起承转合四镜确定性派生 ──────────
    // 与「AI 生成脚本」互补：零 LLM 依赖、即时返回，台词取蓝图原文；生成会整体
    // 替换镜头草稿（用户主动点生成即明确意图，草稿未提交可随时撤销重生成）。
    const storyboardBlueprintId = ref('');
    const storyboardIntent = ref('');
    const storyboardBusy = ref(false);
    async function runStoryboard() {
        const blueprintId = storyboardBlueprintId.value;
        if (!blueprintId || storyboardBusy.value)
            return;
        storyboardBusy.value = true;
        batchError.value = '';
        try {
            const intent = storyboardIntent.value.trim();
            const res = await createVideoStoryboard(blueprintId, intent || undefined);
            shots.value = res.storyboard.shots.map((shot) => ({
                prompt: shot.prompt,
                dialogue: shot.dialogue ?? '',
                shotSize: shot.shotSize,
                camera: shot.camera,
                motion: shot.motion,
                // 服务端固定产 3 秒；这里对 API number 做字面量收窄，非法值回落 3。
                duration: (shot.duration === 5 || shot.duration === 10 || shot.duration === 15 ? shot.duration : 3) as ShotDraft['duration'],
                seedText: '',
                imageName: '',
                imageUrl: '',
                cast: '',
                firstFramePrompt: shot.firstFramePrompt ?? undefined,
            }));
            storyboardBlueprintId.value = '';
            storyboardIntent.value = '';
        }
        catch (error) {
            batchError.value = error instanceof Error ? error.message : '剧本生成失败，请稍后重试';
        }
        finally {
            storyboardBusy.value = false;
        }
    }
    /** 本组件共用的用户可见错误通道：批量提交/轮询/重抽、首帧与参考图上传失败都回写这里。 */
    const batchError = ref('');
    // ── 一键首帧（2026-08-23）：逐镜 Krea2 增强链路出图 → 上传受控文件 → 回填 ──
    const { firstFrameBusy, firstFrameProgress, generateFirstFrames } = useShotFirstFrames({
        shots, frameRequests,
        onError: (message) => { batchError.value = message; },
    });
    // ── 角色参考卡（Ref2VA）编排已下沉 useReferenceCards ─────────────────────
    const { referenceCards, loadingRefAssets, loadingRefCardIndex, getCharOutfits, addReferenceCard, removeReferenceCard, switchCardOutfit, selectCardCharacter, onCardCharacterSelected, onReferencePicked, pickReference, setReferenceInput, removeReference, shotReferences } = useReferenceCards({
        identityCard,
        batchError,
        readBlobAsDataURL,
        uploadVideoImage,
        onCardRemoved: index => { shots.value.forEach(shot => { shot.cast = removeCastSlot(shot.cast, index); }); },
    });
    // ── 批量提交状态机（提交/3s 轮询/取消/重抽/拼接）已下沉 useShotBatchMachine ──
    const { batch, submitting, cancelling, concating, retrying, batchActive, canSubmit, canConcat, progressPercent, serverShot, getShotSubmission, restoreShotSubmission, submitBatch, cancelBatch, retryShotAt, retryAllFailed, concatBatch, reconnectBatch } = useShotBatchMachine({
        shots,
        identityCard,
        aspectRatio,
        quality,
        steps,
        linkLastFrame,
        shotReferences,
        inputsBusy: computed(() => loadingRefAssets.value || firstFrameBusy.value || frameUploads.value > 0),
        h3Ready,
        online: computed(() => props.status?.online === true),
        batchError,
        onSubmitting: (targets) => beginShotSubmission(targets),
        onSubmissionRejected: (targets) => finishShotSubmission(targets),
        onSubmitted: (targets, batchId) => finishShotSubmission(targets, batchId),
        onAccepted: (value) => {
            if (!videoStore.recordShotsBatch({ batchId: value.id, submittedAt: Date.now() }))
                batchError.value = '分镜批次已提交，但批次记录保存失败；请在任务中心保留并核对任务。';
        },
    });
    // ── AI 整理链路（逐镜整理/整批编排/脚本/台词/质检）已下沉 useShotAiTools ──
    const { aiBusy, aiNote, aiSnapshot, polishSnapshot, aiFlowStep, flowHint, scriptOpen, scriptStory, scriptCount, scriptTotal, scriptBusy, runAiRewrite, restoreAiSnapshot, runAiPolish, restorePolishSnapshot, runAiScript, dialogueIndex, dialogueOptions, dialogueBusy, runAiDialogue, applyDialogueOption, reviewIssues, reviewBusy, runAiReview, applyReviewSuggestion, shotIssueCount } = useShotAiTools({
        shots,
        identityCard,
        batchActive,
        referenceCards,
    });
    // ── 绘图页「加入分镜」导入（逐镜确认 + 失败可重试，已下沉 useShotImport）──
    const { importShotsFromDrawing, retryPendingFrames, mountShotFrame } = useShotImport({
        shots, frameRequests,
        referenceCards,
        selectCardCharacter,
    });
    /** 单镜首帧重试（F4）：导入失败/草稿恢复图失效的镜头可单独补救。 */
    async function retryShotFrame(index: number) {
        const shot = shots.value[index];
        if (!shot?.imageId || shot.imageName)
            return;
        const ok = await mountShotFrame(shot, shot.imageId);
        if (ok !== undefined) batchError.value = ok ? '' : `镜头 ${index + 1} 首帧暂未挂载：请重试，或重新上传图片`;
    }
    const submitTitle = computed(() => {
        if (batchActive.value)
            return '整批正在生成中';
        if (!props.status?.online)
            return '先启动 ComfyUI';
        if (!h3Ready.value)
            return '先安装 MiniMax H3 权重';
        if (shots.value.length === 0)
            return '先添加镜头';
        if (submitting.value) return '正在提交镜头';
        if (retrying.value) return '正在重新提交失败镜头';
        if (cancelling.value) return '正在取消整批';
        if (concating.value) return '正在拼接成片';
        if (loadingRefAssets.value || firstFrameBusy.value || frameUploads.value > 0) return '正在准备参考图与首帧';
        if (shots.value.some(shot => shot.seedText.trim() && (!Number.isSafeInteger(Number(shot.seedText)) || Number(shot.seedText) < 0 || Number(shot.seedText) > 0x7fffffff))) return '请检查镜头 Seed：需为 0–2147483647 的整数';
        if (!canSubmit.value)
            return `${shots.value.filter(shot => shot.prompt.trim().length < 8 || shot.prompt.trim().length > 4000).length} 个镜头描述需调整（8–4000 字）`;
        return `${shots.value.length} 镜 · ${aspectRatio.value === 'landscape' ? '横屏' : aspectRatio.value === 'portrait' ? '竖屏' : '方形'} · ${qualityLabel.value}`;
    });
    const submitDescription = computed(() => {
        if (batchActive.value)
            return '逐镜串行排队，可离开页面；失败镜头可单独重抽。';
        if (!props.status?.online)
            return '控制面板启动 ComfyUI 后，回到这里重新检测即可。';
        return '服务端按官方三段式组装提示词；开启衔接时自动抽取上一镜尾帧。';
    });
    const batchStatusLabel = computed(() => ({
        running: '正在逐镜生成…',
        paused: '有镜头失败，可单独重抽',
        done: '全部完成',
        cancelled: '已取消',
    })[batch.value?.status ?? 'running']);
    const qualityLabel = computed(() => props.status?.qualities.find((item) => item.id === quality.value)?.label ?? quality.value);
    function shotStatusLabel(status: string | undefined) {
        return ({
            pending: '等待中',
            queued: '排队中',
            running: '生成中',
            succeeded: '已完成',
            failed: '失败',
            cancelled: '已取消',
        })[status ?? 'pending'] ?? '等待中';
    }
    function addShot() {
        shots.value.push({
            prompt: '',
            dialogue: '',
            shotSize: '',
            camera: 'still',
            motion: 'subtle',
            duration: 5,
            seedText: '',
            imageName: '',
            imageUrl: '',
            cast: '',
        });
    }
    // 参数自动推断与导入链共用同一实现（useShotImport）。
    /**
     * 删除 / 清空的破坏性确认（2026-08-30 UX 审计 P1）。
     *
     * 每镜描述上限 4000 字、首帧是现算的图，误点一次整段消失；分镜只做
     * sessionStorage 覆盖写，没有任何回退路径。
     *
     * 单镜删除**只在镜头有内容时**拦一次——空白镜头没什么可失去的，快速增删
     * 是正常排版动作，每删一个都弹窗反而逼用户养成无脑确认的习惯（那才是
     * 确认框真正失效的方式）。清空则无条件拦。
     */
    async function removeShot(index: number) {
        const shot = shots.value[index];
        if (!shot)
            return;
        const hasContent = Boolean(shot.prompt?.trim() || shot.dialogue?.trim() || shot.imageUrl || shot.firstFramePrompt?.trim());
        if (hasContent) {
            const ok = await confirmAction({
                title: `删除第 ${index + 1} 镜？`,
                message: '这一镜的描述、台词与首帧会一起删掉，且无法撤销。',
                confirmLabel: '删除',
                danger: true,
            });
            if (!ok)
                return;
        }
        if (shot.imageUrl)
            URL.revokeObjectURL(shot.imageUrl);
        shots.value.splice(index, 1);
    }
    async function clearShots() {
        if (!shots.value.length)
            return;
        const ok = await confirmAction({
            title: `清空全部 ${shots.value.length} 个镜头？`,
            message: '所有镜头的描述、台词与首帧会一起清掉，且无法撤销。',
            confirmLabel: '清空',
            danger: true,
        });
        if (!ok)
            return;
        shots.value.forEach((shot) => {
            if (shot.imageUrl)
                URL.revokeObjectURL(shot.imageUrl);
        });
        shots.value = [];
    }
    function moveShot(index: number, delta: number) {
        const target = index + delta;
        if (target < 0 || target >= shots.value.length)
            return;
        const [item] = shots.value.splice(index, 1);
        shots.value.splice(target, 0, item);
    }
    // Explicit character links win over restored drafts, but ordinary activation never resets edits.
    const routeReady = ref(false), routeActive = ref(true);
    let routeLoad: AbortController | null = null, consumedIntent = '';
    const routeCharacter = () => typeof route.query.character === 'string' ? route.query.character.trim() : '';
    const routeOutfit = () => typeof route.query.outfit === 'string' ? route.query.outfit.trim() : '';
    watch([routeReady, routeActive, () => route.path, routeCharacter, routeOutfit], async () => {
        if (!routeReady.value) return;
        if (!routeActive.value || route.path !== '/video-studio') { if (routeLoad) consumedIntent = ''; routeLoad?.abort(); return; }
        const id = routeCharacter(), outfit = routeOutfit(), intent = JSON.stringify([id, outfit]);
        if (!id) { consumedIntent = ''; routeLoad?.abort(); return; }
        if (intent === consumedIntent) return;
        routeLoad?.abort();
        const controller = new AbortController(); routeLoad = controller; consumedIntent = intent;
        try {
            await selectCardCharacter(id, 0, outfit || undefined, controller.signal);
            if (controller.signal.aborted || !routeActive.value || route.path !== '/video-studio' || routeCharacter() !== id || routeOutfit() !== outfit) return;
            const card = referenceCards.value[0];
            if (card?.characterId === id && (!outfit || card.outfitId === outfit)) {
                shots.value.forEach(shot => { if (!shot.cast) shot.cast = '1'; });
            }
            await router.replace({ query: { ...route.query, character: undefined, outfit: undefined } });
        } catch (error) {
            if (!controller.signal.aborted && routeCharacter() === id && routeOutfit() === outfit) batchError.value = error instanceof Error ? error.message : '角色资料载入失败，请重试';
        } finally { if (routeLoad === controller) routeLoad = null; }
    });
    onActivated(() => { routeActive.value = true; });
    onDeactivated(() => { routeActive.value = false; if (routeLoad) consumedIntent = ''; routeLoad?.abort(); });
    // 场景蓝图 → 填入所有空镜头（用户已写的不覆盖），并顺带推断景别/镜头/运动。
    watch(sceneFillId, (id) => {
        if (!id)
            return;
        const blueprint = sceneBlueprints.value.find((item) => item.id === id);
        if (!blueprint)
            return;
        const prose = (blueprint.promptProse || '').trim()
            || [blueprint.description, blueprint.action, blueprint.lighting].filter(Boolean).join('，');
        if (prose) {
            shots.value.forEach((shot) => {
                if (!shot.prompt.trim()) {
                    shot.prompt = prose;
                    const inferred = inferShotParams(prose);
                    shot.shotSize = inferred.shotSize;
                    shot.camera = inferred.camera;
                    shot.motion = inferred.motion;
                }
            });
        }
        sceneFillId.value = '';
    });
    function pickFrame(index: number) {
        frameInputs.value[index]?.click();
    }
    async function onFramePicked(index: number, event: Event) {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0], shot = shots.value[index];
        input.value = '';
        if (!file || !shot) return;
        if (file.size > 20 * 1024 * 1024) { batchError.value = '首帧图片需 ≤20MB'; return; }
        frameRequests.get(shot)?.abort();
        const controller = new AbortController();
        frameRequests.set(shot, controller);
        const previous = [shot.imageId, shot.imageName, shot.imageUrl];
        const current = () => !controller.signal.aborted && frameRequests.get(shot) === controller
            && shots.value.includes(shot) && [shot.imageId, shot.imageName, shot.imageUrl].every((value, i) => value === previous[i]);
        frameUploads.value++;
        try {
            await withArtworkStaging(async () => {
                if (!current()) return;
                const dataUrl = await readBlobAsDataURL(file);
                if (!current()) return;
                const comma = dataUrl.indexOf(',');
                if (comma < 0) throw new Error('图片编码失败');
                const upload = await uploadVideoImage(dataUrl.slice(comma + 1), undefined, controller.signal);
                if (!current()) return;
                const imageId = await artworkRepository.putImage(file);
                if (!current()) return;
                if (shot.imageUrl) URL.revokeObjectURL(shot.imageUrl);
                shot.imageName = upload.name;
                shot.imageUrl = URL.createObjectURL(file);
                shot.imageId = imageId;
                batchError.value = '';
            });
        } catch (error) {
            if (current()) batchError.value = error instanceof Error ? error.message : '首帧上传失败';
        } finally {
            if (frameRequests.get(shot) === controller) frameRequests.delete(shot);
            frameUploads.value--;
        }
    }
    function clearFrame(index: number) {
        const shot = shots.value[index];
        if (shot) frameRequests.get(shot)?.abort();
        if (shot?.imageUrl)
            URL.revokeObjectURL(shot.imageUrl);
        if (shot) {
            shot.imageUrl = '';
            shot.imageName = '';
            shot.imageId = '';
        }
    }
    function readBlobAsDataURL(blob: Blob): Promise<string> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
            reader.onerror = () => reject(reader.error ?? new Error('图片读取失败'));
            reader.readAsDataURL(blob);
        });
    }
    // ── 绘图页「加入分镜」批量带入（F4：逐镜确认 + 如实汇报；实现已下沉 useShotImport）──
    async function runImportFromDrawing() {
        const outcome = await importShotsFromDrawing();
        if (!outcome)
            return;
        const parts = [`已从绘图页带入 ${outcome.imported} 个镜头`, `首帧就绪 ${outcome.framesReady} 张`];
        if (outcome.framesPending)
            parts.push(`${outcome.framesPending} 张待处理（可在镜头上单独重试）`);
        if (outcome.charactersFailed)
            parts.push(`${outcome.charactersFailed} 位角色资料读取失败，请重新选择`);
        batchError.value = parts.join('，') + '。';
        aiFlowStep.value = 0;
    }
    // ── 剧本模式分幕带入（2026-08-23 激活）：剧本页「送入分镜短片」一次性消费 ──
    // 仅在镜头列表为空时导入（不覆盖绘图页带入或用户草稿）；工作室角色不在热门
    // 角色库，参考卡与身份卡由用户手动挂载（Ref2VA 锁身份）。
    function importScenarioActs() {
        const acts = videoStore.consumeScenarioActs();
        if (!acts.length || shots.value.length)
            return;
        shots.value = acts.map((act) => ({
            prompt: act.prompt,
            dialogue: act.dialogue,
            shotSize: act.shotSize,
            camera: act.camera,
            motion: act.motion,
            duration: (act.duration === 5 || act.duration === 10 || act.duration === 15 ? act.duration : 3) as ShotDraft['duration'],
            seedText: '',
            imageName: '',
            imageUrl: '',
            cast: '',
        }));
        batchError.value = `已载入剧本 ${acts.length} 幕。可选择角色并按需上传参考图，再点「一键首帧」或批量生成。`;
    }
    // ── 分镜草稿持久化（2026-09-06 体验报告 F1）────────────────────────────────
    // 切模式（v-if 卸载）/切页/刷新后恢复：镜头文本 + 身份锚点 + 参考卡元信息。
    // 首帧图只存 IndexedDB 图片 id，恢复时重挂载（服务端受控文件名会被清理）。
    const { restoreShotsDraft, beginShotSubmission, finishShotSubmission } = useShotDraft({
        aspectRatio, quality, steps, linkLastFrame, identityCard, referenceCards, shots,
        batchError, selectCardCharacter, retryPendingFrames, getShotSubmission, restoreShotSubmission,
    });
    /** 整批任务重连（F1）：离页不中断服务端批次，回来按 batchId 接回真实进度。 */
    async function reconnectShotsBatch() {
        const requestedBatch = typeof route.query.batch === 'string' ? route.query.batch : '';
        const record = requestedBatch ? { batchId: requestedBatch } : videoStore.shotsBatch;
        if (!record)
            return;
        const ok = await reconnectBatch(record.batchId);
        if (!ok) {
            if ((typeof route.query.batch === 'string' ? route.query.batch : '') !== requestedBatch) return;
            if (videoStore.shotsBatch?.batchId === record.batchId) videoStore.clearShotsBatch();
            batchError.value ||= '上一批分镜任务已不存在（网关重启或已过期），镜头草稿仍在，可重新提交';
        }
    }
    watch(() => route.query.batch, () => {
        if (route.path === '/video-studio') void reconnectShotsBatch();
    });
    watch(() => videoStore.shotsBatch?.batchId, id => {
        if (!route.query.batch && !submitting.value && route.path === '/video-studio'
            && shots.value.some(shot => getShotSubmission(shot)?.batchId === id)) void reconnectShotsBatch();
    });
    onMounted(() => {
        void sceneStore.loadCharacterShell().catch(() => { batchError.value = '角色目录读取失败，请刷新页面重试'; });
        void (async () => {
            await restoreShotsDraft();
            await runImportFromDrawing();
            importScenarioActs();
            routeReady.value = true;
            await reconnectShotsBatch();
        })();
    });
    onBeforeUnmount(() => {
        cancelFrameRequests();
        routeLoad?.abort(); routeActive.value = false;
        // 批量轮询与 disposed 标记归 useShotBatchMachine；这里只释镜头首帧 blob URL。
        shots.value.forEach((shot) => {
            if (shot.imageUrl)
                URL.revokeObjectURL(shot.imageUrl);
        });
    });
    return {
frameInputs,
        h3Ready, aspectOptions, aspectRatio, quality, linkLastFrame, steps,
        identityCard, loadingRefCardIndex, referenceCards, batchActive, addReferenceCard, onCardCharacterSelected,
        popularCharacters, removeReferenceCard, getCharOutfits, switchCardOutfit, removeReference, pickReference,
        setReferenceInput, onReferencePicked, shots, sceneFillId, sceneBlueprints, addShot,
        storyboardBlueprintId, storyboardIntent, storyboardBusy, runStoryboard, firstFrameBusy, generateFirstFrames,
        firstFrameProgress, aiBusy, runAiRewrite, runAiPolish, scriptBusy, scriptOpen,
        reviewBusy, runAiReview, aiSnapshot, restoreAiSnapshot, polishSnapshot, restorePolishSnapshot,
        clearShots, aiNote, flowHint, reviewIssues, applyReviewSuggestion, shotIssueCount,
        serverShot, shotStatusLabel, moveShot, removeShot, dialogueBusy, runAiDialogue,
        dialogueIndex, dialogueOptions, applyDialogueOption, cameraOptions, motionOptions, pickFrame,
        retryShotFrame, clearFrame, onFramePicked, retryShotAt, scriptStory, scriptCount,
        scriptTotal, runAiScript, canSubmit, submitTitle, submitDescription, cancelling,
        cancelBatch, batch, retryAllFailed, canConcat, concating, concatBatch,
        submitBatch, submitting, retrying, batchError, batchStatusLabel, progressPercent,
    };
}

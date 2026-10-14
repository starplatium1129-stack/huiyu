import { profileLocalStorage as localStorage } from '../../platform/web/profileStorage.ts'
import { useSceneStore } from '@/stores/sceneStore'
import { settingsRepository, STARTER_MODEL_SETTING } from '@/storage/settingsRepository'

import { nextTick,onActivated,onBeforeUnmount,onDeactivated,onMounted,watch } from 'vue';
import type { RouteLocationNormalizedLoaded, Router } from 'vue-router';
import type { UseDirectorPopularInput, useDirectorPopular } from '@/composables/scene/useDirectorPopular';
import type { useDirectorEngine } from '@/composables/scene/useDirectorEngine';
import type { useAnimaSession } from '@/composables/generation/useAnimaSession';
import type { useUnifiedPromptAssembly } from '@/composables/useUnifiedPromptAssembly';
import type { usePromptMaterials } from './usePromptMaterials';
import type { usePromptDeepLink } from './usePromptDeepLink';
import type { useTempResult } from './useTempResult';
import type { usePromptVideoBridge } from './usePromptVideoBridge';

export interface PromptLifecycleDeps extends
    Pick<UseDirectorPopularInput, 'generationBusy' | 'pb' | 'sd' | 'drawEngine' | 'sdSize' | 'animaState' | 'patchAnimaState' | 'refreshAnimaBackend' | 'setDrawEngine' | 'applyRecommendedSize'>,
    Pick<ReturnType<typeof useDirectorPopular>, 'applyPreparedModel' | 'applyManagedRoute' | 'refreshManagedRoute' | 'restorePopularDraft' | 'syncManagedRoute' | 'popularBlueprintPool' | 'blueprintCategories' | 'popularCategory'>,
    Pick<ReturnType<typeof useDirectorEngine>, 'displayResultUrl' | 'engineOnline' | 'updateAnimaPromptState'>,
    Pick<ReturnType<typeof usePromptMaterials>, 'sceneCollection' | 'sceneLimit'>,
    Pick<ReturnType<typeof usePromptDeepLink>, 'applyDeepLink'>,
    Pick<ReturnType<typeof useTempResult>, 'restoreTempResult'>,
    Pick<ReturnType<typeof usePromptVideoBridge>, 'refreshShotsPending'> {
    route: RouteLocationNormalizedLoaded;
    router: Router;
    DIRECTOR_MODE_KEY: string;
    syncAnimaCharacter: ReturnType<typeof useAnimaSession>['syncCharacter'];
    animaSession: Pick<ReturnType<typeof useAnimaSession>, 'startStatusPolling' | 'stopStatusPolling' | 'pauseStatusPolling'>;
    livePrompt: ReturnType<typeof useUnifiedPromptAssembly>['positivePrompt'];
    effectiveNegative: ReturnType<typeof useUnifiedPromptAssembly>['negativePrompt'];
    callGenerate: () => Promise<void>;
}

/** Installed once by the workspace owner, independent of how its view exposes panels. */
export function usePromptLifecycle({ router, generationBusy, applyPreparedModel, refreshShotsPending, refreshAnimaBackend, drawEngine, sd, DIRECTOR_MODE_KEY, pb, sceneCollection, applyDeepLink, route, displayResultUrl, restoreTempResult, sdSize, applyManagedRoute, refreshManagedRoute, restorePopularDraft, animaState, patchAnimaState, engineOnline, livePrompt, callGenerate, effectiveNegative, updateAnimaPromptState, setDrawEngine, syncManagedRoute, popularBlueprintPool, blueprintCategories, popularCategory, syncAnimaCharacter, sceneLimit, applyRecommendedSize, animaSession }: PromptLifecycleDeps): void {
    // A delayed storage/backend response must not resume setup or submit a deep-link job
    // after its workspace has been destroyed. KeepAlive deactivation retains its tasks.
    let disposed = false;
    let viewActive = true;
    let draftInitialized = false;
    let consumedPreparedQuery: unknown;
    async function applyPreparedLink() {
        const q = route.query;
        if (route.path !== '/prompt-builder' || typeof q.preparedModel !== 'string' || q === consumedPreparedQuery) return;
        consumedPreparedQuery = q;
        const modelId = q.preparedModel, wasBusy = generationBusy.value;
        const query = { ...q }; delete query.preparedModel;
        const target = router.resolve({ path: route.path, query, hash: route.hash }).fullPath;
        await router.replace(target);
        const current = () => !disposed && viewActive && consumedPreparedQuery === q && route.fullPath === target;
        if (!current() || ['remix', 'regen', 'variant'].some(key => typeof q[key] === 'string')) return;
        if (wasBusy || generationBusy.value) { pb.flash('生成进行中，完成或停止后再从控制室选用准备的底模'); return; }
        if (modelId !== settingsRepository.get(STARTER_MODEL_SETTING)) {
            pb.flash('准备的底模选择已改变，请回到控制室重新检查');
            return;
        }
        await applyPreparedModel(modelId, current);
    }
    watch(() => route.query, () => { if (draftInitialized && viewActive) void applyPreparedLink(); });
    function saveWorkspaceDraft() {
        // Backend defaults may arrive before the saved inputs have been adopted.
        if (!draftInitialized) return;
        if (drawEngine.value === 'sd') pb.sdParams.size = sdSize.value;
        pb.saveDraft?.();
    }
    onBeforeUnmount(() => { disposed = true; viewActive = false; });
    onDeactivated(() => { viewActive = false; consumedPreparedQuery = undefined; animaSession.pauseStatusPolling(); });
    onActivated(async () => {
        if (viewActive || disposed)
            return;
        viewActive = true;
        if (!useSceneStore().loaded) {
            await pb.loadData();
            if (pb.subject.kind === 'popular') await pb.loadPopularCharacter(pb.subject.characterId);
            if (disposed || !viewActive) return;
        }
        if (draftInitialized) await applyPreparedLink();
        if (disposed || !viewActive) return;
        if (drawEngine.value !== 'sd')
            animaSession.startStatusPolling();
    });
    // ── Lifecycle ─────────────────────────────────────────────────────────────
    onMounted(async () => {
        void refreshShotsPending();
        void refreshAnimaBackend();
        // Anima 后端只在引擎激活时轮询：SD 引擎下每 15s 打一次 /api/creative/status
        // 会让网关反复探测 ComfyUI（2.5s 超时 + 磁盘资源检查），纯属浪费。
        if (drawEngine.value !== 'sd')
            animaSession.startStatusPolling();
        const savedMode = localStorage.getItem(DIRECTOR_MODE_KEY);
        if (savedMode === 'pro' || savedMode === 'basic') {
            pb.directorMode = savedMode;
            sceneCollection.value = savedMode === 'pro' ? 'all' : 'core';
        }
        await pb.loadData();
        if (disposed) return;
        await refreshAnimaBackend();
        if (disposed) return;
        await sd.checkStatus();
        if (disposed) return;
        // 拿到 WebUI 真实 checkpoint 后，再按对应 model profile 填参数
        pb.applyModelProfile(pb.sdModelName || sd.checkpoint.value);
        // 历史载入（IndexedDB）
        await pb.loadHistory();
        if (disposed) return;
        // 深链参数恢复（?scene / ?char / ?mood / ?scenario / ?regen / ?resume / ?quick / ?variant / ?generate）
        if (typeof route.query.remix === 'string' || typeof route.query.variant === 'string') pb.restoreDraft();
        const handledDeepLink = await applyDeepLink(route.query);
        if (disposed) return;
        if (!handledDeepLink)
            pb.restoreDraft();
        if (pb.subject.kind === 'popular') await pb.loadPopularCharacter(pb.subject.characterId);
        if (disposed) return;
        // F2：画布为空时找回上次未入册的临时成片（深链出图优先，不抢新任务）。
        if ((!handledDeepLink || route.query.resume === '1') && !displayResultUrl.value) {
            await restoreTempResult();
            if (disposed) return;
        }
        const restoredRecipe = handledDeepLink && ['remix', 'regen', 'variant'].some(key => typeof route.query[key] === 'string');
        // Explicit history/scene links own their size; resumed drafts keep a user-picked SD size.
        if (!restoredRecipe && drawEngine.value === 'sd' && (!handledDeepLink || route.query.resume === '1')
            && pb.sdParamsTouched.has('size') && /^\d+x\d+$/.test(pb.sdParams.size))
            sdSize.value = pb.sdParams.size;
        else if (!restoredRecipe && pb.lastRecommendedSize)
            sdSize.value = pb.lastRecommendedSize;
        if (!restoredRecipe && pb.directorMode === 'basic')
            await applyManagedRoute({ silent: true });
        else
            await refreshManagedRoute();
        if (disposed) return;
        // 热门角色草稿恢复（底模/蓝图尺寸/导演决策/后端白名单收敛）已下沉 useDirectorPopular
        if (!restoredRecipe && typeof route.query.companionDraft !== 'string') restorePopularDraft();
        await applyPreparedLink();
        if (disposed) return;
        draftInitialized = true;
        saveWorkspaceDraft();
        if (route.query.quick === '1' && typeof route.query.companionDraft !== 'string') {
            const [{ quickCreateSummary, readQuickCreate }, { useQuickCreateApply }] = await Promise.all([import('@/utils/quickCreate'), import('./useQuickCreateApply')]);
            if (disposed) return;
            const { applyQuickCreateSettings } = useQuickCreateApply({ pb, sd, sdSize });
            const savedQuick = readQuickCreate();
            applyQuickCreateSettings(savedQuick);
            // 快速出图深链：Anima 引擎必须收敛到受控路线推荐的底模（工作室角色 → MiaoMiao v1.6），
            // pro 模式不会走 applyManagedRoute，这里显式对齐到当前推荐底模。
            if (drawEngine.value !== 'sd' && !pb.isPopular) {
                const route = await refreshManagedRoute();
                if (disposed) return;
                if ((route.engine === 'anima' || route.engine === 'krea2')
                    && animaState.value.modelId !== route.modelId
                    && animaState.value.models.some(model => model.id === route.modelId)) {
                    patchAnimaState({ modelId: route.modelId });
                }
            }
            await nextTick();
            if (disposed) return;
            if (!engineOnline.value) {
                pb.flash('快速出图未启动：SD WebUI 当前未连接，Prompt 已保留');
            }
            else if (livePrompt.value) {
                const reused = quickCreateSummary(savedQuick);
                pb.flash(reused ? `正在快速出图 · ${reused}` : '正在使用当前推荐参数快速出图');
                await callGenerate();
            }
        }
        else if (route.query.generate === '1' && typeof route.query.companionDraft !== 'string') {
            // 样张/场景抽屉的「调整后生成」：场景与词条已在上面载入，这里直接出图
            await nextTick();
            if (disposed) return;
            if (!engineOnline.value) {
                pb.flash(`${drawEngine.value === 'anima' ? 'Anima' : drawEngine.value === 'krea2' ? 'Krea 2' : 'SD WebUI'} 未连接，场景与词条已就位，可稍后生成`);
            }
            else if (livePrompt.value) {
                pb.flash('正在按调整后的场景生成');
                await callGenerate();
            }
        }
    });
    // 离开导演台时的 Anima 会话清理（轮询停止、在途任务取消、结果 URL 释放）
    // 由 useAnimaSession 的自动 onUnmounted(dispose) 承担。
    // Autosave draft
    watch(() => [pb.story, pb.visualDescription, pb.char, pb.sceneId, pb.selections, pb.manualTags,
        pb.artistStyleIds, pb.colorMood, pb.subject, pb.sdParams, pb.sdParamsTouched, pb.projectId, sdSize.value], saveWorkspaceDraft, { deep: true });
    watch([livePrompt, effectiveNegative], () => updateAnimaPromptState(), { immediate: true });
    watch(() => pb.directorMode, mode => {
        localStorage.setItem(DIRECTOR_MODE_KEY, mode);
    });
    // 热门角色恢复草稿/历史后保证引擎不是 SD（SD 已对热门角色禁用）。
    watch(() => pb.subject, subject => {
        if (subject.kind === 'popular' && drawEngine.value === 'sd') {
            setDrawEngine('anima');
        }
        syncManagedRoute();
    });
    // 角色变化后，若当前 category 已无合格蓝图（如"成人"），
    // 自动回到"全部"并触发推荐重算，避免空面板。
    watch([popularBlueprintPool, () => pb.isPopular], () => {
        const categories = blueprintCategories.value;
        if (popularCategory.value !== 'all' && !categories.includes(popularCategory.value)) {
            popularCategory.value = 'all';
        }
    });
    watch(() => pb.char, char => {
        if (pb.isPopular)
            return;
        if (pb.directorMode === 'basic') {
            syncManagedRoute();
        }
        else if (drawEngine.value !== 'sd') {
            void refreshManagedRoute();
            syncAnimaCharacter(char);
            void refreshAnimaBackend();
            if (char === 'triad') {
                setDrawEngine('sd');
                pb.flash('Anima 与 Krea 2 首版暂不支持双角色身份构图，已切回 SD');
            }
        }
        else
            void refreshManagedRoute();
    });
    watch([() => pb.char, () => pb.sceneSearch, () => pb.sceneTheme, sceneCollection], () => {
        sceneLimit.value = 20;
    });
    // 切换 SD 模型时重新套用对应 profile 的推荐参数
    watch(() => pb.sdModelName, (name) => {
        const sceneSize = pb.activeScene ? pb.lastRecommendedSize : '';
        const profile = pb.applyModelProfile(name || sd.checkpoint.value, { applySize: !sceneSize });
        const targetSize = sceneSize || String(profile?.size || '').replace('×', 'x');
        if (targetSize && !pb.sdParamsTouched.has('size'))
            applyRecommendedSize(targetSize);
    });
    // Anima 状态轮询跟随激活引擎：SD 引擎下停止，切到 Anima/Krea 恢复。
    // 切换动作本身会触发一次 refreshAnimaBackend，这里只管理周期轮询。
    watch(() => drawEngine.value, engine => {
        if (!viewActive)
            return;
        if (engine === 'sd')
            animaSession.pauseStatusPolling();
        else
            animaSession.startStatusPolling();
    });
}

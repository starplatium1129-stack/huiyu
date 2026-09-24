import { useSceneEditorModal } from '@/composables/scene/useSceneEditorModal';
import { useSceneImportExport } from '@/composables/scene/useSceneImportExport';
import { useSceneMaintenance } from '@/composables/scene/useSceneMaintenance';
import { useSceneShowcaseUpload } from '@/composables/scene/useSceneShowcaseUpload';
import { useSceneTagManager } from '@/composables/scene/useSceneTagManager';
import { confirmAction } from '@/composables/useConfirm';
import { copyWithFeedback } from '@/composables/useCopyFeedback';
import { useFocusTrap } from '@/composables/useFocusTrap';
import { maintenanceApi } from '@/api/maintenanceApi';
import { useSceneStore } from '@/stores/sceneStore';
import type { CurationData,SceneDraft,TagRecord,SceneMaintenanceSnapshot } from '@/types/api';
import { nextCopyId } from '@/utils/copyId';
import { highlightSearchText as hl } from '@/utils/highlightSearchText';
import { blueprintMaintenanceRecord,sceneMaintenanceRecord } from '@/utils/maintenanceRecords';
import type { SceneBlueprint } from '@/utils/popularContent';
import { cloneSceneSnapshot, freezeSceneSnapshot, MAX_BLUEPRINTS, sceneContentKey } from '@/utils/sceneChanges';
import { isSceneId } from '@/utils/sceneId';
import { computed,onBeforeUnmount,onMounted,ref,shallowRef } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
/** Owns workspace state and lifecycle; the view only binds presentation. */
export function useSceneManagerWorkspace() {
    const sceneStore = useSceneStore();
    /** 场景编辑器是破坏性弹层，必须有焦点陷阱 + Escape（原先只有 @click.self） */
    const modalEl = ref<HTMLElement | null>(null);
    /** 蓝图编辑器同样需要焦点陷阱 + Escape */
    const bpModalEl = ref<HTMLElement | null>(null);
    const TABS = [
        { id: 'scenes', label: '场景库' },
        { id: 'blueprints', label: '蓝图库' },
        { id: 'tags', label: '标签库' },
        { id: 'images', label: '样张' },
        { id: 'duplicates', label: '重复检测' },
        { id: 'import', label: '导入' },
        { id: 'tools', label: '维护工具' },
    ];
    const DUP_KEYWORDS = ['吊带', '丝绸', '围裙', '泳衣', '温泉', '旗袍', '毛衣', '衬衫', '图书馆', '天台', '烟花', '神社', '巫女', '咖啡', '卧室', '寝室', '影音室', '休息室', '后厨', '厨房', '吧台', '晚礼服', '魔女', '洛丽塔', '浴衣', '和服', '赛车', '冰箱', '冷藏', '露台', '阳台', '泳池', '书房', '试衣'];
    const scenes = ref<SceneDraft[]>([]);
    const blueprints = ref<SceneBlueprint[]>([]);
    const tags = ref<TagRecord[]>([]);
    const curation = ref<CurationData>({});
    const sceneStateVersion = ref<number | null>(null);
    const sceneBaseline = shallowRef<SceneMaintenanceSnapshot | null>(null);
    /** 脏标记与维护提示为跨簇共享通道（编辑/导入/标签/策展 → 保存/离开守卫）。 */
    const dirty = ref(false);
    const maintenanceHint = ref('所有改动已同步');
    const loading = ref(true);
    const loadError = ref('');
    const tab = ref('scenes');
    // 蓝图编辑状态与浏览筛选独立，切换记录不丢失编辑快照。
    const bpEditing = ref<SceneBlueprint | null>(null);
    const bpEditingId = ref('');
    const bpTriedSave = ref(false);
    const bpFormHint = ref('');
    const bpSnapshot = ref('');
    const bpSceneTagsInput = ref('');
    const bpPromptTokensInput = ref('');
    const bpNegativeTokensInput = ref('');
    const bpNsfwTokensInput = ref('');
    const bpCoverageTagsInput = ref('');
    // 标签库 CRUD（改名级联、使用频次、筛选分页）
    const tagManager = useSceneTagManager({ tags, scenes, markDirty });
    const { tagSearch, tagSearchDebounced, tagCatFilter, tagPage, tagUsage, tagCats, filteredTags, tagTotalPages, pagedTags, deleteTag, tagModalOpen, tagEditing, tagForm, tagFormError, startAddTag, startEditTag, closeTagModal, submitTag } = tagManager;
    const tagModalEl = ref<HTMLElement | null>(null);
    useFocusTrap(tagModalEl, () => tagModalOpen.value, { onEscape: closeTagModal });
    // 样张与首页主视觉上传（预览、JPEG 归一化、上传/恢复生命周期）
    const showcase = useSceneShowcaseUpload({
        scenes,
        blueprints,
        errorMessage,
    });
    const { showcaseFileEl, heroFileEl, imageSearch, imagePage, imageTypeFilter, selectedImageId, selectedImageTitle, showcaseFeedback, showcaseError, showcaseVersion, uploadBusy, selectedHeroId, selectedHeroTitle, homeHeroes, allShowcaseItems, filteredImageScenes, imageTotalPages, pagedImageScenes, showcaseUrl, heroUrl, previewImage, onShowcaseMissing, pickShowcase, previewHero, pickHero, loadHomeHeroes, resetHero, onShowcasePicked, onHeroPicked } = showcase;
    // ── 场景编辑弹层 + CRUD + 策展（已下沉 useSceneEditorModal）───────────────
    const { editing, editingId, curationTierValue, curationReason, tagsInput, usageInput, triedSave, formHint, curationTier, updateCharacterDefaults, onCurationTierChange, openAddModal, openEditModal, closeModal, saveScene, deleteScene, duplicateScene, copyJson } = useSceneEditorModal({ scenes, curation, markDirty, nextSceneId: allocateNextSceneId, allocationError: message => { maintenanceHint.value = message; } });
    const recordCounts = computed<Record<string, number>>(() => ({ scenes: scenes.value.length, blueprints: blueprints.value.length, tags: tags.value.length }));
    const characterNames = computed(() => new Map(sceneStore.popularCharacters.map(character => [character.id, character.displayName])));
    const sceneRecords = computed(() => scenes.value.map(scene => sceneMaintenanceRecord(scene, charLabel(scene.char), curationTier(scene.id))));
    const blueprintRecords = computed(() => blueprints.value.map(blueprint => blueprintMaintenanceRecord(blueprint, characterNames.value.get(blueprint.characterId || '') || charLabel(blueprint.characterId))));
    // ── 导入 / 导出（已下沉 useSceneImportExport）─────────────────────────────
    const { importInput, importResult, importScenes, exportJSON, fullImportLoaded, importing, loadFullSnapshot } = useSceneImportExport({
        scenes,
        tags,
        curation,
        blueprints,
        canImport: () => !loading.value && !desktopPackaged.value && !toolRunning.value,
        markDirty,
        esc,
        errorMessage,
    });
    // ── 维护任务：落盘/工具/备份/桌面只读探测（已下沉 useSceneMaintenance）────
    const maintenance = useSceneMaintenance({
        scenes,
        tags,
        curation,
        blueprints,
        dirty,
        loading,
        maintenanceHint,
        baseVersion: () => sceneStateVersion.value,
        baselineSnapshot: () => sceneBaseline.value,
        adoptSceneState,
        editSessionKey,
        invalidateSceneCache: () => { sceneStore.loaded = false; },
    });
    const { TOOLS, saving, savingPhase, toolRunning, toolResult, toolResultTitle, backups, backupsLoading, backupsError, backupsExpanded, desktopPackaged, saveToProject, runTool, loadBackups, formatBackupTime, highlightedOutput, previewing, importConfirming } = maintenance;
    function editSessionKey() {
        return sceneContentKey({
            scene: editing.value ? { value: editing.value, tags: tagsInput.value, usage: usageInput.value, tier: curationTierValue.value, reason: curationReason.value } : null,
            blueprint: bpEditing.value ? serializeBlueprintModal() : null,
            tag: tagModalOpen.value ? tagForm.value : null,
        });
    }
    function adoptSceneState(version: number, snapshot: SceneMaintenanceSnapshot) {
        sceneBaseline.value = freezeSceneSnapshot(snapshot);
        sceneStateVersion.value = version;
        fullImportLoaded.value = false;
    }
    function blankBlueprint(): SceneBlueprint {
        return {
            id: '', title: '', category: '', description: '', characterId: '',
            location: '', action: '', timeOfDay: '', lighting: '', camera: '', mood: '',
            sceneTags: [], promptProse: '', promptTokens: [], negativeTokens: [],
            recommendedSize: '832x1216', adult: false,
            kreaStyleHint: '', animaStyleHint: '', adultArtistHint: '', sampleRating: 'All',
            nsfwTokens: [], nsfwProse: '', outfitId: '', coverageTags: [],
        };
    }
    function splitList(value: string): string[] {
        return value.split(',').map(item => item.trim()).filter(Boolean);
    }
    function serializeBlueprintModal() {
        return JSON.stringify({
            ...bpEditing.value,
            bpSceneTagsInput: bpSceneTagsInput.value,
            bpPromptTokensInput: bpPromptTokensInput.value,
            bpNegativeTokensInput: bpNegativeTokensInput.value,
            bpNsfwTokensInput: bpNsfwTokensInput.value,
            bpCoverageTagsInput: bpCoverageTagsInput.value,
        });
    }
    function openBlueprintAddModal() {
        if (blueprints.value.length >= MAX_BLUEPRINTS) { maintenanceHint.value = `蓝图数量不能超过 ${MAX_BLUEPRINTS}`; return; }
        const occupied = new Set([...blueprints.value, ...(sceneBaseline.value?.blueprints ?? [])].map(b => b.id));
        let number = 1;
        while (occupied.has('bp_' + String(number).padStart(3, '0'))) number++;
        bpEditing.value = blankBlueprint();
        bpEditing.value.id = 'bp_' + String(number).padStart(3, '0');
        bpEditingId.value = '';
        bpSceneTagsInput.value = '';
        bpPromptTokensInput.value = '';
        bpNegativeTokensInput.value = '';
        bpNsfwTokensInput.value = '';
        bpCoverageTagsInput.value = '';
        bpTriedSave.value = false;
        bpFormHint.value = '';
        bpSnapshot.value = serializeBlueprintModal();
    }
    function openBlueprintEditModal(id: string) {
        const source = blueprints.value.find(b => b.id === id);
        if (!source)
            return;
        bpEditing.value = JSON.parse(JSON.stringify(source)) as SceneBlueprint;
        bpEditingId.value = id;
        bpSceneTagsInput.value = (source.sceneTags || []).join(', ');
        bpPromptTokensInput.value = (source.promptTokens || []).join(', ');
        bpNegativeTokensInput.value = (source.negativeTokens || []).join(', ');
        bpNsfwTokensInput.value = (source.nsfwTokens || []).join(', ');
        bpCoverageTagsInput.value = (source.coverageTags || []).join(', ');
        bpTriedSave.value = false;
        bpFormHint.value = '';
        bpSnapshot.value = serializeBlueprintModal();
    }
    async function closeBlueprintModal() {
        if (bpEditing.value && bpSnapshot.value && serializeBlueprintModal() !== bpSnapshot.value) {
            const confirmed = await confirmAction({
                title: '放弃未保存的蓝图修改？',
                message: '当前编辑的蓝图尚未保存，放弃后修改将丢失。',
                confirmLabel: '放弃修改',
                danger: true,
            });
            if (!confirmed)
                return;
        }
        bpEditing.value = null;
        bpEditingId.value = '';
        bpSnapshot.value = '';
    }
    function saveBlueprint() {
        bpTriedSave.value = true;
        const e = bpEditing.value;
        if (!e)
            return;
        if (bpEditingId.value && e.id !== bpEditingId.value) { bpFormHint.value = '已有蓝图不能更换 ID'; return; }
        if (!bpEditingId.value && blueprints.value.length >= MAX_BLUEPRINTS) { bpFormHint.value = `蓝图数量不能超过 ${MAX_BLUEPRINTS}`; return; }
        if (!e.id.trim() || !e.title.trim() || !e.characterId?.trim()) {
            bpFormHint.value = '请补齐 ID、标题和角色';
            return;
        }
        e.sceneTags = splitList(bpSceneTagsInput.value);
        e.promptTokens = splitList(bpPromptTokensInput.value);
        e.negativeTokens = splitList(bpNegativeTokensInput.value);
        e.nsfwTokens = splitList(bpNsfwTokensInput.value);
        e.coverageTags = splitList(bpCoverageTagsInput.value);
        if (!e.promptTokens.length || !e.negativeTokens.length) {
            bpFormHint.value = 'promptTokens 和 negativeTokens 至少各填一项';
            return;
        }
        if (bpEditingId.value) {
            const idx = blueprints.value.findIndex(b => b.id === bpEditingId.value);
            if (idx >= 0)
                blueprints.value[idx] = JSON.parse(JSON.stringify(e)) as SceneBlueprint;
        }
        else {
            if (blueprints.value.some(b => b.id === e.id)) {
                bpFormHint.value = 'ID 已存在：' + e.id;
                return;
            }
            blueprints.value.push(JSON.parse(JSON.stringify(e)) as SceneBlueprint);
        }
        bpSnapshot.value = serializeBlueprintModal();
        closeBlueprintModal();
        markDirty('蓝图内容有修改，等待保存到项目');
    }
    async function deleteBlueprint(id: string) {
        if (!(await confirmAction('确认删除蓝图 ' + id + '？保存到项目后它将从 scene-blueprints.json 中移除。')))
            return;
        blueprints.value = blueprints.value.filter(b => b.id !== id);
        markDirty('有蓝图等待删除');
    }
    function duplicateBlueprint(id: string) {
        if (blueprints.value.length >= MAX_BLUEPRINTS) { maintenanceHint.value = `蓝图数量不能超过 ${MAX_BLUEPRINTS}`; return; }
        const source = blueprints.value.find(b => b.id === id);
        if (!source)
            return;
        const copy = JSON.parse(JSON.stringify(source)) as SceneBlueprint;
        copy.id = nextCopyId(source.id, blueprints.value.map(item => item.id));
        copy.title = source.title + ' · 副本';
        blueprints.value.push(copy);
        markDirty('已复制蓝图，请编辑副本内容');
        openBlueprintEditModal(copy.id);
    }
    function copyBlueprintJson() {
        if (!bpEditing.value)
            return;
        void copyWithFeedback(JSON.stringify(bpEditing.value, null, 2), '蓝图 JSON 已复制');
    }
    const stats = computed(() => {
        const s = scenes.value;
        return [
            { label: '总场景', value: s.length },
            { label: '宁宁', value: s.filter((x) => x.char === 'nene').length },
            { label: '夏目', value: s.filter((x) => x.char === 'natsume').length },
            { label: '双人', value: s.filter((x) => x.char === 'triad' || x.char === 'both').length },
            { label: 'All', value: s.filter((x) => x.rating === 'All').length },
            { label: 'R15', value: s.filter((x) => x.rating === 'R15').length },
            { label: 'R18', value: s.filter((x) => x.rating === 'R18').length },
            { label: 'Tags', value: tags.value.length },
        ];
    });
    // ── 重复检测 ──────────────────────────────────────────────────────────────
    const dupGroups = ref<Array<{
        keyword: string;
        scenes: SceneDraft[];
    }>>([]);
    const dupResult = ref('');
    const dupChecked = ref(false);
    function detectDuplicates() {
        const groups: Array<{
            keyword: string;
            scenes: SceneDraft[];
        }> = [];
        let total = 0;
        DUP_KEYWORDS.forEach(kw => {
            const matches = scenes.value.filter(s => String(s.title || '').includes(kw) || String(s.story || '').includes(kw));
            if (matches.length >= 3) {
                groups.push({ keyword: kw, scenes: matches });
                total += matches.length;
            }
        });
        dupGroups.value = groups;
        dupChecked.value = true;
        dupResult.value = `发现 ${groups.length} 组，共 ${total} 个疑似重复`;
    }
    function deleteSceneFromDup(id: string) {
        deleteScene(id);
        detectDuplicates();
    }
    function charLabel(v: string | undefined) { return v === 'nene' ? '宁宁' : v === 'natsume' ? '夏目' : v === 'triad' || v === 'both' ? '双人' : (v || '—'); }
    function errorMessage(error: unknown, fallback: string) {
        if (error instanceof Error && error.message)
            return error.message;
        const text = String(error ?? '').trim();
        return text || fallback;
    }
    function markDirty(message: string) {
        dirty.value = true;
        maintenanceHint.value = message;
    }
    useFocusTrap(modalEl, () => editing.value !== null, { onEscape: closeModal });
    useFocusTrap(bpModalEl, () => bpEditing.value !== null, { onEscape: closeBlueprintModal });
    function esc(s: string) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    function onThumbError(e: Event) {
        const img = e.target as HTMLImageElement | null;
        if (img)
            img.style.display = 'none';
    }
    function onBeforeUnload(e: BeforeUnloadEvent) {
        if (!dirty.value)
            return;
        e.preventDefault();
        e.returnValue = '';
    }
    onBeforeRouteLeave(async () => {
        if (!dirty.value)
            return true;
        return confirmAction({
            title: '离开场景管理？',
            message: '场景修改尚未保存到项目，离开后未保存的改动将丢失。',
            confirmLabel: '离开页面',
            danger: true,
        });
    });
    onMounted(() => {
        window.addEventListener('beforeunload', onBeforeUnload);
    });
    let loadAbort: AbortController | null = null;
    onBeforeUnmount(() => {
        window.removeEventListener('beforeunload', onBeforeUnload);
        loadAbort?.abort();
    });
    /**
     * 可写编辑器通过同一响应读取内容与版本；打包桌面仅加载只读展示数据。
     */
    let reloadRunning = false;
    async function loadFromStore(force = false) {
        if (reloadRunning || saving.value || toolRunning.value || previewing.value || importConfirming.value) return;
        const controller = new AbortController();
        loadAbort = controller;
        reloadRunning = true;
        try {
        if (dirty.value) {
            const confirmed = await confirmAction({
                title: '重新读取场景数据？',
                message: '重新读取将丢弃本地未保存的修改。如有需要请先导出草稿备份。',
                confirmLabel: '重新读取',
                danger: true,
            });
            if (!confirmed) return;
        }
        if (saving.value || toolRunning.value || previewing.value || importConfirming.value) return;
        loading.value = true;
        const draftBefore = sceneContentKey({ scenes: scenes.value, tags: tags.value, curation: curation.value, blueprints: blueprints.value, editor: editSessionKey() });
        try {
            const packaged = window.companionDesktop ? await window.companionDesktop.isPackaged() : false;
            desktopPackaged.value = packaged;
            if (!packaged) {
                // 角色显示名是辅助元数据；权威内容读取不能被它阻塞。
                // 两条请求并行启动，state 成功即可建立可写基线。
                void (force ? sceneStore.loadMetadata(true) : sceneStore.loadMetadata()).catch((error) => {
                    console.warn('scene maintenance metadata load failed', error)
                })
                const state = await maintenanceApi.getScenesState({ signal: controller.signal });
                if (sceneContentKey({ scenes: scenes.value, tags: tags.value, curation: curation.value, blueprints: blueprints.value, editor: editSessionKey() }) !== draftBefore) {
                    dirty.value = true;
                    maintenanceHint.value = '读取期间有新编辑，已保留草稿与原基线。请先导出，再重新读取并合并';
                    return;
                }
                const snapshot = cloneSceneSnapshot(state.snapshot);
                scenes.value = snapshot.scenes;
                blueprints.value = snapshot.blueprints;
                tags.value = snapshot.tags;
                curation.value = snapshot.curation;
                adoptSceneState(state.version, state.snapshot);
                dirty.value = false;
                loadError.value = '';
                maintenanceHint.value = '已读取最新场景快照';
                return;
            }
            await (force ? sceneStore.reload() : sceneStore.load());
            if (sceneStore.error)
                throw new Error(sceneStore.error);
            if (!Array.isArray(sceneStore.scenes))
                throw new Error('scenes.json 格式错误');
            // 同样不能 structuredClone reactive proxy，数据源本身是 JSON。
            scenes.value = JSON.parse(JSON.stringify(sceneStore.scenes)) as SceneDraft[];
            blueprints.value = JSON.parse(JSON.stringify(sceneStore.sceneBlueprints)) as SceneBlueprint[];
            tags.value = JSON.parse(JSON.stringify(sceneStore.tags)) as TagRecord[];
            curation.value = JSON.parse(JSON.stringify(sceneStore.curation)) as CurationData;
            loadError.value = '';
            // 打包桌面不建立可写基线。
            sceneStateVersion.value = null;
            sceneBaseline.value = null;
            dirty.value = false;
        }
        catch (err) {
            if (controller.signal.aborted) return;
            sceneStateVersion.value = null;
            sceneBaseline.value = null;
            loadError.value = errorMessage(err, '场景数据加载失败');
        }
        finally {
            loading.value = false;
        }
        } finally {
            if (loadAbort === controller) loadAbort = null;
            reloadRunning = false;
        }
    }
    /** 服务端分配下一个稳定场景 ID；失败返回 null，禁止猜测退役 ID。 */
    async function allocateNextSceneId(): Promise<string | null> {
        if (loading.value || desktopPackaged.value || !sceneBaseline.value) return null;
        try {
            const state = await maintenanceApi.getScenesState();
            if (!state.nextSceneId) maintenanceHint.value = '场景 ID 已用尽，无法新增或复制';
            else if (!isSceneId(state.nextSceneId)) { maintenanceHint.value = '服务端返回的场景编号不规范，请重新读取'; return null; }
            return state.nextSceneId;
        }
        catch {
            maintenanceHint.value = '无法读取场景 ID 状态，请恢复服务后再新增或复制';
            return null;
        }
    }
    onMounted(async () => {
        // 首次进入拉最新落盘状态：编辑器要基于真实文件而不是别的页面留下的内存副本
        await loadFromStore(true);
        await loadHomeHeroes();
    });
    return {
        canSave: maintenance.canSave, canPreview: maintenance.canPreview,
        preview: maintenance.preview, previewing, previewError: maintenance.previewError,
        previewInvalidated: maintenance.previewInvalidated, previewEmpty: maintenance.previewEmpty,
        previewCompanions: maintenance.previewCompanions, previewGroups: maintenance.previewGroups,
        previewChanges: maintenance.previewChanges, importSnapshotToProject: maintenance.importSnapshotToProject,
        fullImportLoaded, importing, loadFullSnapshot,
tagModalEl,
bpModalEl,
modalEl,
showcaseFileEl,
heroFileEl,
        tab, scenes, loading, loadError, saving, dirty,
        desktopPackaged, maintenanceHint, savingPhase, exportJSON, saveToProject, loadFromStore,
        stats, TABS, recordCounts, sceneRecords, openAddModal, openEditModal,
        duplicateScene, deleteScene, blueprintRecords, openBlueprintAddModal, openBlueprintEditModal, duplicateBlueprint,
        deleteBlueprint, tagSearch, tagCatFilter, tagCats, startAddTag, filteredTags,
        tags, pagedTags, hl, tagSearchDebounced, tagUsage, startEditTag,
        deleteTag, tagTotalPages, tagPage, homeHeroes, selectedHeroId, previewHero,
        selectedHeroTitle, uploadBusy, pickHero, resetHero, heroUrl, onHeroPicked,
        showcaseError, showcaseFeedback, imageSearch, imageTypeFilter, allShowcaseItems, filteredImageScenes,
        pagedImageScenes, selectedImageId, previewImage, showcaseVersion, onThumbError, charLabel,
        imageTotalPages, imagePage, selectedImageTitle, pickShowcase, showcaseUrl, onShowcaseMissing,
        onShowcasePicked, detectDuplicates, dupResult, dupGroups, dupChecked, deleteSceneFromDup,
        importInput, importScenes, importResult, TOOLS, toolRunning, runTool,
        toolResult, toolResultTitle, highlightedOutput, backupsLoading, loadBackups, backupsError,
        backupsExpanded, backups, formatBackupTime, editing, closeModal, editingId,
        triedSave, updateCharacterDefaults, tagsInput, usageInput, curationTierValue, onCurationTierChange,
        curationReason, formHint, saveScene, copyJson, bpEditing, closeBlueprintModal,
        bpEditingId, bpTriedSave, bpSceneTagsInput, bpPromptTokensInput, bpNegativeTokensInput, bpNsfwTokensInput,
        bpCoverageTagsInput, bpFormHint, saveBlueprint, copyBlueprintJson, tagModalOpen, closeTagModal,
        tagEditing, tagForm, tagFormError, submitTag,
    };
}

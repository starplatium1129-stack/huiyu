import { sameArtworkMedia, watchArtworkMedia } from './artworkMediaIdentity';
import { artworkFacts, characterName as resolveCharacterName, formatDate, sceneTitle as resolveSceneTitle } from './galleryHelpers';
import { useArtworkRatios } from '@/composables/gallery/useArtworkRatios';
import { useMasonryColumns } from '@/composables/gallery/useMasonryWall';
import { useFocusTrap } from '@/composables/useFocusTrap';
import { useArtworkInfoDrawer } from '@/composables/useArtworkInfoDrawer';
import { useScrollReveal } from '@/composables/useScrollReveal';
import { useToast } from '@/composables/useToast';
import { artworkRepository,type TrashEntry } from '@/storage/artworkRepository';
import type { LoraMeta,Scene } from '@/stores/sceneStore';
import { useSceneStore } from '@/stores/sceneStore';
import { artworkTimestamp,type ArtworkRecord } from '@/types/artwork';
import { computed,onActivated,onDeactivated,onMounted,onUnmounted,ref,shallowRef,watch } from 'vue';
import { useRoute,useRouter } from 'vue-router';
import { bulkDeleteAction,confirmDeleteAction,toggleFavoriteAction } from './galleryMutations';
import { cancelGalleryStorageLoad, loadGalleryStorageAction,type GalleryProject } from './galleryStorage';
import { useGalleryExports } from './useGalleryExports';
import { useGalleryTrash } from './useGalleryTrash';
import { useGalleryFilters } from './useGalleryFilters';
import { useGalleryComparison } from './useGalleryComparison';
import { useGallerySelection } from './useGallerySelection';
import { useGalleryViewer } from './useGalleryViewer';
import { useGalleryListMotion } from './useGalleryListMotion';
import { useGalleryThumbnails } from './useGalleryThumbnails';
import { useGalleryCardPreviews } from './useGalleryCardPreviews';
/** Owns workspace state and lifecycle; the view only binds presentation. */
export function useGalleryWorkspace() {
    const sceneStore = useSceneStore();
    useScrollReveal();
    const { show: showToast } = useToast();
    const route = useRoute();
    const router = useRouter();

    const history = ref<ArtworkRecord[]>([]), projects = ref<GalleryProject[]>([]), scenes = ref<Scene[]>([]), loras = ref<LoraMeta[]>([]);
    const galleryLoading = ref(true), galleryIndexLoading = ref(false), galleryError = ref('');
    const infoOpen = ref(false);
    // Legacy/imported artwork IDs may also be Object prototype property names.
    const cardUrls = shallowRef<Record<string, string>>(Object.create(null));
    const collectionPreviewItems = ref<ArtworkRecord[] | null>(null);
    const { urls: thumbUrls, remember: rememberThumbnail, forget: forgetThumbnail, trim: trimThumbnails, retain: retainThumbnails, clear: clearThumbnails } = useGalleryThumbnails(() =>
        collectionPreviewItems.value ? new Set(collectionPreviewItems.value.map(item => String(item.id))) : returnThumbIds);
    const missingImageIds = ref(new Set<string | number>());
    /** 已解码预览回填缩略图时，同一张图并发只生成一次 */
    const thumbPending = new Set<string>();
    const { ratioOf, measure, forgetRatio } = useArtworkRatios({
        pending: thumbPending,
        hasThumb: item => Boolean(thumbUrls.value[item.id]),
        signal: () => imageReads.signal,
        current: item => !unmounted && viewActive && isMediaCurrent(item),
        saveThumb: async (item, dataUrl, imageId) => {
            const epoch = imageEpoch;
            await artworkRepository.setThumbnail(imageId, dataUrl);
            if (!unmounted && viewActive && epoch === imageEpoch && isMediaCurrent(item)) rememberThumbnail(item.id, dataUrl);
        },
    });
    /** The card owns decoded visibility; measurement must not delay its first paint. */
    function onHdLoad(item: ArtworkRecord, e: Event) {
        if (isMediaCurrent(item)) measure({ ...item }, e);
    }
    /** 待确认删除的条目 id：删除有回收站兜底，但二次确认仍是防手滑的第一道闸 */
    const pendingDeleteId = ref<string | number | null>(null);
    const deleting = ref(false);
    const bulkDeleting = ref(false);
    // ── 回收站视图（2026-08-31）：软删条目列表 + 逐条恢复 ────────────────────
    const trashMode = ref(false);
    const trashItems = ref<TrashEntry[]>([]);
    const trashBusy = ref<string | number | null>(null);
    function toggleTrashMode() {
        trashMode.value = !trashMode.value;
        if (trashMode.value)
            void loadTrash();
    }
    /** 读取回收站列表并加载首图缩略图（30 天保留期内缩略图仍在）。 */
    /** 恢复一条软删作品：放回展墙后刷新回收站与主墙。 */
    const closeBtn = ref<HTMLElement | null>(null);
    const viewerEl = ref<HTMLElement | null>(null);
    const infoEl = ref<HTMLElement | null>(null), infoToggleBtn = ref<HTMLButtonElement | null>(null), infoCloseBtn = ref<HTMLButtonElement | null>(null);
    const shellEl = ref<HTMLElement | null>(null);
    const { columnCount } = useMasonryColumns(shellEl);
    let unmounted = false;
    let viewActive = true;
    let imageEpoch = 0;
    let imageReads = new AbortController();

    const {
        favoriteOnly,
        tagFilter, tagOptions, characterFilter,
        generationOptions, filterSnapshot, applyFilterSnapshot, projectOptions, projectUnavailable,
        projectFilter,
        searchQuery,
        visible,
        favoriteCount,
        countLabel,
        pagedVisible,
        hasMoreToRender,
        masonryGroups,
        resetGalleryFilters,
        restoreFiltersFromQuery,
        restoreDeferredFiltersFromQuery,
        cleanupFilterSync,
        sentinelEl,
    } = useGalleryFilters({
        history,
        indexLoading: galleryIndexLoading, loadError: galleryError,
        projects,
        ratioOf,
        columnCount,
        route,
        router,
        onFilterReset: () => { clearSelection(); },
        isViewActive: () => viewActive, deferQueryRestore: () => viewerIndex.value >= 0 || current.value !== null,
    });

    const {
        selectMode,
        selectedIds,
        toggleSelectMode,
        toggleSelect,
        allVisibleSelected,
        selectAllVisible,
        clearSelection,
    } = useGallerySelection(visible);

    const { viewerIndex, viewerUrl, viewerLoadFailed, retryViewerImage, neighborPreviews, current, openViewer, closeViewer, onViewerClosed: finishViewerClose, step, getViewerRevision } = useGalleryViewer({
        history, visible, previewSource: item => cardUrls.value[item.id] || thumbUrls.value[item.id] || '', resetControls: () => { infoOpen.value = false; compareMode.value = false; },
    });
    function onViewerClosed() { finishViewerClose(); restoreDeferredFiltersFromQuery(); }

    const {
        compareMode,
        compareOpen,
        compareItems,
        compareSelected: openSelectedComparison,
        compareFromRoute: openRouteComparison,
        parentImageUrl,
        parentImageLabel, parentImageStatus, retryParentImage,
        hasComparableImage,
    } = useGalleryComparison({
        history,
        selectedIds,
        route,
        current,
        cardUrls,
        thumbUrls,
    });
    const requestedComparison = computed(() => route.path === '/gallery' && typeof route.query.compare === 'string' ? route.query.compare : '');
    let comparisonOwner = '', dismissedComparison = '', comparisonRevision = 0;
    function compareSelected() {
        comparisonRevision++; comparisonOwner = ''; dismissedComparison = requestedComparison.value;
        openSelectedComparison();
    }
    function closeComparison() {
        if (!compareOpen.value) return;
        const owner = comparisonOwner;
        comparisonRevision++; comparisonOwner = ''; compareOpen.value = false;
        if (!owner || unmounted || !viewActive || requestedComparison.value !== owner) return;
        dismissedComparison = owner;
        const query = { ...route.query };
        delete query.compare;
        void router.replace({ query, hash: route.hash });
    }
    async function refreshComparison() {
        const request = requestedComparison.value, revision = ++comparisonRevision;
        await loadGalleryStorage();
        if (unmounted || !viewActive || revision !== comparisonRevision || !request
            || request !== requestedComparison.value || request === dismissedComparison) return;
        openRouteComparison();
        comparisonOwner = compareOpen.value ? request : '';
    }

    const facts = computed(() => artworkFacts(current.value, loras.value));
    /* ---------- 工具函数 ---------- */
    function sceneTitle(id: string | null | undefined, item?: ArtworkRecord) {
        return resolveSceneTitle(id, item, scenes.value, sceneStore.popularCharacters);
    }
    function characterName(v: string | undefined, item?: ArtworkRecord) { return resolveCharacterName(v, item, sceneStore.popularCharacters); }
    /** 时间戳兜底：老记录可能把 timestamp 存成字符串，或干脆没有 */
    function stamp(item: ArtworkRecord): number { return artworkTimestamp(item); }


    const visibleIndices = computed(() => new Map(visible.value.map((item, index) => [item.id, index])));
    function indexOf(item: ArtworkRecord) { return visibleIndices.value.get(item.id) ?? -1; }

    function markImageMissing(id: string | number) {
        missingImageIds.value = new Set([...missingImageIds.value, id]);
    }
    function releaseImages(retain: ReadonlySet<string> = new Set()) {
        imageEpoch++;
        imageReads.abort(); imageReads = new AbortController();
        releaseCardImages(retain);
        // Missing results, including temporary read failures, expire on leaving.
        missingImageIds.value = new Set();
    }
    /* ---------- 可见缩略图与按显示像素生成的预览 ---------- */
    const THUMB_CONCURRENCY = 8;
    const { returnThumbIds, releaseCardImage, releaseCardImages, cancelCardHydration, retainCardReads, stopCardObservation, scheduleWallScan, retryCardImage } = useGalleryCardPreviews({
        shell: shellEl, items: () => pagedVisible.value,
        active: () => !unmounted && viewActive, wallActive: () => !trashMode.value && collectionPreviewItems.value === null,
        epoch: () => imageEpoch, signal: () => imageReads.signal, current: item => {
            const index = visibleIndices.value.get(item.id), live = index === undefined ? undefined : visible.value[index];
            return index !== undefined && index < pagedVisible.value.length && sameArtworkMedia(item, live) && item._galleryRevision === live?._galleryRevision;
        },
        urls: cardUrls, thumbnails: thumbUrls, rememberThumbnail, forgetThumbnail, markMissing: markImageMissing,
        missing: id => missingImageIds.value.has(id), hydrateThumbnails: hydrateThumbs, trimThumbnails,
        clearMissing: id => { if (missingImageIds.value.delete(id)) missingImageIds.value = new Set(missingImageIds.value); },
    });
    let thumbHydration: Promise<void> | null = null;
    let thumbsDirty = false;
    function hydrateThumbs(): Promise<void> {
        thumbsDirty = true;
        if (thumbHydration) return thumbHydration;
        const epoch = imageEpoch, visited = new Map<string | number, ArtworkRecord>();
        async function run() {
            do {
                thumbsDirty = false;
                // Watchers and mounting share one batch; a changed page reschedules
                // its remaining reads without fetching the same missing preview twice.
                const demanded = trashMode.value ? [] : collectionPreviewItems.value ?? (returnThumbIds.size
                    ? pagedVisible.value.filter(item => returnThumbIds.has(String(item.id))) : pagedVisible.value.slice(0, 12));
                const pending = demanded.filter(item => item.image_id && !sameArtworkMedia(visited.get(item.id), item) && !cardUrls.value[item.id] && !thumbUrls.value[item.id]).map(item => ({ ...item }));
                let index = 0;
                async function worker() {
                    while (index < pending.length) {
                        if (unmounted || !viewActive || epoch !== imageEpoch || thumbsDirty) return;
                        const item = pending[index++];
                        visited.set(item.id, item);
                        try {
                            const thumb = await artworkRepository.getThumbnail(item.image_id!);
                            if (unmounted || !viewActive || epoch !== imageEpoch) return;
                            if (isMediaCurrent(item) && typeof thumb === 'string' && thumb.startsWith('data:image/')) rememberThumbnail(item.id, thumb);
                        }
                        catch { /* 缩略图缺失正常，直接走 HD */ }
                    }
                }
                await Promise.all(Array.from({ length: Math.min(THUMB_CONCURRENCY, pending.length) }, () => worker()));
            } while (thumbsDirty && !unmounted && viewActive && epoch === imageEpoch);
        }
        thumbHydration = run().finally(() => {
            thumbHydration = null;
            if (thumbsDirty && !unmounted && viewActive) void hydrateThumbs();
        });
        return thumbHydration;
    }
    // 父查看器与窄屏信息抽屉叠成两层陷阱：抽屉打开时 Escape 只交给顶层抽屉，
    // 关闭后由子陷阱把焦点还给 .viewer-info-toggle，再由父陷阱管理整个查看器。
    const { returnFocus: viewerReturnFocus } = useFocusTrap(viewerEl, () => viewerIndex.value >= 0, {
        onEscape: closeViewer,
        initialFocus: closeBtn,
    });
    watch(viewerIndex, index => {
        if (index >= 0 || !viewerReturnFocus.value) return;
        const opener = viewerReturnFocus.value;
        const cardId = opener.closest<HTMLElement>('[data-card-id]')?.dataset.cardId;
        const box = opener.getBoundingClientRect();
        if (!opener.isConnected || (cardId && !visible.value.some(item => String(item.id) === cardId))
            || box.bottom <= 0 || box.right <= 0 || box.top >= innerHeight || box.left >= innerWidth) {
            const survivingIds = new Set(visible.value.map(item => String(item.id)));
            const nearby = [...(shellEl.value?.querySelectorAll<HTMLElement>('[data-card-id]') ?? [])].find(card => {
                const rect = card.getBoundingClientRect();
                return survivingIds.has(card.dataset.cardId || '') && rect.bottom > 0 && rect.top < innerHeight;
            });
            viewerReturnFocus.value = nearby?.querySelector<HTMLElement>('.artwork-button')
                ?? shellEl.value?.querySelector<HTMLElement>('.gallery-summary') ?? null;
        }
    }, { flush: 'sync' });
    const { compact: narrowViewer, hidden: infoDrawerHidden, toggle: toggleInfoDrawer, close: closeInfoDrawer } = useArtworkInfoDrawer({
        viewer: viewerEl, panel: infoEl, trigger: infoToggleBtn, closeButton: infoCloseBtn,
        viewerCloseButton: closeBtn, open: infoOpen, active: () => viewerIndex.value >= 0,
    });
    /* ---------- 删除 ---------- */
    /**
     * 从作品册移除一幅：历史条目 + IndexedDB 里的原图一起删，
     * 否则图片会变成没人引用的孤儿，继续占着配额。
     */
    /**
     * 收藏切换（2026-08-30 UX 审计：收藏此前是死功能）。
     *
     * 「收藏」筛选与卡片爱心标记一直都在，但全库没有任何写入 `favorite` 的入口，
     * 创建作品时恒为 false —— 于是顶部「收藏 N」永远是 0，角色厨想标精选无门。
     *
     * 乐观更新：大图墙里等一次 KV 往返再变色会有肉眼可见的迟滞。写失败则回滚
     * 并如实告知，不静默吞（与本项目其他存储写入失败的修法一致）。
     */
    /**
     * 释放一张卡片占用的内存：blob URL、LRU 登记、缩略图与尺寸缓存。
     *
     * 单张删除与批量删除共用这一条路径——审计里「数百张大图不卡」靠的就是
     * LRU + 显式 revoke，批量清 500 张如果只改数组不释放，会让 blob 全部泄漏，
     * 等于把最花力气修好的工程又捅一个洞。
     */
    function releaseCardResources(id: string | number) {
        releaseCardImage(id);
        forgetThumbnail(id);
        if (missingImageIds.value.delete(id))
            missingImageIds.value = new Set(missingImageIds.value);
        forgetRatio(id);
    }
    /* ---------- 键盘 ---------- */
    function onKeydown(e: KeyboardEvent) {
        if (viewerIndex.value < 0 || e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || (e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [contenteditable="true"]')))
            return;
        // Escape 与 Tab 陷阱由 useFocusTrap 处理
        if (narrowViewer.value && infoOpen.value) return;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault(); return step(e.key === 'ArrowLeft' ? -1 : 1);
        }
        if (e.key.toLowerCase() === 'i') {
            e.preventDefault(); toggleInfoDrawer(e);
            return;
        }
    }
    /* ---------- 初始化 ---------- */
    function loadGalleryStorage(): Promise<void> { return loadGalleryStorageAction({ galleryLoading, galleryIndexLoading, galleryError, history, projects }) }
    onMounted(async () => {
        unmounted = false;
        document.addEventListener('keydown', onKeydown);
        // Labels are supplemental: library browsing and saved filters do not
        // depend on the studio's character/tag/preset/blueprint catalogs.
        void sceneStore.loadHome().then(() => { scenes.value = sceneStore.scenes; })
            .catch(e => console.warn('gallery scene labels load failed', e));
        void sceneStore.loadLoraCatalog().then(() => { loras.value = sceneStore.loras; })
            .catch(e => console.warn('gallery LoRA labels load failed', e));
        restoreFiltersFromQuery();
        await refreshComparison();
        // 回收站懒清理（2026-08-30 UX 审计 P0-8）：真删超期软删条目的图片与
        // 缩略图。不阻塞首屏，失败静默（下次挂载再试）。
        void artworkRepository.purgeExpiredTrash().catch(e => console.warn('[gallery] trash purge failed', e));
        void hydrateThumbs();
        scheduleWallScan();
    });
    // KeepAlive preserves filters, pagination and the return viewport's previews.
    // A long browse must not keep every thumbnail/decoded image while inactive;
    // Keep an original only where the return viewport has no thumbnail fallback;
    // it still shares the bounded LRU and is released on eviction or unmount.
    let activatedOnce = false;
    onActivated(() => { viewActive = true; document.addEventListener('keydown', onKeydown); void hydrateThumbs(); scheduleWallScan(); if (!activatedOnce) { activatedOnce = true; return; } void refreshComparison(); });
    onDeactivated(() => {
        cancelGalleryStorageLoad(history);
        viewActive = false; comparisonRevision++; cleanupFilterSync();
        // The optional comparison panel may still be loading and have no
        // child deactivation hook yet. Its owner must close the intent now.
        closeComparison();
        const keep = collectionPreviewItems.value ? new Set(collectionPreviewItems.value.map(item => String(item.id))) : returnThumbIds;
        // A stored URL is not a decoded fallback (failed/pending thumbnails
        // otherwise leave a black frame when the painted original is revoked).
        releaseImages(new Set([...keep].filter(id => {
            const card = shellEl.value?.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(id)}"]`);
            return card?.dataset.thumbReady !== 'true';
        })));
        retainThumbnails(keep);
        document.removeEventListener('keydown', onKeydown); stopCardObservation();
    });
    onUnmounted(() => {
        cancelGalleryStorageLoad(history);
        unmounted = true; comparisonRevision++;
        cleanupFilterSync();
        stopCardObservation();
        document.removeEventListener('keydown', onKeydown);
        releaseImages();
        clearThumbnails();
    });
    const isMediaCurrent = watchArtworkMedia(history, id => {
        releaseCardImage(id); forgetThumbnail(id); forgetRatio(id);
        cancelCardHydration(id);
        if (missingImageIds.value.has(id)) missingImageIds.value = new Set([...missingImageIds.value].filter(value => value !== id));
        void hydrateThumbs(); scheduleWallScan();
    });
    watch(visible, () => {
        const ids = new Set(visible.value.map(item => item.id));
        selectedIds.value = new Set([...selectedIds.value].filter(id => ids.has(id)));
    });
    // Only the displayed image page owns original reads. Album/editor previews
    // and trash hydrate their thumbnails separately; hidden HD work must not block them.
    watch([pagedVisible, collectionPreviewItems, trashMode], () => {
        const ids = new Set(!trashMode.value && collectionPreviewItems.value === null ? pagedVisible.value.map(item => item.id) : []);
        retainCardReads(ids);
        trimThumbnails(); void hydrateThumbs();
        scheduleWallScan();
    });
    watch(masonryGroups, scheduleWallScan);
    // Filter URL sync replaces query too. Watch the two values independently so
    // it cannot reload/remount the wall and detach an open viewer's focus target.
    watch([requestedComparison, () => route.query.batch], ([request], [previous]) => {
        comparisonRevision++;
        if (request !== previous) {
            dismissedComparison = '';
            if (comparisonOwner) { comparisonOwner = ''; compareOpen.value = false; }
        }
        if (viewActive && route.path === '/gallery') void refreshComparison();
    }, { flush: 'sync' });
    const actions = useGalleryExports({ current, stamp, sceneTitle, characterName, showToast });
    const { copyPrompt } = actions;
    function downloadCurrent(): Promise<void> { return actions.downloadCurrent(); }
    const trashActions = useGalleryTrash({ trashMode, trashItems, trashBusy, showToast, loadGalleryStorage });
    const { clearTrash, trashClearing, trashLoading, trashError } = trashActions;
    function loadTrash(): Promise<void> { return trashActions.loadTrash(); }
    function restoreTrashItem(id: string | number): Promise<void> { return trashActions.restoreTrashItem(id); }
    function toggleFavorite(item: ArtworkRecord): Promise<void> { return toggleFavoriteAction({ history, showToast, loadGalleryStorage }, history.value.find(entry => entry.id === item.id) ?? item); }
    const deleteMotion = useGalleryListMotion(shellEl, () => pagedVisible.value, () => galleryLoading.value,
        () => !trashMode.value && collectionPreviewItems.value === null);
    function confirmDelete(item: ArtworkRecord): Promise<void> {
        const epoch = imageEpoch, viewerRevision = getViewerRevision();
        return confirmDeleteAction({ isCurrentView: () => !unmounted && viewActive && epoch === imageEpoch && viewerRevision === getViewerRevision(), showToast, deleting, viewerIndex, visible, indexOf, history, releaseCardResources, pendingDeleteId, closeViewer, openViewer, bulkDeleting, selectedIds, loadGalleryStorage, onDeleted: deleteMotion.forAction() }, item);
    }
    function bulkDelete(): Promise<void> { const epoch = imageEpoch; return bulkDeleteAction({ isCurrentView: () => !unmounted && viewActive && epoch === imageEpoch, showToast, deleting, viewerIndex, visible, indexOf, history, releaseCardResources, pendingDeleteId, closeViewer, openViewer, bulkDeleting, selectedIds, loadGalleryStorage, onDeleted: deleteMotion.forAction() }); }
    return {
closeBtn, viewerEl, infoEl, infoToggleBtn, infoCloseBtn, sentinelEl, shellEl,
        countLabel, searchQuery, favoriteOnly, favoriteCount, projectFilter, projects, tagFilter, tagOptions, characterFilter, collectionPreviewItems,
        generationOptions, filterSnapshot, applyFilterSnapshot, projectOptions, projectUnavailable,
        selectMode, toggleSelectMode, trashMode, toggleTrashMode, trashItems, selectedIds,
        visible, compareSelected, selectAllVisible, allVisibleSelected, bulkDeleting, bulkDelete,
        compareOpen, compareItems, closeComparison, loadGalleryStorage, trashBusy,
        restoreTrashItem, clearTrash, trashClearing, trashLoading, trashError, loadTrash, galleryLoading, galleryIndexLoading, galleryError, history, resetGalleryFilters,
        masonryGroups, scheduleWallScan, retryCardImage, columnCount, pendingDeleteId, ratioOf, deleting, confirmDelete,
        sceneTitle, toggleFavorite, toggleSelect, openViewer, indexOf, thumbUrls,
        measure, cardUrls, onHdLoad, missingImageIds, formatDate, stamp,
        hasMoreToRender, pagedVisible, viewerIndex, infoOpen, infoDrawerHidden, toggleInfoDrawer, closeInfoDrawer, closeViewer, onViewerClosed,
        compareMode, hasComparableImage, viewerUrl, viewerLoadFailed, retryViewerImage, neighborPreviews, parentImageUrl, parentImageLabel, parentImageStatus, retryParentImage, current, characterName,
        facts, downloadCurrent, downloading: actions.downloading, copyPrompt, showToast, releaseCardResources,
    };
}

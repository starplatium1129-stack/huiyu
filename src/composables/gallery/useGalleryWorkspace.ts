import { sameArtworkMedia, watchArtworkMedia } from './artworkMediaIdentity';
import { artworkFacts, characterName as resolveCharacterName, formatDate, sceneTitle as resolveSceneTitle } from './galleryHelpers';
import { useArtworkRatios } from '@/composables/gallery/useArtworkRatios';
import { useMasonryColumns } from '@/composables/gallery/useMasonryWall';
import { useFocusTrap } from '@/composables/useFocusTrap';
import { useScrollReveal } from '@/composables/useScrollReveal';
import { useToast } from '@/composables/useToast';
import { artworkRepository,type TrashEntry } from '@/storage/artworkRepository';
import type { LoraMeta,Scene } from '@/stores/sceneStore';
import { useSceneStore } from '@/stores/sceneStore';
import { artworkTimestamp,type ArtworkRecord } from '@/types/artwork';
import { computed,nextTick,onActivated,onDeactivated,onMounted,onUnmounted,reactive,ref,watch } from 'vue';
import { useRoute,useRouter } from 'vue-router';
import { bulkDeleteAction,confirmDeleteAction,toggleFavoriteAction } from './galleryMutations';
import { loadGalleryStorageAction,type GalleryProject } from './galleryStorage';
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
    const galleryLoading = ref(true), galleryError = ref('');
    const infoOpen = ref(false);
    const narrowViewerMedia = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(max-width: 900px)') : null;
    const narrowViewer = ref(narrowViewerMedia?.matches ?? false);
    const infoDrawerHidden = computed(() => narrowViewer.value && !infoOpen.value);
    const cardUrls = reactive<Record<string, string>>({});
    const collectionPreviewItems = ref<ArtworkRecord[] | null>(null);
    const { urls: thumbUrls, remember: rememberThumbnail, forget: forgetThumbnail, trim: trimThumbnails, retain: retainThumbnails, clear: clearThumbnails } = useGalleryThumbnails(() =>
        collectionPreviewItems.value ? new Set(collectionPreviewItems.value.map(item => String(item.id))) : returnThumbIds);
    const missingImageIds = ref(new Set<string | number>());
    /** 已解码预览回填缩略图时，同一张图并发只生成一次 */
    const thumbPending = new Set<string>();
    const { ratioOf, measure, forgetRatio } = useArtworkRatios({
        pending: thumbPending,
        hasThumb: item => Boolean(thumbUrls[item.id]),
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
        generationConditions, generationOptions, generationFilterCount, filterSnapshot, hasActiveFilters, applyFilterSnapshot, clearGenerationConditions, projectOptions, projectUnavailable,
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
        history, visible, previewSource: item => cardUrls[item.id] || thumbUrls[item.id] || '', resetControls: () => { infoOpen.value = false; compareMode.value = false; },
    });
    function onViewerClosed() { finishViewerClose(); restoreDeferredFiltersFromQuery(); }

    const {
        compareMode,
        compareOpen,
        compareItems,
        compareSelected,
        compareFromRoute,
        parentImageUrl,
        hasComparableImage,
    } = useGalleryComparison({
        history,
        selectedIds,
        route,
        current,
        cardUrls,
        thumbUrls,
    });

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
    const { returnThumbIds, releaseCardImage, releaseCardImages, cancelCardHydration, retainCardReads, stopCardObservation, scheduleWallScan } = useGalleryCardPreviews({
        shell: shellEl, items: () => pagedVisible.value,
        active: () => !unmounted && viewActive, wallActive: () => !trashMode.value && collectionPreviewItems.value === null,
        epoch: () => imageEpoch, signal: () => imageReads.signal, current: item => isMediaCurrent(item),
        urls: cardUrls, thumbnails: thumbUrls, rememberThumbnail, forgetThumbnail, markMissing: markImageMissing,
        missing: id => missingImageIds.value.has(id), hydrateThumbnails: hydrateThumbs, trimThumbnails,
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
                const pending = demanded.filter(item => item.image_id && !sameArtworkMedia(visited.get(item.id), item) && !cardUrls[item.id] && !thumbUrls[item.id]).map(item => ({ ...item }));
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
    function toggleInfoDrawer(event?: MouseEvent | KeyboardEvent) { if (!narrowViewer.value) return; viewerEl.value?.toggleAttribute('data-info-instant', event?.detail === 0); if (!infoOpen.value) infoToggleBtn.value?.focus({ preventScroll: true }); infoOpen.value = !infoOpen.value; }
    function closeInfoDrawer(event?: MouseEvent) { viewerEl.value?.toggleAttribute('data-info-instant', !event || event.detail === 0); infoOpen.value = false; }
    function syncNarrowViewer() { const nextNarrow = narrowViewerMedia?.matches ?? false; narrowViewer.value = nextNarrow; if (!nextNarrow && infoOpen.value) { closeInfoDrawer(); void nextTick(() => closeBtn.value?.focus({ preventScroll: true })); } }
    // 父查看器与窄屏信息抽屉叠成两层陷阱：抽屉打开时 Escape 只交给顶层抽屉，
    // 关闭后由子陷阱把焦点还给 .viewer-info-toggle，再由父陷阱管理整个查看器。
    const { returnFocus: viewerReturnFocus } = useFocusTrap(viewerEl, () => viewerIndex.value >= 0, {
        onEscape: closeViewer,
        initialFocus: closeBtn,
    });
    watch(viewerIndex, index => {
        if (index >= 0 || !viewerReturnFocus.value) return;
        const box = viewerReturnFocus.value.getBoundingClientRect();
        if (box.bottom <= 0 || box.right <= 0 || box.top >= innerHeight || box.left >= innerWidth) viewerReturnFocus.value = null;
    }, { flush: 'sync' });
    useFocusTrap(infoEl, () => viewerIndex.value >= 0 && narrowViewer.value && infoOpen.value, {
        onEscape: closeInfoDrawer, initialFocus: infoCloseBtn, lockScroll: false,
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
    function loadGalleryStorage(): Promise<void> { return loadGalleryStorageAction({ galleryLoading, galleryError, history, projects }) }
    onMounted(async () => {
        unmounted = false; syncNarrowViewer(); narrowViewerMedia?.addEventListener('change', syncNarrowViewer);
        document.addEventListener('keydown', onKeydown);
        // Labels are supplemental: library browsing and saved filters do not
        // depend on the studio's character/tag/preset/blueprint catalogs.
        void sceneStore.loadHome().then(() => { scenes.value = sceneStore.scenes; })
            .catch(e => console.warn('gallery scene labels load failed', e));
        void sceneStore.loadLoraCatalog().then(() => { loras.value = sceneStore.loras; })
            .catch(e => console.warn('gallery LoRA labels load failed', e));
        await loadGalleryStorage();
        compareFromRoute();
        // Restore only after the artwork and album snapshot is available.
        restoreFiltersFromQuery();
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
    onActivated(() => { viewActive = true; document.addEventListener('keydown', onKeydown); void hydrateThumbs(); scheduleWallScan(); if (!activatedOnce) { activatedOnce = true; return; } void loadGalleryStorage().then(compareFromRoute); });
    onDeactivated(() => {
        viewActive = false; cleanupFilterSync();
        const keep = collectionPreviewItems.value ? new Set(collectionPreviewItems.value.map(item => String(item.id))) : returnThumbIds;
        // A stored URL is not a decoded fallback (failed/pending thumbnails
        // otherwise leave a black frame when the painted original is revoked).
        releaseImages(new Set([...keep].filter(id => {
            const thumb = shellEl.value?.querySelector<HTMLImageElement>(`[data-card-id="${CSS.escape(id)}"] img.artwork-image:not(.artwork-image-hd)`);
            return !thumb?.complete || !thumb.naturalWidth;
        })));
        retainThumbnails(keep);
        document.removeEventListener('keydown', onKeydown); stopCardObservation();
    });
    onUnmounted(() => {
        unmounted = true;
        cleanupFilterSync();
        stopCardObservation();
        narrowViewerMedia?.removeEventListener('change', syncNarrowViewer);
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
    watch([() => route.query.compare, () => route.query.batch], () => {
        if (route.path === '/gallery')
            void loadGalleryStorage().then(compareFromRoute);
    });
    const actions = useGalleryExports({ current, stamp, sceneTitle, characterName, showToast });
    const { copyPrompt } = actions;
    function downloadCurrent(): Promise<void> { return actions.downloadCurrent(); }
    const trashActions = useGalleryTrash({ trashMode, trashItems, trashBusy, showToast, loadGalleryStorage });
    const { clearTrash, trashClearing, trashLoading, trashError } = trashActions;
    function loadTrash(): Promise<void> { return trashActions.loadTrash(); }
    function restoreTrashItem(id: string | number): Promise<void> { return trashActions.restoreTrashItem(id); }
    function toggleFavorite(item: ArtworkRecord): Promise<void> { return toggleFavoriteAction({ history, showToast }, item); }
    const deleteMotion = useGalleryListMotion(shellEl, () => pagedVisible.value, () => galleryLoading.value);
    function confirmDelete(item: ArtworkRecord): Promise<void> {
        const epoch = imageEpoch, viewerRevision = getViewerRevision();
        return confirmDeleteAction({ isCurrentView: () => !unmounted && viewActive && epoch === imageEpoch && viewerRevision === getViewerRevision(), showToast, deleting, viewerIndex, visible, indexOf, history, releaseCardResources, pendingDeleteId, closeViewer, openViewer, bulkDeleting, selectedIds, loadGalleryStorage, onDeleted: deleteMotion.forAction() }, item);
    }
    function bulkDelete(): Promise<void> { const epoch = imageEpoch; return bulkDeleteAction({ isCurrentView: () => !unmounted && viewActive && epoch === imageEpoch, showToast, deleting, viewerIndex, visible, indexOf, history, releaseCardResources, pendingDeleteId, closeViewer, openViewer, bulkDeleting, selectedIds, loadGalleryStorage, onDeleted: deleteMotion.forAction() }); }
    return {
closeBtn, viewerEl, infoEl, infoToggleBtn, infoCloseBtn, sentinelEl, shellEl,
        countLabel, searchQuery, favoriteOnly, favoriteCount, projectFilter, projects, tagFilter, tagOptions, characterFilter, collectionPreviewItems,
        generationConditions, generationOptions, generationFilterCount, filterSnapshot, hasActiveFilters, applyFilterSnapshot, clearGenerationConditions, projectOptions, projectUnavailable,
        selectMode, toggleSelectMode, trashMode, toggleTrashMode, trashItems, selectedIds,
        visible, compareSelected, selectAllVisible, allVisibleSelected, bulkDeleting, bulkDelete,
        compareOpen, compareItems, loadGalleryStorage, trashBusy,
        restoreTrashItem, clearTrash, trashClearing, trashLoading, trashError, loadTrash, galleryLoading, galleryError, history, resetGalleryFilters,
        masonryGroups, columnCount, pendingDeleteId, ratioOf, deleting, confirmDelete,
        sceneTitle, toggleFavorite, toggleSelect, openViewer, indexOf, thumbUrls,
        measure, cardUrls, onHdLoad, missingImageIds, formatDate, stamp,
        hasMoreToRender, pagedVisible, viewerIndex, infoOpen, infoDrawerHidden, toggleInfoDrawer, closeInfoDrawer, closeViewer, onViewerClosed, step,
        compareMode, hasComparableImage, viewerUrl, viewerLoadFailed, retryViewerImage, neighborPreviews, parentImageUrl, current, characterName,
        facts, downloadCurrent, copyPrompt, showToast, releaseCardResources,
    };
}

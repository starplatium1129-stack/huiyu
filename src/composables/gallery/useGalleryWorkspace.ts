import { artworkFacts, characterName as resolveCharacterName, formatDate, formatTrashTime, safeImageUrl, sceneTitle as resolveSceneTitle, trashPrompt } from './galleryHelpers';
import { useArtworkRatios } from '@/composables/gallery/useArtworkRatios';
import { useMasonryColumns } from '@/composables/gallery/useMasonryWall';
import { useFocusTrap } from '@/composables/useFocusTrap';
import { useScrollReveal } from '@/composables/useScrollReveal';
import { useToast } from '@/composables/useToast';
import { artworkRepository,type TrashEntry } from '@/storage/artworkRepository';
import type { LoraMeta,Scene } from '@/stores/sceneStore';
import { useSceneStore } from '@/stores/sceneStore';
import { artworkTimestamp,type ArtworkRecord } from '@/types/artwork';
import { blobThumbDataUrl } from '@/utils/imageThumb';
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
import { useGalleryDeleteMotion } from './useGalleryDeleteMotion';
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
    /** 缩略图缓存（KV dataURL），比 HD blob 快读先显示 */
    const thumbUrls = reactive<Record<string, string>>({});
    const collectionPreviewItems = ref<ArtworkRecord[] | null>(null);
    const missingImageIds = ref(new Set<string | number>());
    /** 缩略图生成去重：HD 管线与解码回填共用，同一张图并发只生成一次 */
    const thumbPending = new Set<string>();
    const { ratioOf, measure, forgetRatio } = useArtworkRatios({
        pending: thumbPending,
        hasThumb: item => Boolean(thumbUrls[item.id]),
        saveThumb: async (item, dataUrl, imageId) => {
            const epoch = imageEpoch;
            await artworkRepository.setThumbnail(imageId, dataUrl);
            if (!unmounted && viewActive && epoch === imageEpoch) thumbUrls[item.id] = dataUrl;
        },
    });
    /**
     * HD 层解码完成：回填真实比例 + 淡入覆盖缩略图。
     * 淡入用 requestAnimationFrame 双跳，确保 CSS 的 opacity:0 先落地再切到 1，
     * 否则 transition 不会触发、又会硬切一下（回到「闪一下」的老问题）。
     */
    function onHdLoad(item: ArtworkRecord, e: Event) {
        measure(item, e);
        const img = e.target as HTMLImageElement;
        requestAnimationFrame(() => requestAnimationFrame(() => img.classList.add('is-loaded')));
    }
    /** 待确认删除的条目 id：删除有回收站兜底，但二次确认仍是防手滑的第一道闸 */
    const pendingDeleteId = ref<string | number | null>(null);
    const deleting = ref(false);
    const bulkDeleting = ref(false);
    // ── 回收站视图（2026-08-31）：软删条目列表 + 逐条恢复 ────────────────────
    const trashMode = ref(false);
    const trashItems = ref<TrashEntry[]>([]);
    const trashThumbs = reactive<Record<string, string>>({});
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
    const objectUrls = new Set<string>();
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
        cleanupFilterSync,
        loadMoreIfNeeded: triggerLoadMore,
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

    const { viewerIndex, viewerUrl, current, openViewer, closeViewer, onViewerClosed: finishViewerClose, step } = useGalleryViewer({
        history, visible, resetControls: () => { infoOpen.value = false; compareMode.value = false; },
    });
    function onViewerClosed() { finishViewerClose(); restoreFiltersFromQuery(); }

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


    function indexOf(item: ArtworkRecord) { return visible.value.indexOf(item); }

    function trackUrl(url: string) { objectUrls.add(url); return url; }
    function markImageMissing(id: string | number) {
        missingImageIds.value = new Set([...missingImageIds.value, id]);
    }
    function releaseImages() {
        imageEpoch++;
        imageReads.abort(); imageReads = new AbortController();
        objectUrls.forEach(u => URL.revokeObjectURL(u));
        objectUrls.clear();
        for (const id of Object.keys(cardUrls)) delete cardUrls[id];
        cardLruOrder.clear();
        // Missing results, including temporary read failures, expire on leaving.
        missingImageIds.value = new Set();
    }
    /* ---------- 图片加载 ---------- */
    /**
     * 缩略图（KV 小 dataURL）便宜：整墙全量补齐，先让每张卡有图。
     * HD blob 贵且占内存（KeepAlive 后几百张大图数百 MB），改为可见性驱动：
     * IntersectionObserver 只对进入视口 ±600px 的卡片发起 HD 读取，配合
     * LRU 上限滚动淘汰。旧实现是「全量读出 → 丢掉超出 40 张的」，几百张
     * 作品时绝大多数 IndexedDB 读取和 blob 创建都是纯浪费。
     * 查看器大图由 useGalleryViewer 独立管理，不受上限影响。
     */
    /** 缩略图是 KV 小 dataURL，读得快，并发放高 */
    const THUMB_CONCURRENCY = 8;
    /** HD 读取并发 */
    const CARD_CONCURRENCY = 4;
    /** 常驻 HD blob 上限，超出按 LRU 淘汰并回落缩略图 */
    const HD_CACHE_LIMIT = 40;
    const cardLruOrder = new Map<string | number, 1>();
    const cardQueue: ArtworkRecord[] = [];
    const queuedCardIds = new Set<string | number>();
    let cardWorkers = 0;
    function touchCardLru(id: string | number) {
        cardLruOrder.delete(id);
        cardLruOrder.set(id, 1);
    }
    function releaseCardImage(id: string | number) {
        const url = cardUrls[id];
        if (url?.startsWith('blob:')) { URL.revokeObjectURL(url); objectUrls.delete(url); }
        delete cardUrls[id];
        cardLruOrder.delete(id);
    }
    function trimCardUrls() {
        const excess = Math.max(0, cardLruOrder.size - HD_CACHE_LIMIT);
        for (const id of [...cardLruOrder.keys()].slice(0, excess)) releaseCardImage(id);
    }
    let thumbHydration: Promise<void> | null = null;
    let thumbsDirty = false;
    function hydrateThumbs(): Promise<void> {
        thumbsDirty = true;
        if (thumbHydration) return thumbHydration;
        const epoch = imageEpoch, visited = new Set<string | number>();
        async function run() {
            do {
                thumbsDirty = false;
                // Watchers and mounting share one batch; a changed page reschedules
                // its remaining reads without fetching the same missing preview twice.
                const pending = (collectionPreviewItems.value ?? pagedVisible.value).filter(item => item.image_id && !visited.has(item.id) && !cardUrls[item.id] && !thumbUrls[item.id]);
                let index = 0;
                async function worker() {
                    while (index < pending.length) {
                        if (unmounted || !viewActive || epoch !== imageEpoch || thumbsDirty) return;
                        const item = pending[index++];
                        visited.add(item.id);
                        try {
                            const thumb = await artworkRepository.getThumbnail(item.image_id!);
                            if (unmounted || !viewActive || epoch !== imageEpoch) return;
                            if (typeof thumb === 'string' && thumb.startsWith('data:image/')) thumbUrls[item.id] = thumb;
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
    async function hydrateCard(item: ArtworkRecord) {
        const epoch = imageEpoch;
        const fallback = safeImageUrl(item.image_url);
        let resolved = false;
        try {
            const blob = item.image_id ? await artworkRepository.getImage(item.image_id, imageReads.signal) : null;
            if (unmounted || !viewActive || epoch !== imageEpoch) return;
            if (blob) {
                cardUrls[item.id] = trackUrl(URL.createObjectURL(blob));
                resolved = true;
                // 2026-08-30 治本：旧图缺 KV 缩略图（早期回填逻辑不存在）→ 全靠 HD 大图管线
                // （并发 4 + LRU 40 淘汰），滚动浏览旧区域反复重读大 blob → 一直 loading。
                // 读到 blob 立即降采样出缩略图垫底并回填 KV：卡片秒出图，后续打开走 KV 秒读。
                const imageId = item.image_id;
                if (imageId && !thumbUrls[item.id] && !thumbPending.has(imageId)) {
                    thumbPending.add(imageId);
                    blobThumbDataUrl(blob).then(dataUrl => {
                        if (dataUrl && !unmounted && viewActive && epoch === imageEpoch && history.value.some(entry => entry.id === item.id)) {
                            thumbUrls[item.id] = dataUrl;
                            return artworkRepository.setThumbnail(imageId, dataUrl);
                        }
                    }).catch(() => { }).finally(() => thumbPending.delete(imageId));
                }
            }
            else if (fallback) {
                cardUrls[item.id] = fallback;
                resolved = true;
            }
            else if (item.image_data && String(item.image_data).startsWith('data:image/')) {
                cardUrls[item.id] = item.image_data;
                resolved = true;
            }
            else
                markImageMissing(item.id);
        }
        catch {
            if (unmounted || !viewActive || epoch !== imageEpoch) return;
            if (fallback) {
                cardUrls[item.id] = fallback;
                resolved = true;
            }
            else
                markImageMissing(item.id);
        }
        if (!resolved)
            return;
        // 读取期间被删除的条目：URL 不入册直接释放，避免缓存里留下孤儿
        if (!history.value.some(entry => entry.id === item.id)) {
            releaseCardImage(item.id);
            return;
        }
        touchCardLru(item.id);
        trimCardUrls();
    }
    /** 只有走进视口的卡片才读 HD；再次可见的已淘汰卡片会按需重读 */
    function requestCardHydration(item: ArtworkRecord) {
        if (cardUrls[item.id]) {
            touchCardLru(item.id);
            return;
        }
        if (missingImageIds.value.has(item.id) || queuedCardIds.has(item.id))
            return;
        queuedCardIds.add(item.id);
        cardQueue.push(item);
        pumpCardQueue();
    }
    function pumpCardQueue() {
        if (unmounted || !viewActive) { cardQueue.length = 0; queuedCardIds.clear(); return; }
        while (cardWorkers < CARD_CONCURRENCY && cardQueue.length) {
            const item = cardQueue.shift()!;
            const epoch = imageEpoch;
            cardWorkers += 1;
            void hydrateCard(item).finally(() => {
                cardWorkers -= 1;
                if (epoch === imageEpoch) queuedCardIds.delete(item.id);
                pumpCardQueue();
            });
        }
    }
    /* ---------- 可见性驱动 HD 补图 ---------- */
    const observedCards = new Map<Element, ArtworkRecord>();
    let cardObserver: IntersectionObserver | null = null;
    /**
     * （重）扫描展墙卡片并挂观察器。筛选变化会重建部分节点，旧节点若不
     * unobserve 会一直被 IntersectionObserver 强引用——所以每次全量重挂。
     */
    function scanWallCards() {
        // An empty wall still releases detached nodes and rejects queued deliveries.
        for (const el of observedCards.keys())
            cardObserver?.unobserve(el);
        observedCards.clear();
        if (unmounted || !viewActive || !shellEl.value || !visible.value.length) return;
        if (!cardObserver) {
            cardObserver = new IntersectionObserver(entries => {
                for (const entry of entries) {
                    if (!entry.isIntersecting)
                        continue;
                    const item = observedCards.get(entry.target);
                    if (item)
                        requestCardHydration(item);
                }
            }, { rootMargin: '600px 0px' });
        }
        const byId = new Map(visible.value.map(item => [String(item.id), item]));
        for (const el of shellEl.value.querySelectorAll<HTMLElement>('.artwork')) {
            const item = byId.get(el.dataset.cardId || '');
            if (!item)
                continue;
            observedCards.set(el, item);
            cardObserver.observe(el);
        }
    }
    function toggleInfoDrawer(event?: MouseEvent | KeyboardEvent) { if (!narrowViewer.value) return; viewerEl.value?.toggleAttribute('data-info-instant', event?.detail === 0); if (!infoOpen.value) infoToggleBtn.value?.focus({ preventScroll: true }); infoOpen.value = !infoOpen.value; }
    function closeInfoDrawer(event?: MouseEvent) { viewerEl.value?.toggleAttribute('data-info-instant', !event || event.detail === 0); infoOpen.value = false; }
    function syncNarrowViewer() { const nextNarrow = narrowViewerMedia?.matches ?? false; narrowViewer.value = nextNarrow; if (!nextNarrow && infoOpen.value) { closeInfoDrawer(); void nextTick(() => closeBtn.value?.focus({ preventScroll: true })); } }
    // 父查看器与窄屏信息抽屉叠成两层陷阱：抽屉打开时 Escape 只交给顶层抽屉，
    // 关闭后由子陷阱把焦点还给 .viewer-info-toggle，再由父陷阱管理整个查看器。
    useFocusTrap(viewerEl, () => viewerIndex.value >= 0, {
        onEscape: closeViewer,
        initialFocus: closeBtn,
    });
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
        delete thumbUrls[id];
        if (missingImageIds.value.delete(id))
            missingImageIds.value = new Set(missingImageIds.value);
        forgetRatio(id);
    }
    /* ---------- 键盘 ---------- */
    function onKeydown(e: KeyboardEvent) {
        if (viewerIndex.value < 0 || e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || (e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [contenteditable="true"]')))
            return;
        // Escape 与 Tab 陷阱由 useFocusTrap 处理
        if (e.key === 'ArrowLeft')
            return step(-1);
        if (e.key === 'ArrowRight')
            return step(1);
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
        await loadGalleryStorage();
        compareFromRoute();
        // 回收站懒清理（2026-08-30 UX 审计 P0-8）：真删超期软删条目的图片与
        // 缩略图。不阻塞首屏，失败静默（下次挂载再试）。
        void artworkRepository.purgeExpiredTrash().catch(e => console.warn('[gallery] trash purge failed', e));
        try {
            await sceneStore.load();
            scenes.value = sceneStore.scenes;
            loras.value = sceneStore.loras;
        }
        catch (e) {
            console.warn('gallery data load failed', e);
        }
        // 深链 / 刷新后恢复筛选：必须在项目列表读完之后，否则 select 没有选项可匹配
        restoreFiltersFromQuery();
        void hydrateThumbs();
        await nextTick();
        scanWallCards();
    });
    // KeepAlive preserves filters, pagination and small thumbnails. Leaving the
    // gallery releases original images; the next activation hydrates visible cards
    // and refreshes metadata so newly saved works appear without losing state.
    let activatedOnce = false;
    onActivated(() => { viewActive = true; document.addEventListener('keydown', onKeydown); void nextTick(() => { scanWallCards(); if (moreObserver && sentinelEl.value) moreObserver.observe(sentinelEl.value); }); if (!activatedOnce) { activatedOnce = true; return; } void loadGalleryStorage().then(compareFromRoute); });
    onDeactivated(() => {
        viewActive = false; cleanupFilterSync(); releaseImages();
        document.removeEventListener('keydown', onKeydown); cardQueue.length = 0; queuedCardIds.clear();
        cardObserver?.disconnect(); moreObserver?.disconnect(); observedCards.clear();
    });
    onUnmounted(() => {
        unmounted = true;
        cleanupFilterSync();
        cardObserver?.disconnect();
        cardObserver = null;
        observedCards.clear();
        moreObserver?.disconnect();
        moreObserver = null; narrowViewerMedia?.removeEventListener('change', syncNarrowViewer);
        document.removeEventListener('keydown', onKeydown);
        releaseImages();
    });
    watch(visible, () => {
        const ids = new Set(visible.value.map(item => item.id));
        selectedIds.value = new Set([...selectedIds.value].filter(id => ids.has(id)));
        for (let index = cardQueue.length - 1; index >= 0; index--) {
            if (!ids.has(cardQueue[index].id)) queuedCardIds.delete(cardQueue.splice(index, 1)[0].id);
        }
        void hydrateThumbs();
        void nextTick(() => scanWallCards());
    });
    // 2026-08-30 修复：分页追加（renderLimit 增）只改变 pagedVisible，visible 不变 →
    // 上面 watch 不触发 → 新页卡片从未挂 IntersectionObserver → 无缩略图的旧图永远 skeleton。
    // 监听 pagedVisible 长度变化，翻页后重新取缩略图 + 重挂观察器。
    watch(() => pagedVisible.value.length, () => {
        void hydrateThumbs();
        void nextTick(() => scanWallCards());
    });
    watch(collectionPreviewItems, () => { if (viewActive) void hydrateThumbs(); });
    /* ---------- 分页：哨兵进入视口即追加下一页 ---------- */
    const sentinelEl = ref<HTMLElement | null>(null);
    let moreObserver: IntersectionObserver | null = null;
    function loadMoreIfNeeded() {
        triggerLoadMore(sentinelEl.value);
    }
    onMounted(() => {
        moreObserver = new IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting))
                loadMoreIfNeeded();
        }, { rootMargin: '800px 0px' });
        if (sentinelEl.value)
            moreObserver.observe(sentinelEl.value);
    });
    watch(sentinelEl, el => {
        if (!moreObserver)
            return;
        moreObserver.disconnect();
        if (el)
            moreObserver.observe(el);
    });
    // Filter URL sync replaces query too. Watch the two values independently so
    // it cannot reload/remount the wall and detach an open viewer's focus target.
    watch([() => route.query.compare, () => route.query.batch], () => {
        if (route.path === '/gallery')
            void loadGalleryStorage().then(compareFromRoute);
    });
    const actions = useGalleryExports({ current, stamp, sceneTitle, characterName, showToast });
    const { copiedPrompt, copyPrompt } = actions;
    function downloadCurrent(): Promise<void> { return actions.downloadCurrent(); }
    const trashActions = useGalleryTrash({ trashMode, trashItems, trashThumbs, trashBusy, showToast, loadGalleryStorage });
    const { clearTrash, trashClearing } = trashActions;
    function loadTrash(): Promise<void> { return trashActions.loadTrash(); }
    function restoreTrashItem(id: string | number): Promise<void> { return trashActions.restoreTrashItem(id); }
    function toggleFavorite(item: ArtworkRecord): Promise<void> { return toggleFavoriteAction({ history, showToast }, item); }
    const deleteMotion = useGalleryDeleteMotion(shellEl, () => history.value, () => galleryLoading.value);
    function confirmDelete(item: ArtworkRecord): Promise<void> { return confirmDeleteAction({ showToast, deleting, viewerIndex, visible, indexOf, history, releaseCardResources, pendingDeleteId, closeViewer, openViewer, bulkDeleting, selectedIds, loadGalleryStorage, onDeleted: deleteMotion.forAction() }, item); }
    function bulkDelete(): Promise<void> { return bulkDeleteAction({ showToast, deleting, viewerIndex, visible, indexOf, history, releaseCardResources, pendingDeleteId, closeViewer, openViewer, bulkDeleting, selectedIds, loadGalleryStorage, onDeleted: deleteMotion.forAction() }); }
    return {
closeBtn, viewerEl, infoEl, infoToggleBtn, infoCloseBtn, sentinelEl, shellEl,
        countLabel, searchQuery, favoriteOnly, favoriteCount, projectFilter, projects, tagFilter, tagOptions, characterFilter, collectionPreviewItems,
        generationConditions, generationOptions, generationFilterCount, filterSnapshot, hasActiveFilters, applyFilterSnapshot, clearGenerationConditions, projectOptions, projectUnavailable,
        selectMode, toggleSelectMode, trashMode, toggleTrashMode, trashItems, selectedIds,
        visible, compareSelected, selectAllVisible, allVisibleSelected, bulkDeleting, bulkDelete,
        compareOpen, compareItems, loadGalleryStorage, trashBusy, trashThumbs, trashPrompt,
        formatTrashTime, restoreTrashItem, clearTrash, trashClearing, galleryLoading, galleryError, history, resetGalleryFilters,
        masonryGroups, columnCount, pendingDeleteId, ratioOf, deleting, confirmDelete,
        sceneTitle, toggleFavorite, toggleSelect, openViewer, indexOf, thumbUrls,
        measure, cardUrls, onHdLoad, missingImageIds, formatDate, stamp,
        hasMoreToRender, pagedVisible, viewerIndex, infoOpen, infoDrawerHidden, toggleInfoDrawer, closeInfoDrawer, closeViewer, onViewerClosed, step,
        compareMode, hasComparableImage, viewerUrl, parentImageUrl, current, characterName,
        facts, downloadCurrent, copiedPrompt, copyPrompt, showToast, releaseCardResources,
    };
}

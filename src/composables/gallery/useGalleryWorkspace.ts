import { characterName as resolveCharacterName } from './galleryHelpers';
import { artworkIndexById,formatTrashTime,hiresLabel,modelName,loraName as resolveLoraName,sceneTitle as resolveSceneTitle,searchHaystack,trashPrompt,} from '@/composables/gallery/galleryHelpers';
import { matchesArtwork } from '@/utils/artworkSearch';
import { useArtworkRatios } from '@/composables/gallery/useArtworkRatios';
import { buildMasonryGroups,useMasonryColumns } from '@/composables/gallery/useMasonryWall';
import { useFocusTrap } from '@/composables/useFocusTrap';
import { imgGet } from '@/composables/useImageStore';
import { kvGet,kvSet } from '@/composables/useKVStore';
import { useScrollReveal } from '@/composables/useScrollReveal';
import { useToast } from '@/composables/useToast';
import { artworkRepository,type TrashEntry } from '@/storage/artworkRepository';
import type { LoraMeta,Scene } from '@/stores/sceneStore';
import { useSceneStore } from '@/stores/sceneStore';
import { artworkTimestamp,type ArtworkRecord } from '@/types/artwork';
import { blobThumbDataUrl,thumbKey } from '@/utils/imageThumb';
import { computed,nextTick,onActivated,onDeactivated,onMounted,onUnmounted,reactive,ref,watch } from 'vue';
import type { LocationQueryRaw } from 'vue-router';
import { useRoute,useRouter } from 'vue-router';
import { dayGroup,formatDate,safeImageUrl } from './galleryHelpers';
import { bulkDeleteAction,confirmDeleteAction,toggleFavoriteAction } from './galleryMutations';
import { loadGalleryStorageAction,type GalleryProject } from './galleryStorage';
import { useGalleryExports } from './useGalleryExports';
import { useGalleryTrash } from './useGalleryTrash';
/** Owns workspace state and lifecycle; the view only binds presentation. */
export function useGalleryWorkspace() {
    const sceneStore = useSceneStore();
    useScrollReveal();
    const { show: showToast } = useToast();
    const route = useRoute();
    const router = useRouter();

    // 键名统一出处：src/utils/storageKeys.ts。本文件曾把项目键写成旧键
    // aics_projects（见下方 LEGACY_PROJECT_KEY），与备份读写的新键各操作一套数据且永久分叉。

    /** 旧键，仅用于一次性迁移 */


    const history = ref<ArtworkRecord[]>([]);
    const projects = ref<GalleryProject[]>([]);
    const scenes = ref<Scene[]>([]);
    const loras = ref<LoraMeta[]>([]);
    const favoriteOnly = ref(false);
    const projectFilter = ref('');
    /** 展墙搜索（2026-08-30 UX 审计 P1）：此前只有「收藏 + 项目」两个控件，
     *  攒到几百张后找某张旧作只能靠翻。 */
    const searchQuery = ref('');
    const galleryLoading = ref(true);
    const galleryError = ref('');
    const viewerIndex = ref(-1);
    const viewerItemId = ref<string | number | null>(null);
    const infoOpen = ref(false);
    const narrowViewerMedia = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(max-width: 900px)') : null;
    const narrowViewer = ref(narrowViewerMedia?.matches ?? false);
    const infoDrawerHidden = computed(() => narrowViewer.value && !infoOpen.value);
    const compareMode = ref(false);
    const viewerUrl = ref('');
    const cardUrls = reactive<Record<string, string>>({});
    /** 缩略图缓存（KV dataURL），比 HD blob 快读先显示 */
    const thumbUrls = reactive<Record<string, string>>({});
    const missingImageIds = ref(new Set<string | number>());
    /** 缩略图生成去重：HD 管线与解码回填共用，同一张图并发只生成一次 */
    const thumbPending = new Set<string>();
    const { ratioOf, measure, forgetRatio } = useArtworkRatios({
        pending: thumbPending,
        hasThumb: item => Boolean(thumbUrls[item.id]),
        saveThumb: (item, dataUrl, imageId) => kvSet(thumbKey(imageId), dataUrl).then(() => { thumbUrls[item.id] = dataUrl; }),
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
    /** 多选模式与已选集合（2026-08-30 UX 审计 P1：批量清理） */
    const selectMode = ref(false);
    const selectedIds = ref(new Set<string | number>());
    const compareOpen = ref(false), compareIds = ref<string[]>([]);
    const compareItems = computed(() => history.value.filter(item => compareIds.value.includes(String(item.id))));
    function compareSelected() { compareIds.value = [...selectedIds.value].map(String).slice(0, 4); compareOpen.value = compareIds.value.length >= 2; }
    function compareFromRoute() {
        if (route.path !== '/gallery' || typeof route.query.compare !== 'string')
            return;
        compareIds.value = route.query.compare.split(',').slice(0, 4);
        compareOpen.value = compareItems.value.length >= 2;
    }
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
    const objectUrls = new Set<string>();
    /** 查看器当前显示的 blob URL，翻页时要主动释放 */
    let viewerObjectUrl = '';
    let viewerLoadToken = 0;
    let unmounted = false;
    let viewActive = true;
    /* ---------- 派生数据 ---------- */
    const visible = computed(() => {
        let source = favoriteOnly.value ? history.value.filter(i => i.favorite) : history.value.slice();
        if (projectFilter.value) {
            const p = projects.value.find(x => x.id === projectFilter.value);
            if (p)
                source = source.filter(i => Array.isArray(p.history_ids) && p.history_ids.includes(i.id));
        }
        const term = searchQuery.value.trim().toLowerCase();
        if (term)
            source = source.filter(i => matchesArtwork(searchHaystack(i), term));
        // 历史是按生成顺序 append 的，展墙必须自己排：最新在前。
        // 之前直接用了存储顺序，所以作品册永远是最旧的排在最上面。
        return source.sort((a, b) => stamp(b) - stamp(a));
    });
    const favoriteCount = computed(() => history.value.filter(i => i.favorite).length);
    const countLabel = computed(() => `${visible.value.length} 幅作品`);
    const current = computed(() => {
        const index = artworkIndexById(history.value, viewerItemId.value);
        return index >= 0 ? history.value[index] : null;
    });
    /* ---------- 分页渲染：滚动触底递增，避免数百作品全量铺 DOM ----------
       查看器导航仍走完整 visible；分页只约束「展墙渲染多少张」。 */
    const PAGE_SIZE = 60;
    const renderLimit = ref(PAGE_SIZE);
    const pagedVisible = computed(() => visible.value.slice(0, renderLimit.value));
    const hasMoreToRender = computed(() => visible.value.length > pagedVisible.value.length);
    /* ---------- 时间分组与多列瀑布流 ---------- */
    const groups = computed(() => {
        const order = ['今天', '本周', '更早'];
        const buckets: Record<string, ArtworkRecord[]> = {};
        pagedVisible.value.forEach(item => {
            const key = dayGroup(stamp(item));
            (buckets[key] = buckets[key] || []).push(item);
        });
        return order.filter(k => buckets[k]?.length).map(k => ({ key: k, items: buckets[k] }));
    });
    const { columnCount } = useMasonryColumns(shellEl);
    const masonryGroups = computed(() => buildMasonryGroups(groups.value, ratioOf, columnCount.value));
    const parentArtwork = computed(() => {
        const pId = current.value?.parent_id;
        if (!pId)
            return null;
        return history.value.find(h => String(h.id) === String(pId)) || null;
    });
    const parentImageUrl = computed(() => {
        if (!parentArtwork.value)
            return '';
        const pId = parentArtwork.value.id;
        return cardUrls[pId] || thumbUrls[pId] || '';
    });
    const hasComparableImage = computed(() => {
        if (!current.value)
            return false;
        return Boolean(parentImageUrl.value || thumbUrls[current.value.id]);
    });
    function resetGalleryFilters() {
        favoriteOnly.value = false;
        projectFilter.value = '';
        searchQuery.value = '';
    }
    /* ---------- 筛选状态进 URL（2026-08-30 UX 审计 P1）----------
       刷新页面、把链接存成书签、或从别处带着参数跳进来时，筛选条件不该归零。 */
    /**
     * 只在挂载时读 URL。
     *
     * 不在 onActivated 读：本页被 KeepAlive 缓存，从 Remix 回来时组件状态还在，
     * 而那次返回的 URL 大概率是干净的 /gallery——照着它恢复反而会把用户当前的
     * 筛选清掉，比不做还糟。
     */
    function restoreFiltersFromQuery() {
        const q = route.query;
        if (typeof q.fav === 'string')
            favoriteOnly.value = q.fav === '1';
        if (typeof q.project === 'string')
            projectFilter.value = q.project;
        if (typeof q.q === 'string')
            searchQuery.value = q.q;
    }
    let syncTimer: ReturnType<typeof setTimeout> | null = null;
    /**
     * 写回 URL。
     *
     * 用 replace 而不是 push：筛选是高频微调，不该把后退键变成「逐步撤销筛选」
     * 的历史栈。搜索输入带 300ms 防抖，避免每敲一个字就改一次地址。
     */
    function syncFiltersToQuery() {
        const q = route.query;
        const fav = q.fav === '1';
        const project = typeof q.project === 'string' ? q.project : '';
        const term = typeof q.q === 'string' ? q.q : '';
        // 与地址栏已经一致就什么都不做：挂载时从 URL 恢复会反过来触发这里，
        // 不挡住会多出一次无意义的导航
        if (fav === favoriteOnly.value && project === projectFilter.value && term === searchQuery.value.trim())
            return;
        if (syncTimer)
            clearTimeout(syncTimer);
        syncTimer = setTimeout(() => {
            syncTimer = null;
            // LocationQuery 的值允许是数组（?a=1&a=2），不能断言成 Record<string,string>
            const query: LocationQueryRaw = { ...route.query };
            if (favoriteOnly.value)
                query.fav = '1';
            else
                delete query.fav;
            if (projectFilter.value)
                query.project = projectFilter.value;
            else
                delete query.project;
            const next = searchQuery.value.trim();
            if (next)
                query.q = next;
            else
                delete query.q;
            void router.replace({ query });
        }, 300);
    }
    const facts = computed(() => {
        if (!current.value)
            return [];
        const i = current.value;
        return [
            { label: '尺寸', value: i.size || '' },
            { label: 'LoRA', value: loraName(i.lora) },
            { label: '模型', value: modelName(i.checkpoint) },
            { label: 'Seed', value: i.seed == null ? '' : String(i.seed) },
            { label: 'Sampler', value: i.sampler || '' },
            // 2026-08-29 修复：回显高清修复与采样参数（旧条目缺字段显示「—」）。
            { label: '高清修复', value: hiresLabel(i) },
            { label: 'CFG', value: i.cfg == null ? '' : String(i.cfg) },
            { label: '步数', value: i.steps == null ? '' : String(i.steps) },
        ];
    });
    /* ---------- 工具函数 ---------- */
    function sceneTitle(id: string | null | undefined, item?: ArtworkRecord) {
        return resolveSceneTitle(id, item, scenes.value, sceneStore.popularCharacters);
    }
    function loraName(id: string | null | undefined) {
        return resolveLoraName(id, loras.value);
    }
    function characterName(v: string | undefined, item?: ArtworkRecord) { return resolveCharacterName(v, item, sceneStore.popularCharacters); }
    /** 时间戳兜底：老记录可能把 timestamp 存成字符串，或干脆没有 */
    function stamp(item: ArtworkRecord): number { return artworkTimestamp(item); }


    function indexOf(item: ArtworkRecord) { return visible.value.indexOf(item); }

    function trackUrl(url: string) { objectUrls.add(url); return url; }
    function markImageMissing(id: string | number) {
        missingImageIds.value = new Set([...missingImageIds.value, id]);
    }
    function revokeAll() {
        objectUrls.forEach(u => URL.revokeObjectURL(u));
        objectUrls.clear();
    }
    /* ---------- 图片加载 ---------- */
    /**
     * 缩略图（KV 小 dataURL）便宜：整墙全量补齐，先让每张卡有图。
     * HD blob 贵且占内存（KeepAlive 后几百张大图数百 MB），改为可见性驱动：
     * IntersectionObserver 只对进入视口 ±600px 的卡片发起 HD 读取，配合
     * LRU 上限滚动淘汰。旧实现是「全量读出 → 丢掉超出 40 张的」，几百张
     * 作品时绝大多数 IndexedDB 读取和 blob 创建都是纯浪费。
     * 查看器大图单独走 hydrateViewer，不受上限影响。
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
    function trimCardUrls() {
        if (cardLruOrder.size <= HD_CACHE_LIMIT)
            return;
        const excess = cardLruOrder.size - HD_CACHE_LIMIT;
        for (const id of [...cardLruOrder.keys()].slice(0, excess)) {
            cardLruOrder.delete(id);
            const url = cardUrls[id];
            if (url && url.startsWith('blob:')) {
                URL.revokeObjectURL(url);
                objectUrls.delete(url);
            }
            delete cardUrls[id];
        }
    }
    async function hydrateThumbs() {
        // 只为已进入渲染窗口的作品取缩略图（分页外的不预取）
        const pending = pagedVisible.value.filter(item => !cardUrls[item.id] && !thumbUrls[item.id]);
        let index = 0;
        async function worker() {
            while (index < pending.length) {
                const item = pending[index++];
                if (unmounted || !viewActive) return;
                if (!item.image_id)
                    continue;
                try {
                    const thumb = await kvGet<string>(thumbKey(item.image_id));
                    if (unmounted)
                        return;
                    if (typeof thumb === 'string' && thumb.startsWith('data:image/')) {
                        thumbUrls[item.id] = thumb;
                    }
                }
                catch { /* 缩略图缺失正常，直接走 HD */ }
            }
        }
        await Promise.all(Array.from({ length: Math.min(THUMB_CONCURRENCY, pending.length) }, () => worker()));
    }
    async function hydrateCard(item: ArtworkRecord) {
        const fallback = safeImageUrl(item.image_url);
        let resolved = false;
        try {
            const blob = item.image_id ? await imgGet(item.image_id) : null;
            if (unmounted || !viewActive) return;
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
                        if (dataUrl && !unmounted && viewActive && history.value.some(entry => entry.id === item.id)) {
                            thumbUrls[item.id] = dataUrl;
                            void kvSet(thumbKey(imageId), dataUrl);
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
            const url = cardUrls[item.id];
            if (url && url.startsWith('blob:')) {
                URL.revokeObjectURL(url);
                objectUrls.delete(url);
            }
            delete cardUrls[item.id];
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
            cardWorkers += 1;
            void hydrateCard(item).finally(() => {
                cardWorkers -= 1;
                queuedCardIds.delete(item.id);
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
        if (!viewActive || !shellEl.value || !visible.value.length) return;
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
        for (const el of observedCards.keys())
            cardObserver.unobserve(el);
        observedCards.clear();
        const byId = new Map(visible.value.map(item => [String(item.id), item]));
        for (const el of shellEl.value.querySelectorAll<HTMLElement>('.artwork')) {
            const item = byId.get(el.dataset.cardId || '');
            if (!item)
                continue;
            observedCards.set(el, item);
            cardObserver.observe(el);
        }
    }
    async function hydrateViewer(item: ArtworkRecord) {
        // 上一张查看器大图用完就释放：卡片缩略图有 cardUrls 去重，
        // 而查看器每翻一张都新建一个 blob URL，不放就攒到卸载才清。
        releaseViewerUrl();
        viewerUrl.value = '';
        const token = ++viewerLoadToken;
        const fallback = safeImageUrl(item.image_url);
        try {
            const blob = item.image_id ? await imgGet(item.image_id) : null;
            if (unmounted || token !== viewerLoadToken || current.value?.id !== item.id)
                return;
            if (blob) {
                viewerObjectUrl = URL.createObjectURL(blob);
                objectUrls.add(viewerObjectUrl);
                viewerUrl.value = viewerObjectUrl;
            }
            else if (fallback)
                viewerUrl.value = fallback;
            else if (item.image_data && String(item.image_data).startsWith('data:image/'))
                viewerUrl.value = item.image_data;
        }
        catch {
            if (!unmounted && token === viewerLoadToken) viewerUrl.value = '';
        }
    }
    /** 查看器当前大图的 blob URL；卡片缩略图不走这里 */
    function releaseViewerUrl() {
        if (!viewerObjectUrl)
            return;
        // 缩略图可能复用同一个 URL，只释放没被 cardUrls 引用的
        const stillUsed = Object.values(cardUrls).includes(viewerObjectUrl);
        if (!stillUsed) {
            URL.revokeObjectURL(viewerObjectUrl);
            objectUrls.delete(viewerObjectUrl);
        }
        viewerObjectUrl = '';
    }
    /* ---------- Viewer 控制 ---------- */
    let releaseViewerTimer: ReturnType<typeof setTimeout> | undefined;
    function openViewer(index: number) {
        clearTimeout(releaseViewerTimer);
        const item = visible.value[index];
        if (!item) return;
        viewerItemId.value = item.id;
        viewerIndex.value = index;
        infoOpen.value = false;
        compareMode.value = false;
        void hydrateViewer(item);
    }
    function closeViewer() {
        viewerLoadToken += 1;
        viewerItemId.value = null;
        viewerIndex.value = -1;
        infoOpen.value = false;
        compareMode.value = false;
        clearTimeout(releaseViewerTimer);
        releaseViewerTimer = setTimeout(() => { if (viewerIndex.value < 0) { releaseViewerUrl(); viewerUrl.value = ''; } }, 260);
    }
    function toggleInfoDrawer() { if (!narrowViewer.value) return; if (!infoOpen.value) infoToggleBtn.value?.focus({ preventScroll: true }); infoOpen.value = !infoOpen.value; }
    function closeInfoDrawer() { infoOpen.value = false; }
    function syncNarrowViewer() { const nextNarrow = narrowViewerMedia?.matches ?? false; narrowViewer.value = nextNarrow; if (!nextNarrow && infoOpen.value) { closeInfoDrawer(); void nextTick(() => closeBtn.value?.focus({ preventScroll: true })); } }
    // 父查看器与窄屏信息抽屉叠成两层陷阱：抽屉打开时 Escape 只交给顶层抽屉，
    // 关闭后由子陷阱把焦点还给 .viewer-info-toggle，再由父陷阱管理整个查看器。
    useFocusTrap(viewerEl, () => viewerIndex.value >= 0, {
        onEscape: closeViewer,
        initialFocus: closeBtn,
    });
    useFocusTrap(infoEl, () => narrowViewer.value && infoOpen.value, {
        onEscape: closeInfoDrawer, initialFocus: infoCloseBtn, lockScroll: false,
    });
    function step(delta: number) {
        const activeIndex = artworkIndexById(visible.value, viewerItemId.value);
        const next = activeIndex + delta;
        if (next >= 0 && next < visible.value.length)
            openViewer(next);
    }
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
        const url = cardUrls[id];
        if (url && url.startsWith('blob:')) {
            URL.revokeObjectURL(url);
            objectUrls.delete(url);
        }
        delete cardUrls[id];
        cardLruOrder.delete(id);
        delete thumbUrls[id];
        if (missingImageIds.value.delete(id))
            missingImageIds.value = new Set(missingImageIds.value);
        forgetRatio(id);
    }
    /**
     * 删除（2026-08-30 UX 审计 P0-8：原为硬删不可恢复）。
     *
     * 现在默认走软删：列表与项目引用立即消失（界面反馈与从前一致），但原图
     * 与缩略图保留 30 天，toast 上给 5 秒「撤销」窗口；超期由挂载时的懒清理
     * 真删。攒几百张时误删不再是不可逆损失。
     */
    /* ---------- 多选批量（2026-08-30 UX 审计 P1）---------- */
    function toggleSelectMode() {
        selectMode.value = !selectMode.value;
        if (!selectMode.value)
            selectedIds.value = new Set();
    }
    function toggleSelect(id: string | number) {
        const next = new Set(selectedIds.value);
        if (next.has(id))
            next.delete(id);
        else
            next.add(id);
        selectedIds.value = next;
    }
    const allVisibleSelected = computed(() => visible.value.length > 0 && visible.value.every(item => selectedIds.value.has(item.id)));
    function selectAllVisible() {
        if (allVisibleSelected.value) {
            selectedIds.value = new Set();
            return;
        }
        selectedIds.value = new Set(visible.value.map(item => item.id));
    }
    /**
     * 批量移入回收站。
     *
     * 逐条走软删（与单张同一实现），因此同样享受 30 天保留与「已移入回收站」的
     * 一致性；失败不中断，最后如实汇报成功/失败条数——批量操作最怕的是「以为全
     * 成了，其实只成了一半」。
     */
    /** 批量撤销：整组恢复，失败条数如实汇报。 */
    /** 撤销软删：整条恢复（历史条目 + 项目引用），刷新列表即可见。 */
    /** 下载当前作品的原图文件（优先 IndexedDB 原图 blob，注入 Civitai 级元数据） */
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
            toggleInfoDrawer();
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
    /**
     * 作品册被 AppLayout 的 KeepAlive 缓存（数百张大图 blob 与解码结果常驻内存，
     * 切走再回来秒开，不需要重新从 IndexedDB 读图）。
     *
     * 代价是 onMounted 只在**首次**进入时跑一次，此后重新激活不会重读 KV：
     * 画出一张 →「保存快照」→ 进作品册，看到的仍是离开时那份旧列表，
     * 用户会判定「保存失败」并重复保存、甚至重画（2026-08-30 UX 审计 P0-7）。
     *
     * 这里只增量重读 KV，不重建 blob 缓存（revokeAll 挂在 onUnmounted，
     * 缓存期间不触发）——既修掉陈旧列表，又不丢 KeepAlive 的意义。
     * 列表若真有变化，watch(visible) 会自动补缩略图并重挂观察器。
     */
    let activatedOnce = false;
    onActivated(() => { viewActive = true; document.addEventListener('keydown', onKeydown); void nextTick(() => { scanWallCards(); if (moreObserver && sentinelEl.value) moreObserver.observe(sentinelEl.value); }); if (!activatedOnce) { activatedOnce = true; return; } void loadGalleryStorage().then(compareFromRoute); });
    onDeactivated(() => { viewActive = false; closeViewer(); document.removeEventListener('keydown', onKeydown); cardQueue.length = 0; queuedCardIds.clear(); cardObserver?.disconnect(); moreObserver?.disconnect(); observedCards.clear(); });
    onUnmounted(() => {
        unmounted = true;
        clearTimeout(releaseViewerTimer);
        viewerLoadToken += 1;
        // 防抖定时器里握着 router，不请掉会在组件卸载后改一次导航
        if (syncTimer) {
            clearTimeout(syncTimer);
            syncTimer = null;
        }
        cardObserver?.disconnect();
        cardObserver = null;
        observedCards.clear();
        moreObserver?.disconnect();
        moreObserver = null; narrowViewerMedia?.removeEventListener('change', syncNarrowViewer);
        document.removeEventListener('keydown', onKeydown);
        revokeAll();
    });
    watch(visible, () => {
        if (viewerIndex.value >= 0) {
            const activeIndex = artworkIndexById(visible.value, viewerItemId.value);
            if (activeIndex < 0)
                closeViewer();
            else
                viewerIndex.value = activeIndex;
        }
        const ids = new Set(visible.value.map(item => item.id));
        selectedIds.value = new Set([...selectedIds.value].filter(id => ids.has(id)));
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
    /* ---------- 分页：哨兵进入视口即追加下一页 ---------- */
    const sentinelEl = ref<HTMLElement | null>(null);
    let moreObserver: IntersectionObserver | null = null;
    function loadMoreIfNeeded() {
        if (!viewActive || !hasMoreToRender.value) return;
        renderLimit.value = Math.min(renderLimit.value + PAGE_SIZE, visible.value.length);
        // 极端情况：新页仍不足以把哨兵推出视口（如全部同比例小图）。
        // nextTick 后再探测一次，直到哨兵离开视口或加载完毕，保证分页总能继续。
        void nextTick(() => {
            if (!viewActive || !hasMoreToRender.value || !sentinelEl.value) return;
            if (sentinelEl.value.getBoundingClientRect().top < window.innerHeight + 800)
                loadMoreIfNeeded();
        });
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
    watch(() => [route.query.compare, route.query.batch], () => {
        if (route.path === '/gallery')
            void loadGalleryStorage().then(compareFromRoute);
    });
    // 筛选变化回到第一页，让用户始终从最新作品看起
    watch([favoriteOnly, projectFilter, searchQuery], () => {
        renderLimit.value = PAGE_SIZE;
        selectedIds.value = new Set();
        syncFiltersToQuery();
    });
    const actions = useGalleryExports({ current, stamp, sceneTitle, characterName, showToast });
    const { copiedPrompt, copyPrompt } = actions;
    function downloadCurrent(): Promise<void> { return actions.downloadCurrent(); }
    const trashActions = useGalleryTrash({ trashItems, trashThumbs, trashBusy, showToast, loadGalleryStorage });
    function loadTrash(): Promise<void> { return trashActions.loadTrash(); }
    function restoreTrashItem(id: string | number): Promise<void> { return trashActions.restoreTrashItem(id); }
    function toggleFavorite(item: ArtworkRecord): Promise<void> { return toggleFavoriteAction({ history, showToast }, item); }
    function confirmDelete(item: ArtworkRecord): Promise<void> { return confirmDeleteAction({ showToast, deleting, viewerIndex, visible, indexOf, history, releaseCardResources, pendingDeleteId, closeViewer, openViewer, bulkDeleting, selectedIds, loadGalleryStorage }, item); }
    function bulkDelete(): Promise<void> { return bulkDeleteAction({ showToast, deleting, viewerIndex, visible, indexOf, history, releaseCardResources, pendingDeleteId, closeViewer, openViewer, bulkDeleting, selectedIds, loadGalleryStorage }); }
    return {
closeBtn, viewerEl, infoEl, infoToggleBtn, infoCloseBtn, sentinelEl, shellEl,
        countLabel, searchQuery, favoriteOnly, favoriteCount, projectFilter, projects,
        selectMode, toggleSelectMode, trashMode, toggleTrashMode, trashItems, selectedIds,
        visible, compareSelected, selectAllVisible, allVisibleSelected, bulkDeleting, bulkDelete,
        compareOpen, compareItems, loadGalleryStorage, trashBusy, trashThumbs, trashPrompt,
        formatTrashTime, restoreTrashItem, galleryLoading, galleryError, history, resetGalleryFilters,
        masonryGroups, columnCount, pendingDeleteId, ratioOf, deleting, confirmDelete,
        sceneTitle, toggleFavorite, toggleSelect, openViewer, indexOf, thumbUrls,
        measure, cardUrls, onHdLoad, missingImageIds, formatDate, stamp,
        hasMoreToRender, pagedVisible, viewerIndex, infoOpen, infoDrawerHidden, toggleInfoDrawer, closeInfoDrawer, closeViewer, step,
        compareMode, hasComparableImage, viewerUrl, parentImageUrl, current, characterName,
        facts, downloadCurrent, copiedPrompt, copyPrompt, showToast, releaseCardResources,
    };
}

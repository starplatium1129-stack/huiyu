import { profileLocalStorage as localStorage } from '../../platform/web/profileStorage.ts'
import { useToast } from '@/composables/useToast';
import { useSceneExplorerFilters } from './useSceneExplorerFilters';
import { artworkRepository } from '@/storage/artworkRepository';
import { useSceneStore,type CurationData,type SceneBrowseTarget } from '@/stores/sceneStore';
import { scrollBehavior } from '@/utils/motionPreference';
import { quickCreateUrl } from '@/utils/quickCreate';
import { isLocalStudioHost } from '@/utils/runtimeEnvironment';
import { buildPreferenceProfile,readHiddenScenes,readSceneUsage,analyzeQuery as uxAnalyze,isPersonalFavorite as uxIsFav,matchesSearch as uxMatchesSearch,personalReason as uxPersonalReason,prepareSceneSearch,searchScore as uxSearchScore,tier as uxTier,writeHiddenScenes,type PreferenceProfile,type SceneUsageRecord,type SceneUXConfig } from '@/utils/sceneUX';
import { captureScrollAnchor,restoreScrollAnchor,watchForUserScroll,type ScrollAnchor } from '@/utils/scrollAnchor';
import {
    DEFAULT_RAILS,
    THEME_DEFS,
    matchesSeries,
    matchesTheme,
    matchesTime,
    primaryCategory,
    sceneCharacterName as charName,
    sceneSeasonLabel as seasonLabel,
    sceneTimeLabel as timeLabel,
    sceneVisualLabels,
    type ExplorerScene,
} from './sceneExplorerPresentation';
import { orderExplorerScenes } from './sceneExplorerOrdering';
import { computed,nextTick,onMounted,onUnmounted,ref,shallowRef,watch } from 'vue';
import { useRoute } from 'vue-router';
/** Owns workspace state and lifecycle; the view only binds presentation. */
export function useSceneExplorerWorkspace() {
    interface ExplorerCuration extends CurationData, SceneUXConfig {
        moodRails?: Array<{
            character: string;
            icon?: string;
            title: string;
            subtitle: string;
            query: string;
        }>;
        recommendationReasons?: Record<string, string>;
    }
    const PAGE_SIZE = 24;
    const FAV_KEY = 'aics_scene_favorites';
    const route = useRoute();
    const sceneStore = useSceneStore();
    const toast = useToast();
    // loadBrowserScenes supplies an owned snapshot; browsing replaces it, never edits its rows.
    const scenes = shallowRef<ExplorerScene[]>([]);
    const curation = ref<ExplorerCuration>({ curatedSceneIds: [], moodRails: [], signatureSceneIds: [], reviewSceneIds: [] });
    const profile = ref<PreferenceProfile>(buildPreferenceProfile([]));
    const loading = ref(true);
    const loadError = ref('');
    const flashId = ref('');
    const drawerScene = ref<ExplorerScene | null>(null);
    function readFavorites() {
        try {
            const value = JSON.parse(localStorage.getItem(FAV_KEY) || '[]');
            return new Set<string>(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []);
        }
        catch {
            return new Set<string>();
        }
    }
    const favs = ref(readFavorites());
    const hiddenIds = ref(readHiddenScenes());
    const localUsage = ref(readSceneUsage());
    const adultEnabled = isLocalStudioHost();
    const showMature = ref(adultEnabled);
    const defaultTier = Object.keys(localUsage.value).length || favs.value.size ? 'personal' : 'core';
    const filters = useSceneExplorerFilters(defaultTier);
    const { searchQuery, debouncedQuery, activeTheme, fChar, fSeason, fTime, fSeries,
        fRating, fTier, sortBy, showHidden, resetFilters } = filters;
    /** 首帧数据就绪标记：避免初始化时赋初值触发数据 watch 重复加载 */
    let dataReady = false;
    /**
     * 筛选期间的位置锚点（F3.2）：把列表抽短会让文档变矮，浏览器随即把滚动位置钳掉，
     * 清空筛选后用户就回不到原处（实测 700 → 473）。这里记住塌缩前的位置，等列表长回来再恢复。
     *
     * 只在"还没有待恢复锚点"时重新记：清空筛选那一次读到的是已经被钳掉的位置，
     * 不能拿它当新锚点，否则恢复目标就被自己覆盖掉了。
     * 用户在筛选状态里自己滚动过（真实手势）就放弃恢复，不把人拽回旧位置。
     */
    let filterAnchor: ScrollAnchor | null = null;
    let stopWatchingUserScroll: (() => void) | null = null;
    let cancelFilterRestore: (() => void) | null = null;
    function clearFilterAnchor() {
        filterAnchor = null;
        cancelFilterRestore?.();
        cancelFilterRestore = null;
        stopWatchingUserScroll?.();
        stopWatchingUserScroll = null;
    }
    function holdFilterAnchor() {
        if (!filterAnchor) {
            const captured = captureScrollAnchor();
            if (!captured)
                return;
            filterAnchor = captured;
            stopWatchingUserScroll = watchForUserScroll(clearFilterAnchor);
        }
        // 取消句柄是本组合式函数自己的：筛选随后要写 URL，路由的取消不能连带干掉这一路。
        // 文档还没长回来时原语会超时放弃并把锚点留着，等下一次筛选变化（例如清空）再试。
        cancelFilterRestore?.();
        cancelFilterRestore = restoreScrollAnchor(filterAnchor, {
            shouldContinue: () => filterAnchor !== null,
            onRestored: clearFilterAnchor,
            onAbandoned: () => { cancelFilterRestore = null; },
        });
    }
    watch(debouncedQuery, holdFilterAnchor);
    let loadRevision = 0;
    let flashTimer: ReturnType<typeof setTimeout> | undefined;
    onUnmounted(() => { dataReady = false; loadRevision++; clearTimeout(flashTimer); clearFilterAnchor(); });
    const manualCompanion = ref<'nene' | 'natsume' | null>(null);
    const companionId = computed<'nene' | 'natsume'>(() => {
        if (manualCompanion.value) return manualCompanion.value;
        if (fChar.value === 'natsume')
            return 'natsume';
        if (fChar.value === 'nene')
            return 'nene';
        const q = searchQuery.value.toLowerCase();
        if (q.includes('natsume') || q.includes('夏目'))
            return 'natsume';
        if (q.includes('nene') || q.includes('宁宁'))
            return 'nene';
        return 'nene';
    });
    const visible = ref(PAGE_SIZE);
    // --- derived ---
    const moodRails = computed(() => curation.value.moodRails?.length ? curation.value.moodRails : DEFAULT_RAILS);
    const matureCount = computed(() => scenes.value.filter(s => s.mature).length);
    const hiddenCount = computed(() => hiddenIds.value.size);
    const usedCount = computed(() => Object.keys(localUsage.value).length);
    const favoriteCount = computed(() => scenes.value.filter(s => favs.value.has(s.id) || uxIsFav(s, profile.value)).length);
    const availableCount = computed(() => scenes.value.filter(s => !hiddenIds.value.has(s.id) && (showMature.value || !s.mature)).length);
    const tierLabel = computed(() => {
        if (showHidden.value)
            return '已隐藏';
        if (debouncedQuery.value.trim())
            return '搜索结果';
        return ({ personal: '我的常用', core: '人设核心', featured: '精选', signature: '招牌', curated: '精选', all: '全库' } as Record<string, string>)[fTier.value] || '场景';
    });
    const classification = computed(() => {
        const config = curation.value;
        const core = new Set(Array.isArray(config.personaCoreSceneIds) ? config.personaCoreSceneIds : []);
        const tiers = new Map<string, ReturnType<typeof uxTier>>();
        // Preserve signature > review > curated precedence, including overlaps.
        for (const name of ['signature', 'review', 'curated'] as const) {
            const ids = config[`${name}SceneIds`];
            if (Array.isArray(ids)) for (const id of ids) if (!tiers.has(id)) tiers.set(id, name);
        }
        return { core, tiers };
    });
    function tier(s: ExplorerScene) { return classification.value.tiers.get(s.id) || 'standard'; }
    function isCore(s: ExplorerScene) { return classification.value.core.has(s.id); }
    function personalReason(s: ExplorerScene) {
        const usage = usageFor(s);
        const localReason = usage
            ? `你选用过 ${usage.uses} 次${usage.lastUsed ? ` · 最近 ${relativeUsedAt(usage.lastUsed)}` : ''}`
            : '';
        const r = localReason || uxPersonalReason(s, profile.value) || (curation.value.recommendationReasons || {})[s.id] || '';
        return /实机生成与直接视觉复核/.test(r) ? '' : r;
    }
    function usageFor(s: ExplorerScene): SceneUsageRecord | undefined { return localUsage.value[s.id]; }
    function isPersonalScene(s: ExplorerScene) {
        return Boolean(usageFor(s) || favs.value.has(s.id) || uxIsFav(s, profile.value));
    }
    function relativeUsedAt(timestamp: number) {
        const days = Math.max(0, Math.floor((Date.now() - timestamp) / 86400000));
        return days === 0 ? '今天' : days === 1 ? '昨天' : days < 30 ? `${days} 天前` : '较早';
    }
    const themeCounts = computed<Record<string, number>>(() => Object.fromEntries(THEME_DEFS.map(({ id }) => [id,
        scenes.value.filter(s => (showMature.value || !s.mature) && !hiddenIds.value.has(s.id) && matchesTheme(s, id)).length])));
    function themeCount(id: string) { return themeCounts.value[id] || 0; }
    const searching = computed(() => !!debouncedQuery.value.trim());
    const searchDocuments = computed(() => searching.value
        ? new Map(scenes.value.map(scene => [scene, prepareSceneSearch(scene, [primaryCategory(scene), timeLabel(scene.timeOfDay)])])) : null);
    // Release normalized strings when clearing a search, including a cached page.
    watch(searching, active => { if (!active) void searchDocuments.value; }, { flush: 'sync' });
    const filtered = computed(() => {
        // 用 debounce 后的值：直接读 searchQuery 会让下面的过滤+排序在每次击键时重跑
        const q = debouncedQuery.value.trim().toLowerCase();
        const analysis = q ? uxAnalyze(q, curation.value) : undefined;
        const documents = searchDocuments.value;
        const collection = fTier.value, hidden = showHidden.value;
        const needsTier = !hidden && ((!q && collection === 'featured') || !['all', 'personal', 'featured', 'core'].includes(collection));
        let r = scenes.value.filter(s => {
            if (hidden ? !hiddenIds.value.has(s.id) : hiddenIds.value.has(s.id))
                return false;
            if (!showMature.value && s.mature)
                return false;
            if (!matchesTheme(s, activeTheme.value))
                return false;
            if (!matchesSeries(s, fSeries.value))
                return false;
            if (fChar.value !== 'all' && s.char !== fChar.value)
                return false;
            if (fSeason.value !== 'all' && s.season !== fSeason.value)
                return false;
            if (!matchesTime(s, fTime.value))
                return false;
            if (fRating.value !== 'all' && (s.rating || (s.mature ? 'R18' : 'All')) !== fRating.value)
                return false;
            if (!hidden) {
                if (!q && collection === 'personal' && !isPersonalScene(s))
                    return false;
                if (!q && collection === 'core' && !isCore(s))
                    return false;
                if (needsTier) {
                    const selected = tier(s);
                    if (collection === 'featured' ? selected !== 'signature' && selected !== 'curated' : selected !== collection) return false;
                }
            }
            if (sortBy.value === 'favorite' && !favs.value.has(s.id) && !uxIsFav(s, profile.value))
                return false;
            return !analysis || uxMatchesSearch(documents!.get(s)!, analysis);
        });
        // 相关度先算一遍存 Map:原先在比较器里每次比较都调 uxSearchScore 两次,
        // 297 条 ≈ 每次重算 4900 次评分,每次还带字符串归一化
        const relevance = new Map<string, number>();
        if (analysis) {
            for (const s of r) {
                relevance.set(s.id, uxSearchScore(documents!.get(s)!, analysis));
            }
        }
        return orderExplorerScenes(r, { mode: sortBy.value, curation: curation.value,
            profile: profile.value, usage: localUsage.value, favorites: favs.value, relevance });
    });
    const paged = computed(() => filtered.value.slice(0, visible.value));
    const searchIntent = computed(() => {
        const q = debouncedQuery.value.trim();
        const analysis = uxAnalyze(q, curation.value);
        return {
            expansion: q && ['personal', 'core', 'featured'].includes(fTier.value) ? '已自动扩展至完整场景库。' : '',
            intents: analysis.intents || [],
            description: q ? '正在搜索标题、故事、情绪、地点和视觉标签。' : '可以直接描述想画的完整句子。',
            personal: profile.value.entries ? ` 已结合本机${profile.value.entries}条创作记录排序。` : ' 还没有创作记录，先画几张，推荐会更懂你。',
        };
    });
    watch([debouncedQuery, activeTheme, fChar, fSeason, fTime, fSeries, fRating, fTier, sortBy, showHidden], () => { visible.value = PAGE_SIZE; });
    function toggleFav(id: string) {
        const next = new Set(favs.value);
        if (next.has(id)) next.delete(id); else next.add(id);
        try {
            localStorage.setItem(FAV_KEY, JSON.stringify([...next]));
            favs.value = next;
        } catch { toast.error('收藏未保存，原有状态已保留，请稍后重试'); }
    }
    function toggleHidden(id: string) {
        const next = new Set(hiddenIds.value);
        if (next.has(id)) next.delete(id); else next.add(id);
        try {
            writeHiddenScenes(next);
            hiddenIds.value = next;
        } catch { toast.error('隐藏设置未保存，原有状态已保留，请稍后重试'); }
    }
    function applyMoodRail(rail: {
        character: string;
        query: string;
    }) {
        resetFilters();
        fTier.value = 'all';
        searchQuery.value = rail.query;
        activeTheme.value = 'all';
        if (rail.character === 'nene' || rail.character === 'natsume')
            manualCompanion.value = rail.character;
        nextTick(() => document.getElementById('sceneSearch')?.focus());
    }
    const browseTarget = computed<SceneBrowseTarget>(() => fChar.value !== 'all'
        ? fChar.value as SceneBrowseTarget
        : debouncedQuery.value.trim() || fTier.value !== 'core' ? 'all' : 'core');
    let preferenceLoad: Promise<PreferenceProfile | null> | undefined;
    async function refreshScenes(target: SceneBrowseTarget): Promise<boolean> {
        const revision = ++loadRevision;
        loading.value = true;
        loadError.value = '';
        // Start independent storage and catalog reads together; reuse preferences
        // across filters, but refresh them on an explicit reload or new page visit.
        preferenceLoad ??= artworkRepository.readPreferenceHistory().then(buildPreferenceProfile).catch(() => null);
        try {
            const [catalog, nextProfile] = await Promise.all([sceneStore.loadBrowserScenes(target), preferenceLoad]);
            if (revision !== loadRevision) return false;
            scenes.value = catalog.scenes as ExplorerScene[];
            curation.value = catalog.curation as ExplorerCuration;
            if (nextProfile) profile.value = nextProfile;
            return true;
        } catch (e) {
            if (revision === loadRevision) loadError.value = e instanceof Error ? e.message : String(e);
            return false;
        } finally {
            if (revision === loadRevision) loading.value = false;
        }
    }
    async function init() {
        const openingRevision = ++loadRevision;
        dataReady = false;
        preferenceLoad = undefined;
        // Flush route-derived filters before enabling the user-intent watcher.
        await nextTick();
        if (openingRevision !== loadRevision) return;
        dataReady = true;
        const published = await refreshScenes(browseTarget.value);
        const revision = loadRevision;
        const focusId = typeof route.query.scene === 'string' ? route.query.scene : null;
        if (published && focusId) {
            await nextTick();
            if (!dataReady || revision !== loadRevision) return;
            const el = document.querySelector(`[data-scene-id="${focusId}"]`) as HTMLElement;
            if (el) {
                el.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
                flashId.value = focusId;
                clearTimeout(flashTimer);
                flashTimer = setTimeout(() => flashId.value = '', 2000);
            }
        }
    }
    // Query changes only fetch when crossing core/full coverage, never per key.
    watch(browseTarget, target => { if (dataReady) void refreshScenes(target); });
    onMounted(() => { init(); });
    return {
        ...filters,
        companionId, scenes, manualCompanion, moodRails, applyMoodRail,
        visible, filtered, tierLabel, usedCount, favoriteCount, hiddenCount, availableCount,
        THEME_DEFS, themeCount, searchIntent, matureCount, adultEnabled, loading,
        loadError, init, paged, flashId, usageFor, isCore,
        tier, charName, seasonLabel, timeLabel, personalReason, drawerScene,
        dv: sceneVisualLabels, quickCreateUrl, toggleHidden, hiddenIds, favs, toggleFav,
        PAGE_SIZE,
    };
}

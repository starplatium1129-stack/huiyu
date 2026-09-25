import { useFocusTrap } from '@/composables/useFocusTrap';
import { kvGet,kvInit } from '@/composables/useKVStore';
import { useSceneStore,type CurationData } from '@/stores/sceneStore';
import { scrollBehavior } from '@/utils/motionPreference';
import { quickCreateUrl } from '@/utils/quickCreate';
import { isLocalStudioHost } from '@/utils/runtimeEnvironment';
import { buildPreferenceProfile,isPersonaCore,readHiddenScenes,readSceneUsage,sceneUsageScore,analyzeQuery as uxAnalyze,isPersonalFavorite as uxIsFav,matchesSearch as uxMatchesSearch,personalReason as uxPersonalReason,personalScore as uxPersonalScore,searchScore as uxSearchScore,tier as uxTier,writeHiddenScenes,type PreferenceProfile,type SceneUsageRecord,type SceneUXConfig } from '@/utils/sceneUX';
import { ARTWORK_HISTORY_KV_KEY } from '@/utils/storageKeys';
import { captureScrollAnchor,restoreScrollAnchor,watchForUserScroll,type ScrollAnchor } from '@/utils/scrollAnchor';
import {
    DEFAULT_RAILS,
    THEME_DEFS,
    matchesSeries,
    matchesTheme,
    matchesTime,
    primaryCategory,
    railIconName,
    sceneVisualLabels,
    themeDefinition,
    type ExplorerScene,
} from './sceneExplorerPresentation';
import { watchDebounced } from '@vueuse/core';
import { computed,nextTick,onMounted,onUnmounted,ref,watch } from 'vue';
import type { LocationQueryRaw } from 'vue-router';
import { useRoute,useRouter } from 'vue-router';
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
    const HISTORY_KEY = ARTWORK_HISTORY_KV_KEY;
    const route = useRoute();
    const router = useRouter();
    const sceneStore = useSceneStore();
    const scenes = ref<ExplorerScene[]>([]);
    const curation = ref<ExplorerCuration>({ curatedSceneIds: [], moodRails: [], signatureSceneIds: [], reviewSceneIds: [] });
    const profile = ref<PreferenceProfile>(buildPreferenceProfile([]));
    const loading = ref(true);
    const loadError = ref('');
    const flashId = ref('');
    const drawerScene = ref<ExplorerScene | null>(null);
    const drawerEl = ref<HTMLElement | null>(null);
    useFocusTrap(drawerEl, () => drawerScene.value !== null, { onEscape: () => { drawerScene.value = null; } });
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
    const showHidden = ref(false);
    const adultEnabled = isLocalStudioHost();
    const showMature = ref(adultEnabled);
    const searchQuery = ref('');
    /** 首帧数据就绪标记：避免初始化时赋初值触发数据 watch 重复加载 */
    let dataReady = false;
    /**
     * 输入框绑 searchQuery（打字要立刻回显），过滤/排序读 debouncedQuery。
     * 全 src/ 之前没有任何 debounce，297 条的过滤+排序每次击键都全量重跑。
     * VueUse watchDebounced 替代手写 timer；清空立刻生效（debounceFilter 首个参数）。
     */
    const debouncedQuery = ref('');
    watchDebounced(searchQuery, (value) => {
        debouncedQuery.value = value;
    }, { debounce: 150, maxWait: 0, immediate: true });
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
    onUnmounted(clearFilterAnchor);
    /**
     * 搜索词进 URL（2026-08-30 UX 审计 P2）：刷新或从别处返回时不至于白搜一次。
     *
     * 只同步这一个筛选：character / scene 是别的页面带进来的深链参数，本页的主题
     * 与分组筛选若一并写进 query，会和它们互相覆盖。分页是「加载更多」式而非页码，
     * 返回时点几下即可，不值得给它占一个参数位。
     */
    const queryTerm = typeof route.query.q === 'string' ? route.query.q : '';
    if (queryTerm)
        searchQuery.value = queryTerm;
    // 防抖由上面的 watchDebounced 承担（150ms）；这里只在值真变了才改地址，
    // 否则初次从 URL 恢复会多出一次无意义的导航
    watch(debouncedQuery, (value) => {
        const next = value.trim();
        const current = typeof route.query.q === 'string' ? route.query.q : '';
        if (next === current)
            return;
        const query: LocationQueryRaw = { ...route.query };
        if (next)
            query.q = next;
        else
            delete query.q;
        void router.replace({ query }).catch(() => { });
    });
    const activeTheme = ref('all');
    const activeThemeDefinition = computed(() => themeDefinition(activeTheme.value));
    const activeThemeLabel = computed(() => activeThemeDefinition.value.label);
    const manualCompanion = ref<'nene' | 'natsume' | null>(null);
    const companionId = computed<'nene' | 'natsume'>(() => {
        if (fChar.value === 'natsume')
            return 'natsume';
        if (fChar.value === 'nene')
            return 'nene';
        const q = searchQuery.value.toLowerCase();
        if (q.includes('natsume') || q.includes('夏目'))
            return 'natsume';
        if (q.includes('nene') || q.includes('宁宁'))
            return 'nene';
        return manualCompanion.value || 'nene';
    });
    const fChar = ref('all');
    const fSeason = ref('all');
    const fTime = ref('all');
    const fSeries = ref('all');
    const fRating = ref('all');
    const defaultTier = Object.keys(localUsage.value).length || favs.value.size ? 'personal' : 'core';
    const fTier = ref(defaultTier);
    const sortBy = ref('smart');
    const visible = ref(PAGE_SIZE);
    const filtersOpen = ref(false);
    /** 已生效的精细筛选数量，收起时也能看出「有筛选在起作用」 */
    const activeFacetCount = computed(() => {
        let n = 0;
        if (fChar.value !== 'all')
            n++;
        if (fSeason.value !== 'all')
            n++;
        if (fTime.value !== 'all')
            n++;
        if (fSeries.value !== 'all')
            n++;
        if (fRating.value !== 'all')
            n++;
        if (fTier.value !== defaultTier)
            n++;
        if (sortBy.value !== 'smart')
            n++;
        if (showHidden.value)
            n++;
        return n;
    });
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
        return ({ personal: '我的常用', core: '人设核心', featured: '精选', signature: '招牌', curated: '精选', all: '全库' } as Record<string, string>)[fTier.value] || '场景';
    });
    function tier(s: ExplorerScene) { return uxTier(s, curation.value); }
    function isCore(s: ExplorerScene) { return isPersonaCore(s, curation.value); }
    function sigIds(): string[] { return curation.value.signatureSceneIds || []; }
    function curIds(): string[] { return curation.value.curatedSceneIds || []; }
    function coreIds(): string[] { return curation.value.personaCoreSceneIds || curation.value.signatureSceneIds || []; }
    function cScore(s: ExplorerScene) {
        if (coreIds().includes(s.id))
            return 30000 - coreIds().indexOf(s.id);
        if (sigIds().includes(s.id))
            return 20000 - sigIds().indexOf(s.id);
        const f = curIds().indexOf(s.id);
        if (f >= 0)
            return 10000 - f;
        const c = [s.story, s.emotion, s.camera, s.lighting, s.location].filter(Boolean).length;
        return c * 100 + Math.min((s.story || '').length, 500) + (s.rating === 'All' ? 20 : 0);
    }
    function charName(s: ExplorerScene) {
        const c = s.char || '';
        return c === 'nene' || c === 'ayachi_nene' ? '宁宁' : c === 'natsume' || c === 'shiki_natsume' ? '夏目' : c === 'triad' ? '双人' : c;
    }
    function seasonLabel(v?: string) { return ({ 春: '春', 夏: '夏', 秋: '秋', 冬: '冬' } as Record<string, string>)[v || ''] || v || ''; }
    function timeLabel(v?: string) {
        return ({ morning: '清晨', afternoon: '午后', sunset: '黄昏', night: '夜晚', late_night: '深夜', dawn: '黎明', evening: '夜晚', all_day: '全天' } as Record<string, string>)[v || ''] || v || '';
    }
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
    function themeCount(id: string) {
        return scenes.value.filter(s => (showMature.value || !s.mature) && !hiddenIds.value.has(s.id) && matchesTheme(s, id)).length;
    }
    const filtered = computed(() => {
        // 用 debounce 后的值：直接读 searchQuery 会让下面的过滤+排序在每次击键时重跑
        const q = debouncedQuery.value.trim().toLowerCase();
        let r = scenes.value.filter(s => {
            if (showHidden.value ? !hiddenIds.value.has(s.id) : hiddenIds.value.has(s.id))
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
            const t = tier(s);
            if (!showHidden.value) {
                if (!q && fTier.value === 'personal' && !isPersonalScene(s))
                    return false;
                if (!q && fTier.value === 'core' && !isCore(s))
                    return false;
                if (!q && fTier.value === 'featured' && t !== 'signature' && t !== 'curated')
                    return false;
                if (fTier.value !== 'all' && fTier.value !== 'personal' && fTier.value !== 'featured' && fTier.value !== 'core' && t !== fTier.value)
                    return false;
            }
            if (sortBy.value === 'favorite' && !favs.value.has(s.id) && !uxIsFav(s, profile.value))
                return false;
            return !q || uxMatchesSearch(s, q, curation.value, [primaryCategory(s), timeLabel(s.timeOfDay)]);
        });
        // 相关度先算一遍存 Map:原先在比较器里每次比较都调 uxSearchScore 两次,
        // 297 条 ≈ 每次重算 4900 次评分,每次还带字符串归一化
        const relevance = new Map<string, number>();
        if (q) {
            for (const s of r) {
                relevance.set(s.id, uxSearchScore(s, q, curation.value, [primaryCategory(s), timeLabel(s.timeOfDay)]));
            }
        }
        return r.sort((a, b) => {
            if (q) {
                const rel = (relevance.get(b.id) ?? 0) - (relevance.get(a.id) ?? 0);
                if (rel)
                    return rel;
            }
            if (sortBy.value === 'newest')
                return String(b.id).localeCompare(String(a.id), undefined, { numeric: true });
            if (sortBy.value === 'title')
                return String(a.title).localeCompare(String(b.title), 'zh-CN');
            if (sortBy.value === 'used')
                return sceneUsageScore(usageFor(b)) - sceneUsageScore(usageFor(a));
            if (sortBy.value === 'favorite') {
                const favoriteScore = (s: ExplorerScene) => (favs.value.has(s.id) ? 100000 : 0)
                    + uxPersonalScore(s, profile.value) * 500
                    + sceneUsageScore(usageFor(s));
                return favoriteScore(b) - favoriteScore(a);
            }
            if (sortBy.value === 'smart') {
                return (sceneUsageScore(usageFor(b)) * 400 + uxPersonalScore(b, profile.value) * 500 + cScore(b))
                    - (sceneUsageScore(usageFor(a)) * 400 + uxPersonalScore(a, profile.value) * 500 + cScore(a));
            }
            return cScore(b) - cScore(a);
        });
    });
    const paged = computed(() => filtered.value.slice(0, visible.value));
    function escapeHtml(value: unknown): string {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
    const intentHtml = computed(() => {
        const q = debouncedQuery.value.trim();
        const a = uxAnalyze(q, curation.value);
        const exp = q && ['personal', 'core', 'featured'].includes(fTier.value) ? '已自动扩展至完整场景库。' : '';
        // intents 可能包含用户原始输入（alias 未命中时 push normalized），
        // 拼进 v-html 前必须转义，否则搜索结果里直接注入 HTML。
        const understood = a.intents?.length
            ? `已理解为：<strong>${escapeHtml(a.intents.join(' · '))}</strong>。`
            : (q ? '正在搜索标题、故事、情绪、地点和视觉标签。' : '可以直接描述想画的完整句子。');
        const personal = profile.value.entries ? ` 已结合本机${profile.value.entries}条创作记录排序。` : ' 还没有创作记录，先画几张，推荐会更懂你。';
        return exp + understood + personal;
    });
    watch([debouncedQuery, activeTheme, fChar, fSeason, fTime, fSeries, fRating, fTier, sortBy, showHidden], () => { visible.value = PAGE_SIZE; });
    function toggleFav(id: string) {
        if (favs.value.has(id))
            favs.value.delete(id);
        else
            favs.value.add(id);
        favs.value = new Set(favs.value);
        localStorage.setItem(FAV_KEY, JSON.stringify([...favs.value]));
    }
    function toggleHidden(id: string) {
        if (hiddenIds.value.has(id))
            hiddenIds.value.delete(id);
        else
            hiddenIds.value.add(id);
        hiddenIds.value = new Set(hiddenIds.value);
        writeHiddenScenes(hiddenIds.value);
    }
    function showPersonalScenes() {
        showHidden.value = false;
        fTier.value = 'personal';
        sortBy.value = 'used';
        filtersOpen.value = false;
    }
    function showFavoriteScenes() {
        showHidden.value = false;
        fTier.value = 'all';
        sortBy.value = 'favorite';
        filtersOpen.value = false;
    }
    function showHiddenScenes() {
        showHidden.value = true;
        fTier.value = 'all';
        sortBy.value = 'smart';
        filtersOpen.value = false;
    }
    function showAllScenes() {
        showHidden.value = false;
        fTier.value = 'all';
        sortBy.value = 'smart';
        filtersOpen.value = false;
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
    function resetFilters() {
        searchQuery.value = '';
        activeTheme.value = 'all';
        fChar.value = 'all';
        fSeason.value = 'all';
        fTime.value = 'all';
        fSeries.value = 'all';
        fRating.value = 'all';
        fTier.value = defaultTier;
        sortBy.value = 'smart';
        showHidden.value = false;
    }
    async function init() {
        dataReady = false;
        loading.value = true;
        loadError.value = '';
        try {
            // 场景库按需拉取：默认只载入"人设核心"子集（index + shared + core），
            // 切到具体角色时只拉对应分片，切到全库/精选等才拉完整三片。
            const charParam = typeof route.query.character === 'string' ? route.query.character : null;
            if (['nene', 'natsume', 'triad'].includes(charParam || ''))
                fChar.value = charParam!;
            const personalDefault = Object.keys(localUsage.value).length || favs.value.size;
            if (charParam && ['nene', 'natsume', 'triad'].includes(charParam)) {
                await sceneStore.loadCharacter(charParam);
            }
            else if (personalDefault) {
                await sceneStore.load();
            }
            else {
                await sceneStore.ensureCore();
            }
            if (sceneStore.error)
                throw new Error(sceneStore.error);
            scenes.value = sceneStore.scenes as ExplorerScene[];
            curation.value = sceneStore.curation || curation.value;
        }
        catch (e) {
            loadError.value = e instanceof Error ? e.message : String(e);
        }
        try {
            const fallback = () => {
                try {
                    return buildPreferenceProfile(JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'));
                }
                catch {
                    return buildPreferenceProfile([]);
                }
            };
            try {
                await kvInit();
                const h = await kvGet<unknown[]>(HISTORY_KEY);
                profile.value = Array.isArray(h) ? buildPreferenceProfile(h) : fallback();
            }
            catch {
                profile.value = fallback();
            }
        }
        catch { }
        loading.value = false;
        const focusId = typeof route.query.scene === 'string' ? route.query.scene : null;
        dataReady = true;
        if (focusId) {
            await nextTick();
            const el = document.querySelector(`[data-scene-id="${focusId}"]`) as HTMLElement;
            if (el) {
                el.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
                flashId.value = focusId;
                setTimeout(() => flashId.value = '', 2000);
            }
        }
    }
    watch([fChar, fTier], async () => {
        if (!dataReady)
            return;
        loading.value = true;
        try {
            if (fChar.value !== 'all') {
                await sceneStore.ensureCharacter(fChar.value);
            }
            else if (fTier.value === 'core') {
                await sceneStore.ensureCore();
            }
            else {
                await sceneStore.load();
            }
            if (sceneStore.error)
                throw new Error(sceneStore.error);
            scenes.value = sceneStore.scenes as ExplorerScene[];
            curation.value = sceneStore.curation || curation.value;
            loadError.value = '';
        }
        catch (e) {
            loadError.value = e instanceof Error ? e.message : String(e);
        }
        finally {
            loading.value = false;
        }
    });
    onMounted(() => { init(); });
    return {
drawerEl,
        companionId, activeThemeLabel, scenes, manualCompanion, moodRails, applyMoodRail,
        railIconName, searchQuery, visible, filtered, tierLabel, filtersOpen,
        activeFacetCount, fTier, showHidden, showPersonalScenes, usedCount, sortBy,
        showFavoriteScenes, favoriteCount, showHiddenScenes, hiddenCount, showAllScenes, availableCount,
        THEME_DEFS, activeTheme, themeCount, intentHtml, fChar, fSeason,
        fTime, fSeries, fRating, matureCount, adultEnabled, resetFilters, loading,
        loadError, init, paged, flashId, usageFor, isCore,
        tier, charName, seasonLabel, timeLabel, personalReason, drawerScene,
        dv: sceneVisualLabels, quickCreateUrl, toggleHidden, hiddenIds, favs, toggleFav,
        PAGE_SIZE,
    };
}

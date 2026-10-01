import { computed, nextTick, onScopeDispose, ref, watch, type Ref } from 'vue';
import type { LocationQueryRaw, RouteLocationNormalizedLoaded, Router } from 'vue-router';
import { artworkTimestamp, type ArtworkRecord } from '@/types/artwork';
import { dayGroup, searchHaystack } from './galleryHelpers';
import { buildMasonryGroups } from './useMasonryWall';
import type { GalleryProject } from './galleryStorage';
import { artworkTags } from './artworkTags';
import { artworkGenerationConditions, emptyGenerationConditions, GENERATION_FILTER_FIELDS, generationConditionOptions, matchesGenerationConditions, normalizeGalleryFilterSnapshot, normalizeGenerationConditions, type GalleryFilterSnapshot } from './galleryGenerationConditions';
import { artworkCharacterIds, matchesSmartAlbum, UNASSIGNED_CHARACTER_ID } from './galleryAlbumRules';

const generationQueryKeys = { engine: 'gEngine', model: 'gModel', outfit: 'gOutfit', seed: 'gSeed', size: 'gSize', reviewState: 'gState' } as const;

export interface UseGalleryFiltersOptions {
  history: Ref<ArtworkRecord[]>;
  projects: Ref<GalleryProject[]>;
  ratioOf: (item: ArtworkRecord) => number;
  columnCount: Ref<number>;
  route: RouteLocationNormalizedLoaded;
  router: Router;
  onFilterReset?: () => void;
  isViewActive?: () => boolean;
  deferQueryRestore?: () => boolean;
}

/**
 * Manages gallery filtering (favorites, project, search),
 * pagination, day grouping, and URL query synchronization.
 */
export function useGalleryFilters(options: UseGalleryFiltersOptions) {
  const { history, projects, ratioOf, columnCount, route, router, onFilterReset, isViewActive, deferQueryRestore } = options;

  const favoriteOnly = ref(false);
  const projectFilter = ref('');
  const projectUnavailable = computed(() => !!projectFilter.value && !projects.value.some(project => project.id === projectFilter.value));
  const projectOptions = computed(() => [
    { value: '', label: '全部画册' }, ...projects.value.map(project => ({ value: project.id, label: project.smartRule ? `${project.title} · 智能` : project.title })),
    ...(projectUnavailable.value ? [{ value: projectFilter.value, label: `画册未找到 · ${projectFilter.value}` }] : []),
  ]);
  const characterFilter = ref('');
  /** 展墙搜索（2026-08-30 UX 审计 P1）：此前只有「收藏 + 项目」两个控件，
   *  攒到几百张后找某张旧作只能靠翻。 */
  const searchQuery = ref('');
  const tagFilter = ref('');
  const generationConditions = ref(emptyGenerationConditions());
  const generationIndex = computed(() => new Map(history.value.map(item => [item, artworkGenerationConditions(item)])));
  const generationOptions = computed(() => generationConditionOptions(generationIndex.value.values(), generationConditions.value));
  const generationFilterCount = computed(() => GENERATION_FILTER_FIELDS.filter(field => generationConditions.value[field]).length);
  const filterSnapshot = computed<GalleryFilterSnapshot>(() => ({
    favoriteOnly: favoriteOnly.value, projectFilter: projectFilter.value, searchQuery: searchQuery.value.trim(),
    tagFilter: tagFilter.value, characterFilter: characterFilter.value, generation: { ...generationConditions.value },
  }));
  const hasActiveFilters = computed(() => !!(favoriteOnly.value || projectFilter.value || characterFilter.value || searchQuery.value.trim() || tagFilter.value || generationFilterCount.value));
  const tagOptions = computed(() => {
    const counts = new Map<string, number>();
    for (const item of history.value) for (const tag of artworkTags(item)) counts.set(tag, (counts.get(tag) || 0) + 1);
    if (tagFilter.value && !counts.has(tagFilter.value)) counts.set(tagFilter.value, 0);
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value, count]) => ({ value, label: `${value} · ${count}` }));
  });

  /* ---------- 派生数据 ---------- */
  // Sorting and prompt normalization depend on library metadata, not the current
  // query. Keep these separate so each keystroke only scans the prepared rows.
  const sortedHistory = computed(() => history.value
    .map(item => ({ item, timestamp: artworkTimestamp(item) }))
    .sort((a, b) => b.timestamp - a.timestamp)
    .map(entry => entry.item));
  const selectedProject = computed(() => projects.value.find(item => item.id === projectFilter.value));
  const smartRule = computed(() => selectedProject.value?.smartRule);
  const searching = computed(() => searchQuery.value.trim().length > 0 || Boolean(smartRule.value?.search));
  const searchIndex = computed(() => searching.value
    ? new Map(history.value.map(item => [item, searchHaystack(item)])) : null);
  // A cleared search no longer needs normalized prompts or their reactive
  // dependencies. Force lazy computed invalidation to release that memory even
  // when the cached gallery stays mounted. Nonempty keystrokes reuse the index.
  watch(searching, active => { if (!active) void searchIndex.value; }, { flush: 'sync' });
  const projectIds = computed(() => {
    const project = projects.value.find(item => item.id === projectFilter.value);
    return project && !project.smartRule ? new Set(Array.isArray(project.history_ids) ? project.history_ids : []) : null;
  });
  const visible = computed(() => {
    const favorites = favoriteOnly.value, tag = tagFilter.value;
    const ids = projectFilter.value ? projectIds.value : null;
    const terms = searchQuery.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const index = searching.value ? searchIndex.value : null;
    const generation = generationFilterCount.value ? generationIndex.value : null;
    return sortedHistory.value.filter(item => {
      if (projectFilter.value && !selectedProject.value) return false;
      if (smartRule.value && !matchesSmartAlbum(item, smartRule.value, projects.value, index?.get(item))) return false;
      if (characterFilter.value) {
        const ids = artworkCharacterIds(item);
        if (characterFilter.value === UNASSIGNED_CHARACTER_ID ? ids.length > 0 : !ids.includes(characterFilter.value)) return false;
      }
      if (favorites && !item.favorite) return false;
      if (ids && !ids.has(item.id)) return false;
      if (tag && !artworkTags(item).includes(tag)) return false;
      if (generation && !matchesGenerationConditions(generation.get(item)!, generationConditions.value)) return false;
      return !index || terms.every(term => index.get(item)!.includes(term));
    });
  });

  const favoriteCount = computed(() => history.value.filter(i => i.favorite).length);
  const countLabel = computed(() => `${visible.value.length} 幅作品`);

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
      const key = dayGroup(artworkTimestamp(item));
      (buckets[key] = buckets[key] || []).push(item);
    });
    return order.filter(k => buckets[k]?.length).map(k => ({ key: k, items: buckets[k] }));
  });

  const masonryGroups = computed(() => buildMasonryGroups(groups.value, ratioOf, columnCount.value));

  function applyFilterSnapshot(raw: GalleryFilterSnapshot) {
    const snapshot = normalizeGalleryFilterSnapshot(raw);
    favoriteOnly.value = snapshot.favoriteOnly;
    projectFilter.value = snapshot.projectFilter;
    characterFilter.value = snapshot.characterFilter;
    searchQuery.value = snapshot.searchQuery;
    tagFilter.value = snapshot.tagFilter;
    if (GENERATION_FILTER_FIELDS.some(field => generationConditions.value[field] !== snapshot.generation[field]))
      generationConditions.value = snapshot.generation;
  }
  function resetGalleryFilters() {
    applyFilterSnapshot(normalizeGalleryFilterSnapshot(null));
  }
  function clearGenerationConditions() {
    generationConditions.value = emptyGenerationConditions();
  }

  /* ---------- 筛选状态进 URL（2026-08-30 UX 审计 P1）---------- */
  function restoreFiltersFromQuery() {
    if (deferQueryRestore?.()) return;
    const q = route.query;
    applyFilterSnapshot({
      favoriteOnly: q.fav === '1', projectFilter: typeof q.project === 'string' ? q.project : '',
      characterFilter: typeof q.character === 'string' ? q.character : '',
      searchQuery: typeof q.q === 'string' ? q.q : '', tagFilter: typeof q.tag === 'string' ? q.tag : '',
      generation: normalizeGenerationConditions(Object.fromEntries(GENERATION_FILTER_FIELDS.map(field => [field, q[generationQueryKeys[field]]]))),
    });
  }

  let syncTimer: ReturnType<typeof setTimeout> | null = null;

  function syncFiltersToQuery() {
    if (isViewActive && !isViewActive()) return;
    const q = route.query;
    const fav = q.fav === '1';
    const project = typeof q.project === 'string' ? q.project : '';
    const term = typeof q.q === 'string' ? q.q : '';
    const tag = typeof q.tag === 'string' ? q.tag : '';
    const character = typeof q.character === 'string' ? q.character : '';
    if (fav === favoriteOnly.value && project === projectFilter.value && character === characterFilter.value && term === searchQuery.value.trim() && tag === tagFilter.value
      && GENERATION_FILTER_FIELDS.every(field => (q[generationQueryKeys[field]] || '') === generationConditions.value[field])) {
      cleanupFilterSync();
      return;
    }
    if (syncTimer)
      clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncTimer = null;
      if (isViewActive && !isViewActive()) return;
      const query: LocationQueryRaw = { ...route.query };
      for (const field of GENERATION_FILTER_FIELDS) {
        if (generationConditions.value[field]) query[generationQueryKeys[field]] = generationConditions.value[field];
        else delete query[generationQueryKeys[field]];
      }
      if (tagFilter.value) query.tag = tagFilter.value;
      else delete query.tag;
      if (characterFilter.value) query.character = characterFilter.value;
      else delete query.character;
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

  function cleanupFilterSync() {
    if (syncTimer) {
      clearTimeout(syncTimer);
      syncTimer = null;
    }
  }
  onScopeDispose(cleanupFilterSync);

  function loadMoreIfNeeded(sentinelEl: HTMLElement | null) {
    if ((isViewActive && !isViewActive()) || !hasMoreToRender.value) return;
    if (sentinelEl && !sentinelEl.getClientRects().length) return;
    renderLimit.value = Math.min(renderLimit.value + PAGE_SIZE, visible.value.length);
    void nextTick(() => {
      if ((isViewActive && !isViewActive()) || !hasMoreToRender.value || !sentinelEl || !sentinelEl.getClientRects().length) return;
      if (sentinelEl.getBoundingClientRect().top < window.innerHeight + 800)
        loadMoreIfNeeded(sentinelEl);
    });
  }

  // 筛选变化回到第一页，让用户始终从最新作品看起
  watch([favoriteOnly, projectFilter, characterFilter, searchQuery, tagFilter, generationConditions], () => {
    renderLimit.value = PAGE_SIZE;
    onFilterReset?.();
    syncFiltersToQuery();
  }, { deep: true });
  // Back/forward and cleared URL fields replace the complete filter snapshot.
  watch(() => JSON.stringify([route.query.fav, route.query.project, route.query.character, route.query.q, route.query.tag,
    ...GENERATION_FILTER_FIELDS.map(field => route.query[generationQueryKeys[field]])]), restoreFiltersFromQuery);

  return {
    tagFilter, tagOptions, characterFilter,
    generationConditions, generationOptions, generationFilterCount, filterSnapshot, hasActiveFilters, applyFilterSnapshot, clearGenerationConditions, projectOptions, projectUnavailable,
    favoriteOnly,
    projectFilter,
    searchQuery,
    visible,
    favoriteCount,
    countLabel,
    PAGE_SIZE,
    renderLimit,
    pagedVisible,
    hasMoreToRender,
    groups,
    masonryGroups,
    resetGalleryFilters,
    restoreFiltersFromQuery,
    syncFiltersToQuery,
    cleanupFilterSync,
    loadMoreIfNeeded,
  };
}

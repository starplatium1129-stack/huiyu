import { computed, nextTick, ref, watch, type Ref } from 'vue';
import type { LocationQueryRaw, RouteLocationNormalizedLoaded, Router } from 'vue-router';
import { artworkTimestamp, type ArtworkRecord } from '@/types/artwork';
import { dayGroup, searchHaystack } from './galleryHelpers';
import { buildMasonryGroups } from './useMasonryWall';
import type { GalleryProject } from './galleryStorage';
import { artworkTags } from './artworkTags';

export interface UseGalleryFiltersOptions {
  history: Ref<ArtworkRecord[]>;
  projects: Ref<GalleryProject[]>;
  ratioOf: (item: ArtworkRecord) => number;
  columnCount: Ref<number>;
  route: RouteLocationNormalizedLoaded;
  router: Router;
  onFilterReset?: () => void;
  isViewActive?: () => boolean;
}

/**
 * Manages gallery filtering (favorites, project, search),
 * pagination, day grouping, and URL query synchronization.
 */
export function useGalleryFilters(options: UseGalleryFiltersOptions) {
  const { history, projects, ratioOf, columnCount, route, router, onFilterReset, isViewActive } = options;

  const favoriteOnly = ref(false);
  const projectFilter = ref('');
  /** 展墙搜索（2026-08-30 UX 审计 P1）：此前只有「收藏 + 项目」两个控件，
   *  攒到几百张后找某张旧作只能靠翻。 */
  const searchQuery = ref('');
  const tagFilter = ref('');
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
  const searching = computed(() => searchQuery.value.trim().length > 0);
  const searchIndex = computed(() => searching.value
    ? new Map(history.value.map(item => [item, searchHaystack(item)])) : null);
  // A cleared search no longer needs normalized prompts or their reactive
  // dependencies. Force lazy computed invalidation to release that memory even
  // when the cached gallery stays mounted. Nonempty keystrokes reuse the index.
  watch(searching, active => { if (!active) void searchIndex.value; }, { flush: 'sync' });
  const projectIds = computed(() => {
    const project = projects.value.find(item => item.id === projectFilter.value);
    return project ? new Set(Array.isArray(project.history_ids) ? project.history_ids : []) : null;
  });
  const visible = computed(() => {
    const favorites = favoriteOnly.value, tag = tagFilter.value;
    const ids = projectFilter.value ? projectIds.value : null;
    const terms = searchQuery.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const index = terms.length ? searchIndex.value : null;
    return sortedHistory.value.filter(item => {
      if (favorites && !item.favorite) return false;
      if (ids && !ids.has(item.id)) return false;
      if (tag && !artworkTags(item).includes(tag)) return false;
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

  function resetGalleryFilters() {
    favoriteOnly.value = false;
    projectFilter.value = '';
    searchQuery.value = '';
    tagFilter.value = '';
  }

  /* ---------- 筛选状态进 URL（2026-08-30 UX 审计 P1）---------- */
  function restoreFiltersFromQuery() {
    const q = route.query;
    tagFilter.value = typeof q.tag === 'string' ? q.tag : '';
    if (typeof q.fav === 'string')
      favoriteOnly.value = q.fav === '1';
    if (typeof q.project === 'string')
      projectFilter.value = q.project;
    if (typeof q.q === 'string')
      searchQuery.value = q.q;
  }

  let syncTimer: ReturnType<typeof setTimeout> | null = null;

  function syncFiltersToQuery() {
    const q = route.query;
    const fav = q.fav === '1';
    const project = typeof q.project === 'string' ? q.project : '';
    const term = typeof q.q === 'string' ? q.q : '';
    const tag = typeof q.tag === 'string' ? q.tag : '';
    if (fav === favoriteOnly.value && project === projectFilter.value && term === searchQuery.value.trim() && tag === tagFilter.value)
      return;
    if (syncTimer)
      clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncTimer = null;
      const query: LocationQueryRaw = { ...route.query };
      if (tagFilter.value) query.tag = tagFilter.value;
      else delete query.tag;
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

  function loadMoreIfNeeded(sentinelEl: HTMLElement | null) {
    if ((isViewActive && !isViewActive()) || !hasMoreToRender.value) return;
    renderLimit.value = Math.min(renderLimit.value + PAGE_SIZE, visible.value.length);
    void nextTick(() => {
      if ((isViewActive && !isViewActive()) || !hasMoreToRender.value || !sentinelEl) return;
      if (sentinelEl.getBoundingClientRect().top < window.innerHeight + 800)
        loadMoreIfNeeded(sentinelEl);
    });
  }

  // 筛选变化回到第一页，让用户始终从最新作品看起
  watch([favoriteOnly, projectFilter, searchQuery, tagFilter], () => {
    renderLimit.value = PAGE_SIZE;
    onFilterReset?.();
    syncFiltersToQuery();
  });

  return {
    tagFilter, tagOptions,
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

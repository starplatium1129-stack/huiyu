import { computed, nextTick, ref, watch, type Ref } from 'vue';
import type { LocationQueryRaw, RouteLocationNormalizedLoaded, Router } from 'vue-router';
import { artworkTimestamp, type ArtworkRecord } from '@/types/artwork';
import { matchesArtwork } from '@/utils/artworkSearch';
import { dayGroup, searchHaystack } from './galleryHelpers';
import { buildMasonryGroups } from './useMasonryWall';
import type { GalleryProject } from './galleryStorage';

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
    return source.sort((a, b) => artworkTimestamp(b) - artworkTimestamp(a));
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
  }

  /* ---------- 筛选状态进 URL（2026-08-30 UX 审计 P1）---------- */
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

  function syncFiltersToQuery() {
    const q = route.query;
    const fav = q.fav === '1';
    const project = typeof q.project === 'string' ? q.project : '';
    const term = typeof q.q === 'string' ? q.q : '';
    if (fav === favoriteOnly.value && project === projectFilter.value && term === searchQuery.value.trim())
      return;
    if (syncTimer)
      clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncTimer = null;
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
  watch([favoriteOnly, projectFilter, searchQuery], () => {
    renderLimit.value = PAGE_SIZE;
    onFilterReset?.();
    syncFiltersToQuery();
  });

  return {
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

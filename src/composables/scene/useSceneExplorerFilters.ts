import { watchDebounced } from '@vueuse/core'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter, type LocationQueryRaw } from 'vue-router'
import { THEME_DEFS, sceneTimeLabel, themeDefinition } from './sceneExplorerPresentation'

// The controls, URL validation and removable chips share one option vocabulary.
export const SCENE_FILTER_OPTIONS = {
  character: [{ value: 'all', label: '全部角色' }, { value: 'nene', label: '宁宁' }, { value: 'natsume', label: '夏目' }, { value: 'triad', label: '双人' }],
  season: [{ value: 'all', label: '全部季节' }, { value: '春', label: '春' }, { value: '夏', label: '夏' }, { value: '秋', label: '秋' }, { value: '冬', label: '冬' }],
  time: [{ value: 'all', label: '全部时段' }, { value: 'morning', label: '清晨' }, { value: 'afternoon', label: '午后' }, { value: 'sunset', label: '黄昏' }, { value: 'night', label: '夜晚与深夜' }, { value: 'dawn', label: '黎明' }],
  series: [{ value: 'all', label: '全部系列' }, { value: 'after', label: 'After Story' }, { value: 'fanwork', label: '同人' }, { value: 'active', label: 'Active Sync' }],
  rating: [{ value: 'all', label: '全部分级' }, { value: 'All', label: '全年龄' }, { value: 'R15', label: 'R15' }, { value: 'R18', label: 'R18' }],
  tier: [{ value: 'personal', label: '我的常用' }, { value: 'core', label: '人设核心' }, { value: 'featured', label: '招牌与精选' }, { value: 'signature', label: '只看招牌' }, { value: 'curated', label: '只看精选' }, { value: 'all', label: '完整库' }],
  sort: [{ value: 'smart', label: '智能推荐' }, { value: 'used', label: '最近常用' }, { value: 'curated', label: '主理人精选' }, { value: 'favorite', label: '我的收藏' }, { value: 'newest', label: '最新加入' }, { value: 'title', label: '名称A-Z' }],
}

/** Owns browsing intent and its URL; catalog reads and personal storage stay in the workspace. */
export function useSceneExplorerFilters(defaultTier: string) {
  const route = useRoute()
  const router = useRouter()
  function routeOption(key: keyof typeof SCENE_FILTER_OPTIONS, fallback = 'all') {
    const value = route.query[key]
    return typeof value === 'string' && SCENE_FILTER_OPTIONS[key].some(option => option.value === value) ? value : fallback
  }
  const routeQuery = () => typeof route.query.q === 'string' ? route.query.q : ''
  const routeFilters = () => ({
    q: routeQuery().trim(), character: routeOption('character'),
    theme: typeof route.query.theme === 'string' && THEME_DEFS.some(theme => theme.id === route.query.theme) ? route.query.theme : 'all',
    season: routeOption('season'), time: routeOption('time'), series: routeOption('series'), rating: routeOption('rating'),
    tier: routeOption('tier', defaultTier), sort: routeOption('sort', 'smart'), hidden: route.query.hidden === '1',
  })
  const opening = routeFilters()
  const searchQuery = ref(routeQuery())
  // Input echoes immediately; catalog filtering debounces ordinary typing only.
  const debouncedQuery = ref(searchQuery.value)
  watchDebounced(searchQuery, value => {
    if (value === searchQuery.value) debouncedQuery.value = value
  }, { debounce: 150, immediate: true })
  const activeTheme = ref(opening.theme)
  const activeThemeLabel = computed(() => themeDefinition(activeTheme.value).label)
  const fChar = ref(opening.character)
  const fSeason = ref(opening.season)
  const fTime = ref(opening.time)
  const fSeries = ref(opening.series)
  const fRating = ref(opening.rating)
  const fTier = ref(opening.tier)
  const sortBy = ref(opening.sort)
  const showHidden = ref(opening.hidden)
  const filtersOpen = ref(false)
  const currentFilters = () => ({ q: searchQuery.value.trim(), character: fChar.value, theme: activeTheme.value,
    season: fSeason.value, time: fTime.value, series: fSeries.value, rating: fRating.value,
    tier: fTier.value, sort: sortBy.value, hidden: showHidden.value })
  let pendingRouteWrite: ReturnType<typeof currentFilters> | null = null
  // Returning from creation and browser navigation restore the same browsing scope.
  watch(routeFilters, filters => {
    if (route.path !== '/scene-explorer') return
    if (pendingRouteWrite && JSON.stringify(pendingRouteWrite) === JSON.stringify(filters)) {
      if (searchQuery.value.trim() === filters.q) debouncedQuery.value = filters.q
      return
    }
    pendingRouteWrite = null
    searchQuery.value = filters.q; debouncedQuery.value = filters.q; fChar.value = filters.character
    activeTheme.value = filters.theme; fSeason.value = filters.season; fTime.value = filters.time
    fSeries.value = filters.series; fRating.value = filters.rating; fTier.value = filters.tier
    sortBy.value = filters.sort; showHidden.value = filters.hidden
  }, { flush: 'sync' })
  watch([debouncedQuery, fChar, activeTheme, fSeason, fTime, fSeries, fRating, fTier, sortBy, showHidden], () => {
    if (route.path !== '/scene-explorer') return
    const next = currentFilters()
    if (JSON.stringify(next) === JSON.stringify(routeFilters())) return
    const query: LocationQueryRaw = { ...route.query }
    for (const key of ['q', 'character', 'theme', 'season', 'time', 'series', 'rating', 'sort'] as const) {
      const value = next[key]
      if (value && value !== 'all' && !(key === 'sort' && value === 'smart')) query[key] = value
      else delete query[key]
    }
    // Creation may change the next visit's default: always persist the chosen tier.
    query.tier = next.tier
    if (next.hidden) query.hidden = '1'; else delete query.hidden
    pendingRouteWrite = next
    void router.replace({ query }).catch(() => {}).finally(() => {
      if (pendingRouteWrite === next) pendingRouteWrite = null
    })
  })
  const facets = [
    { key: 'character', value: fChar, label: (value: string) => SCENE_FILTER_OPTIONS.character.find(option => option.value === value)?.label || value },
    { key: 'season', value: fSeason, label: (value: string) => `${value}季` },
    { key: 'time', value: fTime, label: sceneTimeLabel },
    { key: 'series', value: fSeries, label: (value: string) => SCENE_FILTER_OPTIONS.series.find(option => option.value === value)?.label || value },
    { key: 'rating', value: fRating, label: (value: string) => SCENE_FILTER_OPTIONS.rating.find(option => option.value === value)?.label || value },
  ]
  const activeFilters = computed(() => facets.filter(facet => facet.value.value !== 'all').map(facet => ({
    key: facet.key, label: facet.label(facet.value.value), clear: () => { facet.value.value = 'all' },
  })))
  const activeFacetCount = computed(() => activeFilters.value.length + Number(fTier.value !== defaultTier)
    + Number(sortBy.value !== 'smart') + Number(showHidden.value))

  function selectPersonalView(tier: string, sort = 'smart', hidden = false) {
    showHidden.value = hidden
    fTier.value = tier
    sortBy.value = sort
    filtersOpen.value = false
  }
  function resetFilters() {
    searchQuery.value = ''; activeTheme.value = 'all'; fChar.value = 'all'; fSeason.value = 'all'
    fTime.value = 'all'; fSeries.value = 'all'; fRating.value = 'all'; fTier.value = 'all'
    sortBy.value = 'smart'; showHidden.value = false
  }
  return {
    searchQuery, debouncedQuery, activeTheme, activeThemeLabel, fChar, fSeason, fTime, fSeries, fRating, fTier,
    sortBy, showHidden, filtersOpen, activeFilters, activeFacetCount, resetFilters,
    showPersonalScenes: () => selectPersonalView('personal', 'used'),
    showRecommendedScenes: () => selectPersonalView('core'),
    showFavoriteScenes: () => selectPersonalView('all', 'favorite'),
    showHiddenScenes: () => selectPersonalView('all', 'smart', true),
    showAllScenes: () => selectPersonalView('all'),
  }
}

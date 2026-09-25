import { computed, ref, type ComputedRef, type Ref } from 'vue';
import type { RouteLocationNormalizedLoaded } from 'vue-router';
import type { ArtworkRecord } from '@/types/artwork';

export interface UseGalleryComparisonOptions {
  history: Ref<ArtworkRecord[]>;
  selectedIds: Ref<Set<string | number>>;
  route: RouteLocationNormalizedLoaded;
  current: ComputedRef<ArtworkRecord | null>;
  cardUrls: Record<string, string>;
  thumbUrls: Record<string, string>;
}

/** Owns multi-artwork comparison modal state and parent-child comparison images. */
export function useGalleryComparison(options: UseGalleryComparisonOptions) {
  const { history, selectedIds, route, current, cardUrls, thumbUrls } = options;

  const compareMode = ref(false);
  const compareOpen = ref(false);
  const compareIds = ref<string[]>([]);

  const compareItems = computed(() =>
    history.value.filter(item => compareIds.value.includes(String(item.id)))
  );

  function compareSelected() {
    compareIds.value = [...selectedIds.value].map(String).slice(0, 4);
    compareOpen.value = compareIds.value.length >= 2;
  }

  function compareFromRoute() {
    if (route.path !== '/gallery' || typeof route.query.compare !== 'string')
      return;
    compareIds.value = route.query.compare.split(',').slice(0, 4);
    compareOpen.value = compareItems.value.length >= 2;
  }

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

  return {
    compareMode,
    compareOpen,
    compareIds,
    compareItems,
    compareSelected,
    compareFromRoute,
    parentArtwork,
    parentImageUrl,
    hasComparableImage,
  };
}

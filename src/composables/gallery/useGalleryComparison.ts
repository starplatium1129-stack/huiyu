import { computed, onActivated, onDeactivated, onUnmounted, ref, watch, type ComputedRef, type Ref } from 'vue';
import { artworkRepository } from '@/storage/artworkRepository';
import { sameArtworkMedia } from './artworkMediaIdentity';
import { safeImageUrl } from './galleryHelpers';
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
    if (pId === null || pId === undefined || pId === '')
      return null;
    return history.value.find(h => String(h.id) === String(pId)) || null;
  });

  // A filtered/off-page parent must not depend on having visited its wall card.
  // Own one preview separately: wall LRU eviction must never revoke our Blob URL.
  const parentPreview = ref(''), parentLoading = ref(false);
  let parentObjectUrl = '', version = 0, active = true, disposed = false;
  let parentRead: AbortController | null = null;
  function releaseParent() {
    version++;
    parentRead?.abort(); parentRead = null;
    if (parentObjectUrl) URL.revokeObjectURL(parentObjectUrl);
    parentObjectUrl = ''; parentPreview.value = ''; parentLoading.value = false;
  }
  async function loadParent() {
    releaseParent();
    if (!active || disposed || !current.value || !parentArtwork.value) return;
    const child = { ...current.value }, parent = { ...parentArtwork.value };
    const token = version, controller = new AbortController();
    parentRead = controller;
    const isCurrent = () => active && !disposed && token === version && !controller.signal.aborted
      && sameArtworkMedia(child, current.value ?? undefined) && child.parent_id === current.value?.parent_id
      && sameArtworkMedia(parent, parentArtwork.value ?? undefined);
    const cached = thumbUrls[parent.id];
    if (cached?.startsWith('data:image/')) { parentPreview.value = cached; parentRead = null; return; }
    parentLoading.value = true;
    try {
      if (parent.image_id) {
        // Desktop derives missing thumbnails locally. Legacy web records may
        // lack one, so only that miss/failure needs a separately owned original.
        const thumb = await artworkRepository.getThumbnail(parent.image_id).catch(() => null);
        if (!isCurrent()) return;
        if (thumb?.startsWith('data:image/')) { parentPreview.value = thumb; return; }
        const blob = await artworkRepository.getImage(parent.image_id, controller.signal).catch(() => null);
        if (!isCurrent()) return;
        if (blob) {
          parentObjectUrl = URL.createObjectURL(blob);
          parentPreview.value = parentObjectUrl;
          return;
        }
      }
      if (isCurrent()) parentPreview.value = safeImageUrl(parent.image_url)
        || (parent.image_data?.startsWith('data:image/') ? parent.image_data : '');
    } finally {
      if (isCurrent()) { parentLoading.value = false; parentRead = null; }
    }
  }
  watch(() => {
    const child = current.value, parent = parentArtwork.value;
    return [child?.id, child?.parent_id, child?.image_id, child?.image_url, child?.image_data,
      parent?.id, parent?.image_id, parent?.image_url, parent?.image_data];
  }, (next, previous) => {
    if (!previous || next.some((value, index) => value !== previous[index])) void loadParent();
  }, { immediate: true });
  // current remains set through the viewer leave transition; its final close
  // clears it. Deactivation/unmount must release immediately, including reads.
  onDeactivated(() => { active = false; releaseParent(); });
  onActivated(() => { const returning = !active; active = true; if (returning && current.value) void loadParent(); });
  onUnmounted(() => { disposed = true; releaseParent(); });

  const parentImageUrl = computed(() => {
    if (!parentArtwork.value)
      return '';
    const pId = parentArtwork.value.id;
    return cardUrls[pId] || parentPreview.value || thumbUrls[pId] || '';
  });

  const hasComparableImage = computed(() => {
    if (!current.value)
      return false;
    return Boolean(parentImageUrl.value || (!parentLoading.value && thumbUrls[current.value.id]));
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

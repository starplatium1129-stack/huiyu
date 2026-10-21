import { computed, onActivated, onDeactivated, onUnmounted, ref, shallowRef, watch, type ComputedRef, type Ref } from 'vue';
import { imageMediaSession } from '@/platform/imageMediaSession';
import { onDesktopRuntime } from '@/platform/desktop/runtime';
import { artworkRepository } from '@/storage/artworkRepository';
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl';
import { sameArtworkMedia } from './artworkMediaIdentity';
import { captureGallerySource } from './galleryStorage';
import { safeImageUrl } from './galleryHelpers';
import type { RouteLocationNormalizedLoaded } from 'vue-router';
import type { ArtworkRecord } from '@/types/artwork';

export interface UseGalleryComparisonOptions {
  history: Ref<ArtworkRecord[]>;
  selectedIds: Ref<Set<string | number>>;
  route: RouteLocationNormalizedLoaded;
  current: ComputedRef<ArtworkRecord | null>;
  cardUrls: Readonly<Ref<Readonly<Record<string, string>>>>;
  thumbUrls: Readonly<Ref<Readonly<Record<string, string>>>>;
}

/** Owns multi-artwork comparison modal state and parent-child comparison images. */
export function useGalleryComparison(options: UseGalleryComparisonOptions) {
  const { history, selectedIds, route, current, cardUrls, thumbUrls } = options;

  const compareMode = ref(false);
  const compareOpen = ref(false);
  const compareIds = ref<string[]>([]);

  const linkedRecords = shallowRef<ArtworkRecord[]>([]);
  const linkedParent = shallowRef<ArtworkRecord | null>(null);
  let linkRead: AbortController | null = null, parentLookup: AbortController | null = null;
  const compareItems = computed(() => compareIds.value.flatMap(id => {
    const item = history.value.find(item => String(item.id) === id) || linkedRecords.value.find(item => String(item.id) === id);
    return item ? [item] : [];
  }));

  function compareSelected() {
    compareIds.value = [...selectedIds.value].map(String).slice(0, 4);
    compareOpen.value = compareIds.value.length >= 2;
  }

  async function compareFromRoute() {
    if (route.path !== '/gallery' || typeof route.query.compare !== 'string')
      return;
    linkRead?.abort(); const abort = new AbortController(); linkRead = abort;
    const source = captureGallerySource(), ids = route.query.compare.split(',').slice(0, 4);
    try {
      const records = await Promise.all(ids.map(id => source.repository.readArtwork(id, abort.signal)));
      if (abort.signal.aborted || !source.isCurrent() || route.query.compare !== ids.join(',')) return;
      linkedRecords.value = records.filter((item): item is ArtworkRecord => !!item);
      compareIds.value = ids; compareOpen.value = compareItems.value.length >= 2;
    } catch { if (!abort.signal.aborted) compareOpen.value = false; }
    finally { source.release(); if (linkRead === abort) linkRead = null; }
  }

  const parentArtwork = computed(() => {
    const pId = current.value?.parent_id;
    if (pId === null || pId === undefined || pId === '')
      return null;
    return history.value.find(h => String(h.id) === String(pId)) || (String(linkedParent.value?.id) === String(pId) ? linkedParent.value : null);
  });

  watch(() => current.value?.parent_id, id => {
    parentLookup?.abort(); linkedParent.value = null;
    if (id === undefined || id === null || id === '' || history.value.some(item => String(item.id) === String(id))) return;
    const abort = new AbortController(), source = captureGallerySource(); parentLookup = abort;
    void source.repository.readArtwork(id as string | number, abort.signal).then(item => {
      if (!abort.signal.aborted && source.isCurrent() && current.value?.parent_id === id) linkedParent.value = item;
    }).catch(() => {}).finally(() => { source.release(); if (parentLookup === abort) parentLookup = null; });
  });
  let linkSession = imageMediaSession();
  function invalidateLinks() { if (linkSession !== imageMediaSession()) { linkSession = imageMediaSession(); releaseParent(); releaseLinks(); } }
  const stopRuntime = onDesktopRuntime(invalidateLinks);
  watch(imageMediaSession, invalidateLinks, { flush: 'sync' });
  function releaseLinks() { linkRead?.abort(); parentLookup?.abort(); linkedRecords.value = []; linkedParent.value = null; }
  // A filtered/off-page parent must not depend on having visited its wall card.
  // Own one preview separately: wall LRU eviction must never revoke our Blob URL.
  const parentPreview = ref(''), parentLoading = ref(false), parentError = ref(''), parentOriginal = ref(false);
  let parentObjectUrl = '', version = 0, active = true, disposed = false;
  let parentRead: AbortController | null = null;
  let parentTimer: ReturnType<typeof setTimeout> | undefined;
  let relation: { child: ArtworkRecord; parent: ArtworkRecord } | null = null;
  let readingOriginal = false;
  function releaseParent() {
    version++;
    clearTimeout(parentTimer);
    parentRead?.abort(); parentRead = null;
    if (parentObjectUrl) URL.revokeObjectURL(parentObjectUrl);
    parentObjectUrl = ''; parentPreview.value = ''; parentLoading.value = false; parentError.value = '';
    relation = null; parentOriginal.value = false; readingOriginal = false;
  }
  async function loadParent() {
    const retained = relation && sameArtworkMedia(relation.child, current.value ?? undefined)
      && relation.child.parent_id === current.value?.parent_id
      && sameArtworkMedia(relation.parent, parentArtwork.value ?? undefined);
    if (!retained) releaseParent();
    if (!active || disposed || !current.value || !parentArtwork.value) return;
    const child = { ...current.value }, parent = { ...parentArtwork.value };
    relation = { child, parent };
    // A mode toggle upgrades this pair; it never discards a usable preview or
    // downgrades an owned original. An original already in flight can finish.
    if (parentOriginal.value || (!compareMode.value && parentPreview.value)
      || (parentRead && (!compareMode.value || readingOriginal))) return;
    clearTimeout(parentTimer);
    parentRead?.abort();
    const token = ++version, controller = new AbortController();
    parentRead = controller; readingOriginal = compareMode.value;
    const isCurrent = () => active && !disposed && token === version && !controller.signal.aborted
      && sameArtworkMedia(child, current.value ?? undefined) && child.parent_id === current.value?.parent_id
      && sameArtworkMedia(parent, parentArtwork.value ?? undefined);
    async function publishOriginal(source: string, owned = false) {
      const image = new Image();
      let candidate = owned ? source : '', settle: ((ready: boolean) => void) | undefined;
      const release = () => {
        image.removeAttribute('src');
        if (candidate) { URL.revokeObjectURL(candidate); candidate = ''; }
      };
      const abort = () => { release(); settle?.(false); };
      try {
        if (!isCurrent()) return false;
        const resolved = resolveRuntimeUrl(source), cors = runtimeResourceCors();
        if (!resolved) return false;
        if (cors) image.crossOrigin = cors;
        image.decoding = 'async';
        const decoded = await new Promise<boolean>(resolve => {
          settle = resolve;
          controller.signal.addEventListener('abort', abort, { once: true });
          image.src = resolved;
          void image.decode().then(() => resolve(image.complete && image.naturalWidth > 0 && image.naturalHeight > 0), () => resolve(false));
        });
        if (!decoded || !isCurrent()) return false;
        if (parentObjectUrl && parentObjectUrl !== source) URL.revokeObjectURL(parentObjectUrl);
        parentObjectUrl = candidate; candidate = '';
        parentPreview.value = source; parentOriginal.value = true;
        return true;
      } catch { return false; }
      finally { controller.signal.removeEventListener('abort', abort); release(); }
    }
    const cached = thumbUrls.value[parent.id];
    if (!compareMode.value && cached?.startsWith('data:image/')) { parentPreview.value = cached; parentRead = null; return; }
    parentLoading.value = true; parentError.value = '';
    const timer = setTimeout(() => {
      if (!isCurrent()) return;
      parentError.value = '修改前原图读取超时。';
      controller.abort(); parentRead = null; parentLoading.value = false; readingOriginal = false;
    }, 35_000);
    parentTimer = timer;
    try {
      if (parent.image_id) {
        // Desktop derives missing thumbnails locally. Legacy web records may
        // lack one, so only that miss/failure needs a separately owned original.
        const thumb = readingOriginal ? null : await artworkRepository.getThumbnail(parent.image_id).catch(() => null);
        if (!isCurrent()) return;
        if (thumb?.startsWith('data:image/')) { parentPreview.value = thumb; return; }
        readingOriginal = true;
        const blob = await artworkRepository.getImage(parent.image_id, controller.signal).catch(() => null);
        if (!isCurrent()) return;
        // Keep the proven preview until these exact original bytes are paintable.
        if (blob?.size && await publishOriginal(URL.createObjectURL(blob), true)) return;
      }
      // A failed original read must not replace a proven preview with an
      // unverified fallback. Records without stored originals still use theirs.
      if (isCurrent() && (!parentPreview.value || !parent.image_id)) {
        const source = parent._gallerySummary ? await artworkRepository.readArtwork(parent.id, controller.signal) : parent;
        if (!isCurrent()) return;
        const fallback = safeImageUrl(source?.image_url) || (source?.image_data?.startsWith('data:image/') ? source.image_data : '');
        if (fallback) await publishOriginal(fallback);
      }
    } catch {
      if (isCurrent()) parentError.value = '修改前原图暂时无法读取。';
    } finally {
      clearTimeout(timer);
      if (isCurrent()) {
        if (readingOriginal && !parentOriginal.value && !parentError.value) parentError.value = '修改前原图暂时无法读取。';
        parentLoading.value = false; parentRead = null; readingOriginal = false;
      }
    }
  }
  watch(() => {
    const child = current.value, parent = parentArtwork.value;
    return [child?.id, child?.parent_id, child?.image_id, child?.image_url, child?.image_data,
      parent?.id, parent?.image_id, parent?.image_url, parent?.image_data];
  }, (next, previous) => {
    if (!previous || next.some((value, index) => value !== previous[index])) void loadParent();
  }, { immediate: true });
  // Wall images are display-sized previews now. Original comparison owns its
  // own source, so zoom/detail never depends on the wall's resolution or LRU.
  watch(compareMode, () => { void loadParent(); });
  // current remains set through the viewer leave transition; its final close
  // clears it. Deactivation/unmount must release immediately, including reads.
  onDeactivated(() => { active = false; releaseParent(); releaseLinks(); });
  onActivated(() => { const returning = !active; active = true; if (returning && current.value) void loadParent(); });
  onUnmounted(() => { disposed = true; stopRuntime(); releaseParent(); releaseLinks(); });

  const parentImageUrl = computed(() => {
    if (!parentArtwork.value)
      return '';
    const pId = parentArtwork.value.id;
    return (compareMode.value ? parentPreview.value || cardUrls.value[pId] : cardUrls.value[pId] || parentPreview.value) || thumbUrls.value[pId] || '';
  });

  const hasComparableImage = computed(() => {
    if (!current.value)
      return false;
    return Boolean(parentArtwork.value || parentImageUrl.value || thumbUrls.value[current.value.id]);
  });
  const parentImageLabel = computed(() => parentOriginal.value ? '修改前原图' : parentImageUrl.value ? '修改前预览' : '缩略图预览');
  const parentImageStatus = computed(() => ({
    failed: Boolean(parentError.value),
    message: parentLoading.value ? `正在读取修改前原图${parentImageUrl.value ? '，当前保留预览' : ''}…`
      : parentError.value ? `${parentError.value}${parentImageUrl.value ? '当前显示预览，可重新读取原图。' : '可重新读取修改前原图。'}` : '',
  }));
  async function retryParentImage() { if (!parentLoading.value) await loadParent(); }

  return {
    compareMode,
    compareOpen,
    compareItems,
    compareSelected,
    compareFromRoute,
    parentImageUrl,
    parentImageLabel, parentImageStatus, retryParentImage,
    hasComparableImage,
  };
}

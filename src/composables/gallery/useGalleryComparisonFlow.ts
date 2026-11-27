import { computed, ref, watch, type ComputedRef, type Ref } from 'vue';
import type { RouteLocationNormalizedLoaded, Router } from 'vue-router';
import { onDesktopRuntime } from '@/platform/desktop/runtime';
import { imageMediaSession } from '@/platform/imageMediaSession';
import { runtimeResourceIdentity } from '@/platform/runtimeUrl';
import { artworkRepository } from '@/storage/artworkRepository';
import type { ArtworkRecord } from '@/types/artwork';
import { useGalleryComparison } from './useGalleryComparison';

export interface UseGalleryComparisonFlowOptions {
  history: Ref<ArtworkRecord[]>;
  selectedIds: Ref<Set<string | number>>;
  route: RouteLocationNormalizedLoaded;
  router: Router;
  current: ComputedRef<ArtworkRecord | null>;
  cardUrls: ReadonlyMap<string, string>;
  thumbUrls: ReadonlyMap<string, string>;
  galleryLoading: Readonly<Ref<boolean>>;
  galleryIndexLoading: Readonly<Ref<boolean>>;
  galleryError: Readonly<Ref<string>>;
  isViewActive: () => boolean;
  isUnmounted: () => boolean;
  loadGalleryStorage: () => Promise<void>;
}

/** Coordinates gallery comparison modal state, route query synchronization, and optimistic write safety. */
export function useGalleryComparisonFlow(options: UseGalleryComparisonFlowOptions) {
  const {
    history,
    selectedIds,
    route,
    router,
    current,
    cardUrls,
    thumbUrls,
    galleryLoading,
    galleryIndexLoading,
    galleryError,
    isViewActive,
    isUnmounted,
    loadGalleryStorage,
  } = options;

  const {
    compareMode,
    compareOpen,
    compareItems,
    compareSelected: openSelectedComparison,
    compareFromRoute: openRouteComparison,
    refreshComparisonRecords,
    comparisonReading,
    parentImageUrl,
    parentImageLabel,
    parentImageStatus,
    retryParentImage,
    hasComparableImage,
    setComparisonMediaSuspended,
  } = useGalleryComparison({
    history,
    selectedIds,
    route,
    current,
    cardUrls,
    thumbUrls,
  });

  const requestedComparison = computed(() => (route.path === '/gallery' && typeof route.query.compare === 'string' ? route.query.compare : ''));
  let comparisonOwner = '';
  let dismissedComparison = '';
  let comparisonRevision = 0;

  function compareSelected() {
    comparisonRevision++;
    comparisonOwner = '';
    dismissedComparison = requestedComparison.value;
    openSelectedComparison();
  }

  function closeComparison() {
    if (!compareOpen.value) return;
    retireComparisonIntent();
  }

  function retireComparisonIntent() {
    const owner = comparisonOwner;
    comparisonRevision++;
    comparisonOwner = '';
    compareOpen.value = false;
    // Retire a route intent even while its refresh or lazy panel is pending.
    dismissedComparison = requestedComparison.value || owner;
    if (!owner || isUnmounted() || !isViewActive() || requestedComparison.value !== owner) return;
    const query = { ...route.query };
    delete query.compare;
    void router.replace({ query, hash: route.hash });
  }

  async function refreshComparison() {
    const request = requestedComparison.value;
    const revision = ++comparisonRevision;
    await loadGalleryStorage();
    if (
      isUnmounted()
      || !isViewActive()
      || revision !== comparisonRevision
      || !request
      || request !== requestedComparison.value
      || request === dismissedComparison
    ) return;
    await openRouteComparison();
    if (isUnmounted() || !isViewActive() || revision !== comparisonRevision) return;
    comparisonOwner = compareOpen.value ? request : '';
  }

  let comparisonSession = imageMediaSession();
  let comparisonRepository = artworkRepository;
  let comparisonSourceRevision = 0;
  let comparisonWriteRevision = 0;
  const comparisonMarkPending = ref(false);
  const comparisonNeedsRead = ref(false);
  const comparisonMarkOutcome = ref<'saved' | 'unconfirmed' | ''>('');
  const comparisonMarksReading = computed(() => galleryLoading.value || galleryIndexLoading.value || comparisonReading.value);

  function comparisonMetadataReady() {
    return !isUnmounted() && isViewActive() && !comparisonMarkPending.value && !comparisonNeedsRead.value
      && !comparisonMarksReading.value && !galleryError.value;
  }

  function canMarkComparison() {
    return compareOpen.value && comparisonMetadataReady();
  }

  const comparisonMarksMessage = computed(() => {
    if (comparisonMarkPending.value) return '';
    if (comparisonMetadataReady()) return comparisonMarkOutcome.value === 'unconfirmed' ? '已重新读取作品册，请核对当前标记；此前操作未全部确认。' : '';
    if (comparisonMarkOutcome.value === 'saved') return '标记已保存，但作品信息尚未重新读取。请先重新读取，不要重复保存。';
    if (comparisonMarkOutcome.value === 'unconfirmed') return '标记结果未全部确认，请先重新读取作品册后核对，不要重复提交。';
    return '作品信息尚未就绪，请重新读取后再标记。';
  });

  async function retryComparisonMarks() {
    if (!isUnmounted() && isViewActive() && compareOpen.value && !comparisonMarkPending.value && !comparisonMarksReading.value) {
      await loadGalleryStorage();
    }
  }

  async function saveComparisonMarks(write: () => Promise<void>) {
    if (!canMarkComparison()) return;
    const sourceRevision = comparisonSourceRevision;
    const source = artworkRepository;
    const session = imageMediaSession();
    const currentSource = () => sourceRevision === comparisonSourceRevision && source === artworkRepository && session === imageMediaSession();
    comparisonMarkPending.value = true;
    comparisonNeedsRead.value = true;
    comparisonMarkOutcome.value = '';
    comparisonWriteRevision++;
    let saved = false;
    try {
      await write();
      saved = true;
    } catch {
      /* Sequential desktop patches may have committed a prefix. Re-read, never replay. */
    } finally {
      comparisonMarkPending.value = false;
      comparisonWriteRevision++;
    }
    // Modal close does not cancel an admitted write or lose its refresh
    // requirement. Source invalidation, however, cannot refresh a new owner.
    if (isUnmounted() || !currentSource()) return;
    comparisonMarkOutcome.value = saved ? 'saved' : 'unconfirmed';
    if (isViewActive()) await loadGalleryStorage();
  }

  function refreshComparisonSession() {
    const next = imageMediaSession();
    if (next === comparisonSession && comparisonRepository === artworkRepository) return;
    comparisonSession = next;
    comparisonRepository = artworkRepository;
    comparisonSourceRevision++;
    comparisonNeedsRead.value = true;
    comparisonMarkOutcome.value = '';
    retireComparisonIntent();
  }

  function captureReadGuard(baseCheck: () => boolean) {
    const write = comparisonWriteRevision;
    const sourceRevision = comparisonSourceRevision;
    const source = artworkRepository;
    const session = imageMediaSession();
    const comparison = comparisonRevision;
    return () =>
      baseCheck()
      && write === comparisonWriteRevision
      && sourceRevision === comparisonSourceRevision
      && source === artworkRepository
      && session === imageMediaSession()
      && comparison === comparisonRevision
      && !comparisonMarkPending.value;
  }

  async function syncComparisonAfterRead(isCurrent: () => boolean) {
    comparisonNeedsRead.value = true;
    if (await refreshComparisonRecords(isCurrent) && isCurrent()) comparisonNeedsRead.value = false;
  }

  const stopComparisonRuntime = onDesktopRuntime(refreshComparisonSession);
  const stopComparisonResources = watch(runtimeResourceIdentity, refreshComparisonSession, { flush: 'sync' });
  // Filter URL sync replaces query too. Watch the two values independently so
  // it cannot reload/remount the wall and detach an open viewer's focus target.
  watch([requestedComparison, () => route.query.batch], ([request], [previous]) => {
    comparisonRevision++;
    if (request !== previous) {
      dismissedComparison = '';
      if (comparisonOwner) {
        comparisonOwner = '';
        compareOpen.value = false;
      }
    }
    if (isViewActive() && route.path === '/gallery') void refreshComparison();
  }, { flush: 'sync' });

  function bumpComparisonRevision() {
    comparisonRevision++;
  }

  function stopComparisonFlow() {
    stopComparisonRuntime();
    stopComparisonResources();
  }

  return {
    compareMode,
    compareOpen,
    compareItems,
    parentImageUrl,
    parentImageLabel,
    parentImageStatus,
    retryParentImage,
    hasComparableImage,
    setComparisonMediaSuspended,
    requestedComparison,
    compareSelected,
    closeComparison,
    retireComparisonIntent,
    refreshComparison,
    canMarkComparison,
    comparisonMarksMessage,
    comparisonMarksReading,
    comparisonMarkPending,
    retryComparisonMarks,
    saveComparisonMarks,
    captureReadGuard,
    syncComparisonAfterRead,
    bumpComparisonRevision,
    stopComparisonFlow,
  };
}

import { computed, ref, type ComputedRef } from 'vue';
import type { ArtworkRecord } from '@/types/artwork';

/** Owns multi-select state and batch selection helpers on the gallery wall. */
export function useGallerySelection(visible: ComputedRef<ArtworkRecord[]>) {
  const selectMode = ref(false);
  const selectedIds = ref(new Set<string | number>());

  function toggleSelectMode() {
    selectMode.value = !selectMode.value;
    if (!selectMode.value)
      selectedIds.value = new Set();
  }

  function toggleSelect(id: string | number) {
    const next = new Set(selectedIds.value);
    if (next.has(id))
      next.delete(id);
    else
      next.add(id);
    selectedIds.value = next;
  }

  const allVisibleSelected = computed(() =>
    visible.value.length > 0 && visible.value.every(item => selectedIds.value.has(item.id))
  );

  function selectAllVisible() {
    if (allVisibleSelected.value) {
      selectedIds.value = new Set();
      return;
    }
    selectedIds.value = new Set(visible.value.map(item => item.id));
  }

  function clearSelection() {
    selectedIds.value = new Set();
  }

  return {
    selectMode,
    selectedIds,
    toggleSelectMode,
    toggleSelect,
    allVisibleSelected,
    selectAllVisible,
    clearSelection,
  };
}

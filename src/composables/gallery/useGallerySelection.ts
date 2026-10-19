import { computed, ref, type ComputedRef } from 'vue';
import type { ArtworkRecord } from '@/types/artwork';

/** Owns multi-select state and batch selection helpers on the gallery wall. */
export function useGallerySelection(visible: ComputedRef<ArtworkRecord[]>) {
  const selectMode = ref(false);
  const selectedIds = ref(new Set<string | number>());
  let anchor: string | number | null = null;

  function toggleSelectMode() {
    selectMode.value = !selectMode.value;
    if (!selectMode.value) clearSelection();
  }

  function toggleSelect(id: string | number, extend = false) {
    const checked = !selectedIds.value.has(id);
    const start = visible.value.findIndex(item => item.id === anchor);
    const end = visible.value.findIndex(item => item.id === id);
    const range = extend && start >= 0 && end >= 0
      ? visible.value.slice(Math.min(start, end), Math.max(start, end) + 1).map(item => item.id) : [id];
    for (const key of range) {
      if (checked) selectedIds.value.add(key);
      else selectedIds.value.delete(key);
    }
    if (!extend || start < 0) anchor = id;
  }

  const allVisibleSelected = computed(() =>
    visible.value.length > 0 && visible.value.every(item => selectedIds.value.has(item.id))
  );

  function selectAllVisible() {
    anchor = null;
    if (allVisibleSelected.value) {
      selectedIds.value = new Set();
      return;
    }
    selectedIds.value = new Set(visible.value.map(item => item.id));
  }

  function clearSelection() {
    anchor = null;
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
